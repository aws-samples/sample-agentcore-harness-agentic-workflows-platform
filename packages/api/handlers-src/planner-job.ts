/**
 * planner-job — authoring-time plan drafting.
 *
 * Invoked asynchronously by the API router (202 + poll pattern). Calls the
 * Planner harness via the shared PlannerClient (corrective retries ≤2 in the
 * same runtime session) and lands the outcome on the job record: a validated
 * draft plan the UI presents for review/edit, or the validation issues.
 */
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableKeys, type PlanDraftProgress } from '@agentic-platform/plan-schema';
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

/**
 * Floor between progress writes. The planner streams for 60–100s, so the
 * review UI (3s poll) gains nothing from sub-second granularity — but a
 * phase change or a newly named task is always worth a write, so this gates
 * only repeats of an unchanged state.
 */
const PROGRESS_WRITE_MS = 2_000;

/**
 * Persist plan-draft progress for the review UI to poll, at most one write
 * in flight. Progress is telemetry: a failed or dropped write must never
 * surface as a failed draft, so writes are fire-and-forget and errors are
 * logged only. The terminal status update is the one that matters, and it is
 * awaited by the handler.
 */
function progressWriter(tableName: string, jobId: string) {
  let lastWriteAt = 0;
  let lastState = '';
  let inFlight = false;
  return (progress: Omit<PlanDraftProgress, 'updatedAt'>): void => {
    const state = `${progress.phase}:${progress.attempt}:${progress.taskNames.length}`;
    const unchanged = state === lastState;
    if (inFlight || (unchanged && Date.now() - lastWriteAt < PROGRESS_WRITE_MS)) {
      return;
    }
    lastState = state;
    lastWriteAt = Date.now();
    inFlight = true;
    void updateJob(tableName, jobId, {
      progress: { ...progress, updatedAt: nowIso() } satisfies PlanDraftProgress,
    })
      .catch((error: unknown) => {
        console.warn('planner-job: progress write failed', { jobId, error });
      })
      .finally(() => {
        inFlight = false;
      });
  };
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
      onProgress: progressWriter(tableName, jobId),
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
