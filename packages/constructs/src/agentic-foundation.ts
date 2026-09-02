/**
 * AgenticFoundation — the top-level composition.
 *
 * From a workload name + harness configs, provisions with secure defaults:
 * KMS key, single-table DynamoDB store, encrypted artifact bucket, the
 * harness agents, the plan-interpreter workflow, the fixed scheduling
 * infrastructure, and the observability pack. Every resource is tagged for
 * cost attribution.
 *
 * Deliberately NOT provisioned here: a Gateway (workloads reference an
 * existing gateway ARN in their harness configs, or create one alongside —
 * see examples/marketing-workflow), and nothing is ever created at runtime except
 * EventBridge schedules.
 */
import { CfnOutput, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { CatalogModel, HarnessConfigInput } from '@agentic-platform/plan-schema';
import { AgenticWorkflow } from './agentic-workflow';
import { HarnessAgent } from './harness-agent';
import { MemoryJanitor } from './memory-janitor';
import { ObservabilityPack } from './observability';
import { WorkflowScheduler } from './workflow-scheduler';

export interface AgenticFoundationProps {
  /** Workload name (lowercase, hyphenated): tag value + dashboard prefix. */
  readonly workloadName: string;
  /** Harness configs to provision as workers (keyed by config.name). */
  readonly agents?: HarnessConfigInput[];
  /** Additional workers registered by ARN (e.g. shared/external harnesses). */
  readonly externalWorkers?: Record<string, string>;
  /** Fallback model id for agents whose config omits one. */
  readonly defaultModelId?: string;
  /**
   * Bedrock models the planner may assign per task by complexity via
   * `modelOverride`. Omit to disable per-task model selection.
   */
  readonly modelCatalog?: CatalogModel[];
  /** Parallel task fan-out within a wave. Default: 5. */
  readonly maxConcurrency?: number;
  /** Data retention posture. Default: RETAIN (production-safe). */
  readonly removalPolicy?: RemovalPolicy;
  /** invokeHarness service resource override (documented integration seam). */
  readonly invokeHarnessServiceResource?: string;
  /**
   * Origins allowed to fetch artifacts via presigned URLs (bucket CORS,
   * GET-only). Default: CloudFront distributions. Override when the web
   * app is served from a custom domain.
   */
  readonly artifactsCorsOrigins?: string[];
  /**
   * Email address subscribed to the workload alarm topic (run failures,
   * scheduler DLQ). Omit to create the topic without a subscription —
   * subscribe later via the AlarmTopicArn output.
   */
  readonly alarmEmail?: string;
}

export class AgenticFoundation extends Construct {
  public readonly encryptionKey: kms.Key;
  public readonly table: dynamodb.Table;
  public readonly artifactsBucket: s3.Bucket;
  public readonly agents: Record<string, HarnessAgent> = {};
  public readonly workflow: AgenticWorkflow;
  public readonly scheduler: WorkflowScheduler;
  public readonly observability: ObservabilityPack;

  constructor(scope: Construct, id: string, props: AgenticFoundationProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;

    // One CMK per workload, rotation on.
    this.encryptionKey = new kms.Key(this, 'Key', {
      enableKeyRotation: true,
      description: `Workload key: ${props.workloadName}`,
      removalPolicy,
    });

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });
    // Catalog listing index (workflow list).
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });

    this.artifactsBucket = new s3.Bucket(this, 'Artifacts', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      // DESTROY alone cannot delete a non-empty (and versioned) bucket —
      // teardown would end in DELETE_FAILED. Auto-empty it when the
      // workload opts into destroy-on-remove.
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      // Browsers fetch artifacts via presigned URLs cross-origin; without
      // bucket CORS the browser blocks the response even though the signed
      // GET itself is authorized (live-verified, docs/decisions.md D-17).
      // GET-only; authorization comes from the presigned signature. Origins
      // default to CloudFront distributions (SEC-M1 — defense in depth over
      // '*'); workloads on custom domains override via artifactsCorsOrigins.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: props.artifactsCorsOrigins ?? [
            'https://*.cloudfront.net',
          ],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      // Keep versioning for recovery without unbounded growth (WA review):
      // expire noncurrent artifact versions; reap abandoned multipart parts.
      lifecycleRules: [
        {
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    const workers: Record<string, HarnessAgent | string> = {
      ...(props.externalWorkers ?? {}),
    };
    // Harness managed memories delete ASYNCHRONOUSLY under fixed names, so
    // destroy → redeploy (or rollback → retry) collides with "Memory with
    // name <x> already exists". The janitor sits between: harnesses depend
    // on it, so on create it waits out leftover DELETING memories first,
    // and on delete it holds the stack open until the memories are gone.
    const agentConfigs = props.agents ?? [];
    const memoryJanitor =
      agentConfigs.length > 0
        ? new MemoryJanitor(this, 'MemoryJanitor', {
            agentNames: agentConfigs.map((config) => config.name),
          })
        : undefined;
    for (const config of agentConfigs) {
      const agent = new HarnessAgent(this, `Agent-${config.name}`, {
        config,
        ...(props.defaultModelId ? { defaultModelId: props.defaultModelId } : {}),
      });
      if (memoryJanitor) {
        agent.node.addDependency(memoryJanitor.resource);
      }
      this.agents[agent.harnessName] = agent;
      workers[agent.harnessName] = agent;
    }

    // Convention: an agent named 'planner' is wired as the replan planner
    // and excluded from the worker registry (it plans, it doesn't
    // execute tasks).
    const planner = this.agents['planner'];
    if (planner) {
      delete workers['planner'];
    }

    this.workflow = new AgenticWorkflow(this, 'Workflow', {
      table: this.table,
      artifactsBucket: this.artifactsBucket,
      workers,
      ...(planner ? { planner } : {}),
      ...(props.modelCatalog ? { modelCatalog: props.modelCatalog } : {}),
      ...(props.maxConcurrency !== undefined
        ? { maxConcurrency: props.maxConcurrency }
        : {}),
      ...(props.invokeHarnessServiceResource
        ? { invokeHarnessServiceResource: props.invokeHarnessServiceResource }
        : {}),
    });

    this.seedAgentConfigs();
    this.seedWorkerCatalog();

    this.scheduler = new WorkflowScheduler(this, 'Scheduler', {
      stateMachine: this.workflow.stateMachine,
    });

    this.observability = new ObservabilityPack(this, 'Observability', {
      workloadName: props.workloadName,
      stateMachine: this.workflow.stateMachine,
      deadLetterQueue: this.scheduler.deadLetterQueue,
      ...(props.alarmEmail ? { alarmEmail: props.alarmEmail } : {}),
    });
    // Every workload alarm notifies the same topic (WA review: alarms
    // previously fired with no actions).
    this.scheduler.failureAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.observability.alarmTopic),
    );

    // Cost attribution on everything under this construct. Applied as
    // template Tag properties at CREATE time — do not convert these to
    // stack tags or add/remove keys lightly: the Harness CFN handler fails
    // ANY tag-modifying UPDATE with an opaque "Internal Failure" (live
    // finding), so harness tags are effectively immutable post-create.
    Tags.of(this).add('workload', props.workloadName);
    Tags.of(this).add('managed-by', 'agentic-platform');

    new CfnOutput(this, 'StateMachineArn', {
      value: this.workflow.stateMachine.stateMachineArn,
    });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'ArtifactsBucketName', {
      value: this.artifactsBucket.bucketName,
    });
    new CfnOutput(this, 'SchedulerRoleArn', {
      value: this.scheduler.schedulerRole.roleArn,
    });
    new CfnOutput(this, 'AlarmTopicArn', {
      value: this.observability.alarmTopic.topicArn,
    });
  }

  /**
   * Seed each agent's deployed defaults (instructions, model, description)
   * into the CONFIG partition (runtime-configurable prompts, D-19). The API
   * and UI read these to display and edit prompts; the interpreter resolves
   * effective instructions from them — no control-plane calls at runtime.
   *
   * UpdateItem SETs only the default* fields, so an admin's
   * `instructionsOverride` on the same item survives every deploy. The
   * custom resource re-runs only when the baked config changes (its call
   * payload is part of the resource properties).
   */
  /**
   * Seed the derived worker catalog (names + descriptions + tool scopes)
   * into the CONFIG partition. The planner user message and plan validation
   * read it at runtime. It travels via the table rather than Lambda env
   * because rich worker descriptions exceeded the 4KB env limit (live
   * deploy finding); the workload manifest stays the source of truth and
   * every deploy overwrites this item.
   */
  private seedWorkerCatalog(): void {
    const catalogJson = JSON.stringify(this.workflow.workerCatalog);
    new cr.AwsCustomResource(this, 'WorkerCatalogSeed', {
      onUpdate: {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: {
          TableName: this.table.tableName,
          Item: {
            pk: { S: 'CONFIG' },
            sk: { S: 'WORKER_CATALOG' },
            entity: { S: 'WORKER_CATALOG' },
            catalog: { S: catalogJson },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('worker-catalog'),
      },
      // No onDelete: config items are data; table removal policy governs.
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem'],
          resources: [this.table.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [this.encryptionKey.keyArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });
  }

  private seedAgentConfigs(): void {
    for (const agent of Object.values(this.agents)) {
      const expressionNames: Record<string, string> = {
        '#entity': 'entity',
        '#name': 'name',
      };
      const expressionValues: Record<string, unknown> = {
        ':entity': { S: 'AGENT_CONFIG' },
        ':name': { S: agent.harnessName },
        ':instructions': { S: agent.config.instructions },
        ':model': { S: agent.modelId },
      };
      const sets = [
        '#entity = :entity',
        '#name = :name',
        'defaultInstructions = :instructions',
        'defaultModelId = :model',
      ];
      if (agent.config.description) {
        expressionNames['#desc'] = 'description';
        expressionValues[':desc'] = { S: agent.config.description };
        sets.push('#desc = :desc');
      }
      // Seed the deployed output-token cap so per-invocation model overrides
      // (which REPLACE the deployed bedrockModelConfig) can re-apply it.
      // REMOVE when unset so a dropped limit never lingers in the record.
      const maxTokens = agent.config.limits?.maxTokens;
      const removals: string[] = [];
      if (maxTokens !== undefined) {
        expressionValues[':maxTokens'] = { N: String(maxTokens) };
        sets.push('defaultMaxTokens = :maxTokens');
      } else {
        removals.push('defaultMaxTokens');
      }
      // Deployed thinking effort (CFN can't express it; applied at
      // invocation time on the planner path). Same SET/REMOVE discipline.
      const thinkingEffort = agent.config.thinkingEffort;
      if (thinkingEffort !== undefined) {
        expressionValues[':thinkingEffort'] = { S: thinkingEffort };
        sets.push('defaultThinkingEffort = :thinkingEffort');
      } else {
        removals.push('defaultThinkingEffort');
      }
      // Deployed tool surface, for UI display (Settings badges): gateway
      // tool names plus capability markers for the non-gateway tools.
      const toolNames = agent.config.tools.flatMap((tool) =>
        tool.type === 'agentcore_gateway'
          ? (tool.allowedTools ?? ['gateway'])
          : tool.type === 'agentcore_browser'
            ? ['browser']
            : ['code_interpreter'],
      );
      expressionValues[':tools'] = {
        L: toolNames.map((name) => ({ S: name })),
      };
      sets.push('defaultTools = :tools');
      const removeClause =
        removals.length > 0 ? ` REMOVE ${removals.join(', ')}` : '';
      new cr.AwsCustomResource(this, `AgentConfigSeed-${agent.harnessName}`, {
        onUpdate: {
          service: 'DynamoDB',
          action: 'updateItem',
          parameters: {
            TableName: this.table.tableName,
            Key: {
              pk: { S: 'CONFIG' },
              sk: { S: `AGENT#${agent.harnessName}` },
            },
            UpdateExpression: `SET ${sets.join(', ')}${removeClause}`,
            ExpressionAttributeNames: expressionNames,
            ExpressionAttributeValues: expressionValues,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `agent-config-${agent.harnessName}`,
          ),
        },
        // No onDelete: config items are data; table removal policy governs.
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:UpdateItem'],
            resources: [this.table.tableArn],
          }),
          // Table uses a customer-managed key; the singleton CR Lambda's
          // data-plane writes need it (grantWriteData equivalent).
          new iam.PolicyStatement({
            actions: [
              'kms:Decrypt',
              'kms:GenerateDataKey*',
              'kms:DescribeKey',
            ],
            resources: [this.encryptionKey.keyArn],
          }),
        ]),
        installLatestAwsSdk: false,
      });
    }
  }
}
