/**
 * AgenticWorkflow — the generic plan interpreter.
 *
 * One Standard state machine executes ANY valid plan document:
 *
 *   PrepareRun → [loop: ForEachWave (sequential) → ForEachTask (parallel)
 *     → PrepareTaskInput → [skip?] → invokeHarness → PersistArtifact
 *   → EvaluateRunHealth] → PrepareReportInput → invokeHarness
 *   → PersistReport → FinalizeRun
 *
 * Failure handling is policy-driven per workflow (D-20):
 * - contain (default): every task-level error is caught into
 *   RecordTaskFailure (persist-artifact in failure mode) so one bad task
 *   never fails the wave — downstream tasks are skipped by dependency checks
 *   and the report notes the gaps.
 * - fail-fast: the first recorded task failure raises FailFastStop, failing
 *   the wave into the finalize catch — the run stops, no report.
 * - retry-run: EvaluateRunHealth resets failed/skipped tasks and loops the
 *   waves for up to the workflow's maxAttempts (≤3) passes before falling
 *   back to contain semantics.
 *
 * The harness invocation uses the native Step Functions integration via
 * CustomState (no aws-stepfunctions-tasks class exists yet). The service
 * resource string and parameter shape are construct props so integration
 * changes — including activating per-invocation allowedTools/model
 * overrides — need no construct changes.
 */
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { REPORT_TASK_ID, type CatalogModel } from '@agentic-platform/plan-schema';
import { HarnessAgent } from './harness-agent';

/** Default SF service integration resource for harness invocation. */
export const DEFAULT_INVOKE_HARNESS_RESOURCE =
  'arn:aws:states:::bedrockagentcore:invokeHarness';

export interface AgenticWorkflowProps {
  /** Single-table store for workflow/plan/run/task records. */
  readonly table: dynamodb.ITable;
  /** Artifact bucket (task outputs + report). */
  readonly artifactsBucket: s3.IBucket;
  /**
   * Worker registry: plan `worker` keys → HarnessAgent or harness ARN.
   * Must include the report worker key.
   */
  readonly workers: Record<string, HarnessAgent | string>;
  /**
   * Planner harness for `planMode: replan-each-run` workflows.
   * When omitted, replan-mode workflows fall back to their saved plan.
   */
  readonly planner?: HarnessAgent | string;
  /**
   * Bedrock models the planner may assign per task via `modelOverride`
   *, each with complexity guidance (e.g. "fast — simple extraction").
   * Offered to the planner in its user message, enforced by semantic plan
   * validation, and applied as a per-invocation model override (D-18).
   * Omit to disable per-task model selection.
   */
  readonly modelCatalog?: CatalogModel[];
  /** Parallel task fan-out within a wave. Default: 5 (quota-friendly). */
  readonly maxConcurrency?: number;
  /** Override the invokeHarness service resource. */
  readonly invokeHarnessServiceResource?: string;
  /**
   * Override the invokeHarness Parameters mapping. Default passes
   * HarnessArn/RuntimeSessionId/Messages from `$.prep.taskInput`. Spike 0.3
   * extends this with AllowedTools/ModelId overrides (already computed and
   * returned by PrepareTaskInput, forward-compatible).
   */
  readonly invokeParameters?: Record<string, unknown>;
  /** Lambda timeout for the interpreter handlers. Default: 120s. */
  readonly handlerTimeout?: Duration;
  /** X-Ray tracing on the state machine. Default: true. */
  readonly tracingEnabled?: boolean;
}

export class AgenticWorkflow extends Construct {
  public readonly stateMachine: sfn.StateMachine;
  public readonly workerArns: Record<string, string>;
  /** Names + descriptions + real tool scopes, for planner grounding (D-14). */
  public readonly workerCatalog: Array<{
    name: string;
    description?: string;
    tools?: string[];
  }>;
  /** Models offered for per-task assignment, for API-layer reuse (D-18). */
  public readonly modelCatalog: CatalogModel[];
  public readonly handlers: Record<string, lambda.Function>;

  constructor(scope: Construct, id: string, props: AgenticWorkflowProps) {
    super(scope, id);

    this.workerArns = Object.fromEntries(
      Object.entries(props.workers).map(([name, ref]) => [
        name,
        typeof ref === 'string' ? ref : ref.harnessArn,
      ]),
    );
    if (Object.keys(this.workerArns).length === 0) {
      throw new Error('AgenticWorkflow requires at least one worker harness');
    }

    const baseEnv = {
      TABLE_NAME: props.table.tableName,
      BUCKET_NAME: props.artifactsBucket.bucketName,
    };
    // Worker catalog with real tool names — the planner invents tool names
    // without it (live finding D-14). HarnessAgent workers contribute their
    // gateway tool scope; ARN-only workers contribute their name.
    this.workerCatalog = Object.entries(props.workers).map(([name, ref]) => {
      if (typeof ref === 'string') {
        return { name };
      }
      return {
        name,
        ...(ref.config.description ? { description: ref.config.description } : {}),
        tools: ref.config.tools.flatMap((tool) =>
          tool.type === 'agentcore_gateway' ? (tool.allowedTools ?? []) : [],
        ),
      };
    });

    this.modelCatalog = props.modelCatalog ?? [];

    const plannerArn = props.planner
      ? typeof props.planner === 'string'
        ? props.planner
        : props.planner.harnessArn
      : undefined;
    const prepareRunFn = this.createHandler(
      'PrepareRunFn',
      'prepare-run',
      {
        TABLE_NAME: props.table.tableName,
        WORKER_HARNESS_MAP: JSON.stringify(this.workerArns),
        // The full worker catalog is deploy-seeded into the table by
        // AgenticFoundation (rich descriptions exceeded the 4KB Lambda env
        // limit — live deploy finding); handlers read it at runtime.
        ...(this.modelCatalog.length > 0
          ? { MODEL_CATALOG: JSON.stringify(this.modelCatalog) }
          : {}),
        ...(plannerArn ? { PLANNER_HARNESS_ARN: plannerArn } : {}),
      },
      props,
      // Replanning holds the Lambda open for the planner invocation.
      Duration.minutes(10),
    );
    if (plannerArn) {
      prepareRunFn.addToRolePolicy(
        new iam.PolicyStatement({
          // Both actions: data plane authorizes as InvokeAgentRuntime (D-12).
          actions: [
            'bedrock-agentcore:InvokeHarness',
            'bedrock-agentcore:InvokeAgentRuntime',
          ],
          resources: [plannerArn, `${plannerArn}/*`],
        }),
      );
    }
    const prepareTaskFn = this.createHandler(
      'PrepareTaskInputFn',
      'prepare-task-input',
      { ...baseEnv, WORKER_HARNESS_MAP: JSON.stringify(this.workerArns) },
      props,
    );
    const persistFn = this.createHandler(
      'PersistArtifactFn',
      'persist-artifact',
      baseEnv,
      props,
    );
    const finalizeFn = this.createHandler('FinalizeRunFn', 'finalize-run', {
      TABLE_NAME: props.table.tableName,
    }, props);
    const evaluateFn = this.createHandler(
      'EvaluateRunHealthFn',
      'evaluate-run-health',
      { TABLE_NAME: props.table.tableName },
      props,
    );
    this.handlers = {
      prepareRun: prepareRunFn,
      prepareTaskInput: prepareTaskFn,
      persistArtifact: persistFn,
      finalizeRun: finalizeFn,
      evaluateRunHealth: evaluateFn,
    };

    props.table.grantReadWriteData(prepareRunFn);
    props.table.grantReadWriteData(prepareTaskFn);
    props.table.grantReadWriteData(persistFn);
    props.table.grantReadWriteData(finalizeFn);
    props.table.grantReadWriteData(evaluateFn);
    props.artifactsBucket.grantRead(prepareTaskFn);
    props.artifactsBucket.grantReadWrite(persistFn);

    // --- Task iterator (inner Map) -------------------------------------
    const prepareTask = new tasks.LambdaInvoke(this, 'PrepareTaskInput', {
      lambdaFunction: prepareTaskFn,
      payload: sfn.TaskInput.fromObject({
        'runId.$': '$.runId',
        'workflowId.$': '$.workflowId',
        'taskId.$': '$.taskId',
      }),
      payloadResponseOnly: true,
      resultPath: '$.prep',
    });
    const invokeWorker = this.createInvokeState('InvokeWorkerHarness', props);
    // Override paths (D-18 model, D-19 prompts): SF JSONPath Parameters
    // cannot conditionally include a field, so override-carrying tasks route
    // to twin states whose templates add the override fields. PrepareTaskInput
    // emits systemPrompt+model together (WithOverrides) or model alone
    // (WithModel); tasks without overrides keep the exact live-verified
    // minimal template (D-15).
    const invokeWorkerWithModel = this.createInvokeState(
      'InvokeWorkerHarnessWithModel',
      props,
      { withModel: true },
    );
    const invokeWorkerWithOverrides = this.createInvokeState(
      'InvokeWorkerHarnessWithOverrides',
      props,
      { withModel: true, withSystemPrompt: true },
    );
    const persistTask = new tasks.LambdaInvoke(this, 'PersistArtifact', {
      lambdaFunction: persistFn,
      payload: sfn.TaskInput.fromObject({
        'runId.$': '$.runId',
        'workflowId.$': '$.workflowId',
        'taskId.$': '$.taskId',
        'invocation.$': '$.invocation',
      }),
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });
    const recordTaskFailure = new tasks.LambdaInvoke(this, 'RecordTaskFailure', {
      lambdaFunction: persistFn,
      payload: sfn.TaskInput.fromObject({
        'runId.$': '$.runId',
        'workflowId.$': '$.workflowId',
        'taskId.$': '$.taskId',
        'failure.$': '$.error',
      }),
      payloadResponseOnly: true,
      // The failure record carries the fail-fast verdict (D-20).
      resultPath: '$.failed',
    });
    const taskDone = new sfn.Pass(this, 'TaskDone');
    // fail-fast (D-20): failing this iteration fails the inner Map, which
    // fails the wave; the wave-level catch routes to FinalizeRun, whose
    // straggler sweep marks unfinished tasks and fails the run. Sibling
    // iterations in flight are terminated by Step Functions.
    const failFastStop = new sfn.Fail(this, 'FailFastStop', {
      error: 'TaskFailedFailFast',
      cause: 'failurePolicy=fail-fast: a task failed, stopping the run (D-20)',
    });
    const failFastCheck = new sfn.Choice(this, 'ShouldFailFast')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.failed.failFast'),
          sfn.Condition.booleanEquals('$.failed.failFast', true),
        ),
        failFastStop,
      )
      .otherwise(taskDone);

    prepareTask.addCatch(recordTaskFailure, { resultPath: '$.error' });
    invokeWorker.addCatch(recordTaskFailure, { resultPath: '$.error' });
    invokeWorkerWithModel.addCatch(recordTaskFailure, { resultPath: '$.error' });
    invokeWorkerWithOverrides.addCatch(recordTaskFailure, {
      resultPath: '$.error',
    });
    persistTask.addCatch(recordTaskFailure, { resultPath: '$.error' });
    recordTaskFailure.next(failFastCheck);
    invokeWorker.next(persistTask);
    invokeWorkerWithModel.next(persistTask);
    invokeWorkerWithOverrides.next(persistTask);
    persistTask.next(taskDone);

    const isRunnable = new sfn.Choice(this, 'IsTaskRunnable')
      .when(sfn.Condition.booleanEquals('$.prep.skip', true), taskDone)
      .when(
        sfn.Condition.isPresent('$.prep.taskInput.systemPrompt'),
        invokeWorkerWithOverrides,
      )
      .when(
        sfn.Condition.isPresent('$.prep.taskInput.model'),
        invokeWorkerWithModel,
      )
      .otherwise(invokeWorker);
    const taskChain = prepareTask.next(isRunnable);

    const forEachTask = new sfn.Map(this, 'ForEachTask', {
      itemsPath: '$.wave',
      maxConcurrency: props.maxConcurrency ?? 5,
      itemSelector: {
        'taskId.$': '$$.Map.Item.Value',
        'runId.$': '$.runId',
        'workflowId.$': '$.workflowId',
      },
      resultPath: sfn.JsonPath.DISCARD,
    });
    forEachTask.itemProcessor(taskChain);

    // --- Waves (outer Map, strictly sequential) ------------------------
    const forEachWave = new sfn.Map(this, 'ForEachWave', {
      itemsPath: '$.runContext.waves',
      maxConcurrency: 1,
      itemSelector: {
        'wave.$': '$$.Map.Item.Value',
        'runId.$': '$.runContext.runId',
        'workflowId.$': '$.runContext.workflowId',
      },
      resultPath: sfn.JsonPath.DISCARD,
    });
    forEachWave.itemProcessor(forEachTask);

    // --- Entry + report + finalize -------------------------------------
    const prepareRun = new tasks.LambdaInvoke(this, 'PrepareRun', {
      lambdaFunction: prepareRunFn,
      payload: sfn.TaskInput.fromObject({
        'input.$': '$',
        'executionName.$': '$$.Execution.Name',
        'executionArn.$': '$$.Execution.Id',
      }),
      payloadResponseOnly: true,
      resultPath: '$.runContext',
    });

    const finalize = new tasks.LambdaInvoke(this, 'FinalizeRun', {
      lambdaFunction: finalizeFn,
      payload: sfn.TaskInput.fromObject({
        'runId.$': '$.runContext.runId',
        'workflowId.$': '$.runContext.workflowId',
      }),
      payloadResponseOnly: true,
      resultPath: '$.final',
    });

    const prepareReport = new tasks.LambdaInvoke(this, 'PrepareReportInput', {
      lambdaFunction: prepareTaskFn,
      payload: sfn.TaskInput.fromObject({
        'runId.$': '$.runContext.runId',
        'workflowId.$': '$.runContext.workflowId',
        taskId: REPORT_TASK_ID,
      }),
      payloadResponseOnly: true,
      resultPath: '$.prep',
    });
    const invokeReport = this.createInvokeState('InvokeReportHarness', props);
    // Report twin for admin prompt overrides (D-19); PrepareTaskInput emits
    // systemPrompt+model together for the report when an override applies.
    const invokeReportWithOverrides = this.createInvokeState(
      'InvokeReportHarnessWithOverrides',
      props,
      { withModel: true, withSystemPrompt: true },
    );
    const persistReport = new tasks.LambdaInvoke(this, 'PersistReport', {
      lambdaFunction: persistFn,
      payload: sfn.TaskInput.fromObject({
        'runId.$': '$.runContext.runId',
        'workflowId.$': '$.runContext.workflowId',
        taskId: REPORT_TASK_ID,
        'invocation.$': '$.invocation',
      }),
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });
    const recordReportFailure = new tasks.LambdaInvoke(this, 'RecordReportFailure', {
      lambdaFunction: persistFn,
      payload: sfn.TaskInput.fromObject({
        'runId.$': '$.runContext.runId',
        'workflowId.$': '$.runContext.workflowId',
        taskId: REPORT_TASK_ID,
        'failure.$': '$.error',
      }),
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });

    prepareReport.addCatch(recordReportFailure, { resultPath: '$.error' });
    invokeReport.addCatch(recordReportFailure, { resultPath: '$.error' });
    invokeReportWithOverrides.addCatch(recordReportFailure, {
      resultPath: '$.error',
    });
    persistReport.addCatch(recordReportFailure, { resultPath: '$.error' });
    recordReportFailure.next(finalize);
    // A catastrophic wave failure still finalizes (straggler sweep marks the run).
    forEachWave.addCatch(finalize, { resultPath: '$.error' });

    invokeReport.next(persistReport);
    invokeReportWithOverrides.next(persistReport);
    persistReport.next(finalize);
    const reportRoute = new sfn.Choice(this, 'ReportHasOverrides')
      .when(
        sfn.Condition.isPresent('$.prep.taskInput.systemPrompt'),
        invokeReportWithOverrides,
      )
      .otherwise(invokeReport);

    prepareReport.next(reportRoute);

    // Failure policy routing (D-20): after every full pass of the waves,
    // EvaluateRunHealth decides — retry (loop back into the waves after the
    // handler reset failed/skipped tasks), report (clean pass, contain, or
    // retry-run exhausted), or stop (fail-fast tail case) → finalize.
    const evaluateHealth = new tasks.LambdaInvoke(this, 'EvaluateRunHealth', {
      lambdaFunction: evaluateFn,
      payload: sfn.TaskInput.fromObject({
        'runId.$': '$.runContext.runId',
        'workflowId.$': '$.runContext.workflowId',
      }),
      payloadResponseOnly: true,
      resultPath: '$.health',
    });
    evaluateHealth.addCatch(finalize, { resultPath: '$.error' });
    const routeAfterWaves = new sfn.Choice(this, 'RouteAfterWaves')
      .when(sfn.Condition.booleanEquals('$.health.retry', true), forEachWave)
      .when(sfn.Condition.booleanEquals('$.health.report', true), prepareReport)
      .otherwise(finalize);

    const definition = prepareRun
      .next(forEachWave)
      .next(evaluateHealth)
      .next(routeAfterWaves);

    this.stateMachine = new sfn.StateMachine(this, 'Interpreter', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      tracingEnabled: props.tracingEnabled ?? true,
      comment:
        'Agentic plan interpreter: waves of parallel harness invocations with skip propagation and idempotent persistence',
    });

    // CustomState resources are not auto-granted: allow invoking every
    // registered worker harness (and its endpoints), nothing else.
    const workerResourceArns = Object.values(this.workerArns).flatMap((arn) => [
      arn,
      `${arn}/*`,
    ]);
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        // Both actions: data plane authorizes as InvokeAgentRuntime (D-12).
        actions: [
          'bedrock-agentcore:InvokeHarness',
          'bedrock-agentcore:InvokeAgentRuntime',
        ],
        resources: workerResourceArns,
      }),
    );
  }

  public grantStartExecution(grantee: iam.IGrantable): iam.Grant {
    return this.stateMachine.grantStartExecution(grantee);
  }

  private createInvokeState(
    id: string,
    props: AgenticWorkflowProps,
    overrides: { withModel?: boolean; withSystemPrompt?: boolean } = {},
  ): sfn.CustomState {
    const baseParameters = props.invokeParameters ?? {
      'HarnessArn.$': '$.prep.taskInput.harnessArn',
      'RuntimeSessionId.$': '$.prep.taskInput.sessionId',
      'Messages.$': '$.prep.taskInput.messages',
    };
    // PascalCase override fields emitted by PrepareTaskInput (D-18/D-19,
    // casing convention live-verified for Messages in D-15):
    // Model = { BedrockModelConfig: { ModelId } }, SystemPrompt = [{ Text }].
    const state = new sfn.CustomState(this, id, {
      stateJson: {
        Type: 'Task',
        Resource:
          props.invokeHarnessServiceResource ?? DEFAULT_INVOKE_HARNESS_RESOURCE,
        Parameters: {
          ...baseParameters,
          ...(overrides.withModel ? { 'Model.$': '$.prep.taskInput.model' } : {}),
          ...(overrides.withSystemPrompt
            ? { 'SystemPrompt.$': '$.prep.taskInput.systemPrompt' }
            : {}),
        },
        ResultPath: '$.invocation',
      },
    });
    // Throttle/transient-friendly retries before failure containment kicks in.
    state.addRetry({
      errors: ['States.TaskFailed', 'States.Timeout'],
      interval: Duration.seconds(10),
      maxAttempts: 2,
      backoffRate: 2,
    });
    return state;
  }

  private createHandler(
    id: string,
    name: string,
    environment: Record<string, string>,
    props: AgenticWorkflowProps,
    timeoutOverride?: Duration,
  ): lambda.Function {
    return new lambda.Function(this, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(handlersRoot(), name)),
      timeout: timeoutOverride ?? props.handlerTimeout ?? Duration.seconds(120),
      memorySize: 512,
      environment,
      description: `Agentic workflow interpreter handler: ${name}`,
      // Active tracing so harness invocations receive a sampled trace
      // context — without it the AgentCore runtime falls back to the
      // account Default sampling rule (5%/1-per-sec) and effectively no
      // invocation is captured in GenAI Observability (live finding).
      tracing: lambda.Tracing.ACTIVE,
      // Bounded retention (WA review: default is never-expire).
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });
  }
}

function handlersRoot(): string {
  const candidates = [
    // Compiled library: dist/src/*.js → dist/handlers
    path.join(__dirname, '..', 'handlers'),
    // TS sources (vitest): src/*.ts → ../dist/handlers
    path.join(__dirname, '..', 'dist', 'handlers'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'Handler bundles not found. Build @agentic-platform/constructs first (npm run build).',
  );
}
