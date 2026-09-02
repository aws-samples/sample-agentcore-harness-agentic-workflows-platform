/**
 * PrepareRun — first interpreter state.
 *
 * Loads the workflow + plan version from DynamoDB, validates the plan,
 * computes execution waves, and seeds the run + task records. Idempotent:
 * runId derives from the Step Functions execution name, and the run record is
 * written with a conditional put so Lambda retries never double-seed.
 */
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import {
  REPORT_TASK_ID,
  computeWaves,
  parsePlanDocument,
  tableKeys,
  type PlanDocument,
  type TriggerSource,
} from '@agentic-platform/plan-schema';
import { ddb, isConditionalCheckFailed, nowIso, requireEnv } from './lib/common';
import { generatePlan } from './lib/planner-client';
import {
  loadAgentConfig,
  loadDeployedWorkerCatalog,
  loadEffectiveModelCatalog,
  resolveModelInvocation,
} from './lib/runtime-config';

interface PrepareRunEvent {
  input?: {
    workflowId?: string;
    planVersion?: number;
    trigger?: string;
  };
  executionName?: string;
  /** $$.Execution.Id — stored so the API can reconcile dead runs (D-15). */
  executionArn?: string;
}

interface PrepareRunResult {
  runId: string;
  workflowId: string;
  planVersion: number;
  waves: string[][];
}

export async function handler(event: PrepareRunEvent): Promise<PrepareRunResult> {
  const tableName = requireEnv('TABLE_NAME');
  const workflowId = event.input?.workflowId;
  if (!workflowId) {
    throw new Error('StartExecution input must include workflowId');
  }
  const trigger: TriggerSource =
    event.input?.trigger === 'schedule' ? 'schedule' : 'manual';

  const meta = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.workflowMeta(workflowId) }),
  );
  if (!meta.Item) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  const runId = event.executionName ?? randomUUID();

  let plan: PlanDocument;
  let planVersion: number;
  let replanned = false;

  const plannerArn = process.env.PLANNER_HARNESS_ARN;
  if (meta.Item.planMode === 'replan-each-run' && plannerArn) {
    // Re-plan at execution time; the fresh plan becomes this run's
    // plan-of-record, recorded on the run record itself.
    const workerMap = JSON.parse(process.env.WORKER_HARNESS_MAP ?? '{}') as Record<
      string,
      string
    >;
    // Deploy-seeded catalog from the table (4KB env limit, live finding);
    // org override wins over the deployed MODEL_CATALOG; the planner's
    // admin-set instructions apply as an invocation override (D-19).
    const workerCatalog = await loadDeployedWorkerCatalog(tableName);
    const modelCatalog = await loadEffectiveModelCatalog(tableName);
    const plannerConfig = await loadAgentConfig(tableName, 'planner');
    const generated = await generatePlan({
      plannerHarnessArn: plannerArn,
      goal: String(meta.Item.goal ?? ''),
      workerCatalog:
        workerCatalog ?? Object.keys(workerMap).map((name) => ({ name })),
      ...(modelCatalog ? { modelCatalog } : {}),
      ...(plannerConfig?.instructionsOverride
        ? { instructionsOverride: plannerConfig.instructionsOverride }
        : {}),
      ...(() => {
        const model = resolveModelInvocation(plannerConfig);
        return model ? { model } : {};
      })(),
      sessionId: `${runId}-replanner`,
    });
    plan = generated.plan;
    planVersion = Number(meta.Item.latestVersion ?? 0);
    replanned = true;
  } else {
    planVersion = event.input?.planVersion ?? Number(meta.Item.latestVersion);
    if (!Number.isInteger(planVersion) || planVersion < 1) {
      throw new Error(`Workflow ${workflowId} has no usable plan version`);
    }
    const versionItem = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: tableKeys.planVersion(workflowId, planVersion),
      }),
    );
    if (!versionItem.Item?.plan) {
      throw new Error(
        `Plan version ${planVersion} not found for workflow ${workflowId}`,
      );
    }
    const parsed = parsePlanDocument(versionItem.Item.plan);
    if (!parsed.ok) {
      throw new Error(
        `Stored plan v${planVersion} for workflow ${workflowId} is invalid: ${parsed.issues.join('; ')}`,
      );
    }
    plan = parsed.plan;
  }

  const waves = computeWaves(plan.tasks);
  const startedAt = nowIso();

  // Failure policy (D-20) is stamped onto the run so the policy edit that
  // happens mid-run never changes an in-flight run's behavior.
  const failurePolicy =
    meta.Item.failurePolicy === 'fail-fast' ||
    meta.Item.failurePolicy === 'retry-run'
      ? (meta.Item.failurePolicy as string)
      : 'contain';
  const maxAttempts = Math.min(
    Math.max(Math.trunc(Number(meta.Item.maxAttempts ?? 3)) || 3, 1),
    3,
  );

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...tableKeys.run(runId),
          entity: 'RUN',
          runId,
          workflowId,
          planVersion,
          status: 'running',
          trigger,
          goal: plan.goal,
          plan,
          replanned,
          failurePolicy,
          maxAttempts,
          attempts: 1,
          startedAt,
          sfnExecutionArn: event.executionArn,
          tokensInputTotal: 0,
          tokensOutputTotal: 0,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      // Retry of an already-seeded run: return the same shape, do not re-seed.
      return { runId, workflowId, planVersion, waves };
    }
    throw error;
  }

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...tableKeys.runListItem(workflowId, startedAt, runId),
        entity: 'RUN_LIST',
        runId,
        workflowId,
        planVersion,
        status: 'running',
        trigger,
        startedAt,
      },
    }),
  );

  const taskIds = [...plan.tasks.map((task) => task.id), REPORT_TASK_ID];
  const puts = taskIds.map((taskId) => ({
    PutRequest: {
      Item: {
        ...tableKeys.task(runId, taskId),
        entity: 'TASK',
        runId,
        workflowId,
        taskId,
        status: 'pending',
      },
    },
  }));
  for (let i = 0; i < puts.length; i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [tableName]: puts.slice(i, i + 25) },
      }),
    );
  }

  return { runId, workflowId, planVersion, waves };
}
