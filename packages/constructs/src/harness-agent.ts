/**
 * HarnessAgent — the missing Harness L2.
 *
 * Wraps the stable `CfnHarness` L1 with the typed, zod-validated
 * HarnessConfig schema shared with the AgentCore CLI inner loop:
 * a config iterated in `agentcore dev` transfers here without translation.
 *
 * Named endpoints: aws-cdk-lib 2.266.0 ships no HarnessEndpoint
 * CloudFormation resource; the service-managed DEFAULT endpoint always
 * exists. DEV/STAGING/PROD endpoint management stays with the AgentCore
 * API/CLI until the CFN resource ships — tracked as a documented seam.
 */
import { ArnFormat, Stack, Tags } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import {
  HarnessConfigSchema,
  type HarnessConfig,
  type HarnessConfigInput,
} from '@agentic-platform/plan-schema';

export interface HarnessAgentProps {
  /** Typed harness configuration; validated at synth time (throws on error). */
  readonly config: HarnessConfigInput;
  /**
   * Execution role the harness assumes. When omitted, a role is created
   * from the config: model invocation plus only the tool families the
   * config declares.
   */
  readonly executionRole?: iam.IRole;
  /**
   * Fallback model id when the config omits one. There is deliberately no
   * baked-in default: inference profiles are region-specific, and silently
   * guessing one would ship the wrong region coupling — the exact mistake
   * this platform is designed to avoid.
   */
  readonly defaultModelId?: string;
  /** Environment variables for the harness runtime environment. */
  readonly environmentVariables?: Record<string, string>;
}

export class HarnessAgent extends Construct {
  /** The validated (defaults-applied) configuration. */
  public readonly config: HarnessConfig;
  public readonly executionRole: iam.IRole;
  public readonly harness: agentcore.CfnHarness;
  public readonly harnessArn: string;
  public readonly harnessName: string;
  /** The resolved model id (config.modelId ?? defaultModelId prop). */
  public readonly modelId: string;

  constructor(scope: Construct, id: string, props: HarnessAgentProps) {
    super(scope, id);

    this.config = HarnessConfigSchema.parse(props.config);

    const modelId = this.config.modelId ?? props.defaultModelId;
    if (!modelId) {
      throw new Error(
        `HarnessAgent "${this.config.name}": no modelId in config and no defaultModelId provided. ` +
          'Confirm the inference profile for your region and pass it explicitly.',
      );
    }

    this.executionRole =
      props.executionRole ?? this.createExecutionRole(this.config);

    this.harness = new agentcore.CfnHarness(this, 'Resource', {
      harnessName: this.config.name,
      executionRoleArn: this.executionRole.roleArn,
      systemPrompt: [{ text: this.config.instructions }],
      model: {
        bedrockModelConfig: {
          modelId,
          ...(this.config.temperature !== undefined
            ? { temperature: this.config.temperature }
            : {}),
          ...(this.config.limits?.maxTokens !== undefined
            ? { maxTokens: this.config.limits.maxTokens }
            : {}),
        },
      },
      ...(this.config.tools.length > 0
        ? { tools: this.renderTools() }
        : {}),
      // Live finding (docs/decisions.md D-24, verified 2026-08-31): the
      // service-side allowedTools filter drops EVERY tool when given any
      // concrete name list — bare names, target-prefixed
      // (<target>___<tool>), wrapper-qualified, and [] all expose zero
      // tools to the model, which then narrates fake tool calls as text.
      // Once set, the field is sticky: it cannot be cleared by omitting it
      // on update. '*' is the only value that both exposes tools and stays
      // update-safe, so tool-bearing agents always emit it. Config-level
      // allowedTools still drive the worker catalog and plan validation
      // (prompt-level scoping); service-side per-tool enforcement can
      // return when the filter's name matching works.
      ...(this.config.tools.length > 0 ? { allowedTools: ['*'] } : {}),
      // Cross-session memory is OPT-IN. When the memory field is omitted,
      // the service defaults managed memory to [SEMANTIC, SUMMARIZATION] —
      // and SEMANTIC extracts actor-scoped facts (/actors/{id}/facts/) that
      // persist across sessions. Live-verified failure mode: the planner's
      // auto-created semantic memory extracted a topic fact from one
      // workflow's session and injected it into every other workflow's
      // planning session. The CFN schema requires ≥1 strategy
      // (empty list fails synth) and `disabled` would drop session
      // conversation state (required for corrective retries, D-13), so
      // non-opted agents get SUMMARIZATION only: its namespace is
      // session-scoped (/actors/{id}/summaries/{sessionId}/) and cannot
      // leak between workflows.
      memory: {
        managedMemoryConfiguration: this.config.memory?.enabled
          ? {
              strategies: this.config.memory.strategies,
              eventExpiryDuration: this.config.memory.eventExpiryDays,
            }
          : { strategies: ['SUMMARIZATION'] },
      },
      ...(this.config.limits?.maxIterations !== undefined
        ? { maxIterations: this.config.limits.maxIterations }
        : {}),
      ...(this.config.limits?.timeoutSeconds !== undefined
        ? { timeoutSeconds: this.config.limits.timeoutSeconds }
        : {}),
      ...(props.environmentVariables
        ? { environmentVariables: props.environmentVariables }
        : {}),
    });

    this.harnessArn = this.harness.attrArn;
    this.harnessName = this.config.name;
    this.modelId = modelId;
  }

  /**
   * Grant harness invocation on the harness and its endpoints.
   *
   * Live-verified (docs/decisions.md D-12): the data plane authorizes
   * InvokeHarness as `bedrock-agentcore:InvokeAgentRuntime` on the harness
   * ARN (harness executes on AgentCore Runtime under the hood), so both
   * actions are granted.
   */
  public grantInvoke(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: [
        'bedrock-agentcore:InvokeHarness',
        'bedrock-agentcore:InvokeAgentRuntime',
      ],
      resourceArns: [this.harnessArn, `${this.harnessArn}/*`],
    });
  }

  private createExecutionRole(config: HarnessConfig): iam.Role {
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: `Execution role for harness ${config.name}`,
    });

    // Per-agent Bedrock cost attribution via IAM-principal tags: the
    // harness invokes Bedrock THROUGH this role, and Bedrock propagates the
    // calling principal's tags into CUR/Cost Explorer as
    // `iamPrincipal/{key}` columns (activate the key as a cost allocation
    // tag of type "IAM principal" in Billing; not retroactive). Combined
    // with the workload tag from the foundation aspect, this splits model
    // spend per agent without application inference profiles.
    Tags.of(role).add('agent', config.name);

    // TEMPORARY WORKAROUND — remove once aws-cdk-lib grants these itself.
    // The aws-bedrockagentcore L2 construct is being fixed upstream to add
    // observability permissions to the execution role it creates. Until that
    // ships, grant them here: AgentCore Runtime writes harness logs to
    // /aws/bedrock-agentcore/runtimes/<harness>-<runtimeId>-<endpoint> and
    // emits traces/metrics THROUGH THE EXECUTION ROLE (matches the service's
    // reference execution-role policy). Without these grants the runtime
    // cannot create its log group — invocations succeed but the CloudWatch
    // console reports "log group does not exist".
    const stack = Stack.of(this);
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeLogGroups',
        actions: ['logs:DescribeLogGroups', 'logs:CreateLogGroup'],
        resources: [
          stack.formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: '/aws/bedrock-agentcore/runtimes/*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeLogStreams',
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
        ],
        resources: [
          stack.formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: '/aws/bedrock-agentcore/runtimes/*:log-stream:*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeTracesAndMetrics',
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' },
        },
      }),
    );

    // Model invocation. Inference profiles fan out across regional model ARNs,
    // so this stays '*' for now; tightening to explicit profile ARNs is a
    // planned fast-follow.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeModels',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }),
    );

    // Harness sessions are stateful BY DEFAULT: the service auto-creates a
    // memory resource named `<harnessName>-<suffix>` and the execution role
    // performs the conversation-state data ops against it. Live-verified:
    // without this, every invocation fails on bedrock-agentcore:ListEvents
    // (docs/decisions.md D-13). Scoped to this harness's memory only.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'HarnessManagedMemory',
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:DeleteEvent',
          'bedrock-agentcore:ListSessions',
          'bedrock-agentcore:ListActors',
          'bedrock-agentcore:RetrieveMemoryRecords',
          'bedrock-agentcore:ListMemoryRecords',
          'bedrock-agentcore:GetMemoryRecord',
          'bedrock-agentcore:GetMemory',
        ],
        resources: [
          Stack.of(this).formatArn({
            service: 'bedrock-agentcore',
            resource: 'memory',
            resourceName: `${config.name}-*`,
          }),
        ],
      }),
    );

    for (const tool of config.tools) {
      switch (tool.type) {
        case 'agentcore_gateway':
          role.addToPolicy(
            new iam.PolicyStatement({
              actions: ['bedrock-agentcore:InvokeGateway'],
              resources: [tool.gatewayArn, `${tool.gatewayArn}/*`],
            }),
          );
          break;
        case 'agentcore_browser':
          role.addToPolicy(
            new iam.PolicyStatement({
              actions: [
                'bedrock-agentcore:StartBrowserSession',
                'bedrock-agentcore:StopBrowserSession',
                'bedrock-agentcore:GetBrowserSession',
                'bedrock-agentcore:UpdateBrowserStream',
                'bedrock-agentcore:ConnectBrowserAutomationStream',
              ],
              // '*': browser sessions are created at runtime under
              // service-generated ids, so there is no stable ARN to pin.
              resources: ['*'],
            }),
          );
          break;
        case 'agentcore_code_interpreter':
          role.addToPolicy(
            new iam.PolicyStatement({
              actions: [
                'bedrock-agentcore:StartCodeInterpreterSession',
                'bedrock-agentcore:InvokeCodeInterpreter',
                'bedrock-agentcore:StopCodeInterpreterSession',
              ],
              // '*': code-interpreter sessions are created at runtime under
              // service-generated ids, so there is no stable ARN to pin.
              resources: ['*'],
            }),
          );
          break;
      }
    }
    return role;
  }

  private renderTools(): agentcore.CfnHarness.HarnessToolProperty[] {
    return this.config.tools.map((tool, index) => {
      switch (tool.type) {
        case 'agentcore_gateway':
          return {
            type: 'agentcore_gateway',
            name: `gateway${index === 0 ? '' : index}`,
            config: { agentCoreGateway: { gatewayArn: tool.gatewayArn } },
          };
        case 'agentcore_browser':
          return {
            type: 'agentcore_browser',
            name: tool.name,
            config: { agentCoreBrowser: {} },
          };
        case 'agentcore_code_interpreter':
          return {
            type: 'agentcore_code_interpreter',
            name: tool.name,
            config: { agentCoreCodeInterpreter: {} },
          };
      }
    });
  }


}
