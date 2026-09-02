/**
 * planner-job — authoring-time plan drafting.
 *
 * Invoked asynchronously by the API router (202 + poll pattern). Calls the
 * Planner harness via the shared PlannerClient (corrective retries ≤2 in the
 * same runtime session) and lands the outcome on the job record: a validated
 * draft plan the UI presents for review/edit, or the validation issues.
 */
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableKeys } from '@agentic-platform/plan-schema';
import {
  PlanGenerationError,
  generatePlan,
  type WorkerCatalogEntry,
} from '@agentic-platform/constructs/dist/handlers-src/lib/planner-client';
import {
  loadAgentConfig,
  loadDeployedWorkerCatalog,
  loadEffectiveModelCatalog,
  resolveModelInvocation,
} from '@agentic-platform/constructs/dist/handlers-src/lib/runtime-config';
import { ddb, nowIso, requireEnv } from './lib/common';

interface PlannerJobEvent {
  jobId: string;
  workflowId: string;
  goal: string;
}

export async function handler(event: PlannerJobEvent): Promise<void> {
  const tableName = requireEnv('TABLE_NAME');
  const { jobId, workflowId, goal } = event;

  await updateJob(tableName, jobId, {
    status: 'running',
    startedAt: nowIso(),
  });

  try {
    const catalog = await loadWorkerCatalog(tableName);
    // Effective runtime config (D-19): org model catalog override wins over
    // the deployed default; an admin planner-prompt override applies as a
    // per-invocation systemPrompt.
    const modelCatalog = await loadEffectiveModelCatalog(tableName);
    const plannerConfig = await loadAgentConfig(tableName, 'planner');
    const result = await generatePlan({
      plannerHarnessArn: requireEnv('PLANNER_HARNESS_ARN'),
      goal,
      workerCatalog: catalog,
      ...(modelCatalog ? { modelCatalog } : {}),
      ...(plannerConfig?.instructionsOverride
        ? { instructionsOverride: plannerConfig.instructionsOverride }
        : {}),
      ...(() => {
        const model = resolveModelInvocation(plannerConfig);
        return model ? { model } : {};
      })(),
      sessionId: `${jobId}-plan-draft`,
    });
    await updateJob(tableName, jobId, {
      status: 'succeeded',
      draft: result.plan,
      attempts: result.attempts,
      finishedAt: nowIso(),
    });
  } catch (error) {
    if (error instanceof PlanGenerationError) {
      await updateJob(tableName, jobId, {
        status: 'failed',
        issues: error.issues,
        attempts: error.attempts,
        finishedAt: nowIso(),
      });
      return;
    }
    await updateJob(tableName, jobId, {
      status: 'failed',
      issues: [error instanceof Error ? error.message : String(error)],
      finishedAt: nowIso(),
    });
    console.error('planner-job failed', { jobId, workflowId, error });
  }
}

async function loadWorkerCatalog(
  tableName: string,
): Promise<WorkerCatalogEntry[]> {
  // Deploy-seeded catalog (names + descriptions + tool scopes) from the
  // CONFIG partition — moved out of Lambda env after rich descriptions
  // exceeded the 4KB env limit (live deploy finding). WORKER_HARNESS_MAP
  // remains the names-only fallback.
  const catalog = await loadDeployedWorkerCatalog(tableName);
  if (catalog) {
    return catalog;
  }
  const map = JSON.parse(requireEnv('WORKER_HARNESS_MAP')) as Record<
    string,
    string
  >;
  return Object.keys(map).map((name) => ({ name }));
}

async function updateJob(
  tableName: string,
  jobId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: tableKeys.plannerJob(jobId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
