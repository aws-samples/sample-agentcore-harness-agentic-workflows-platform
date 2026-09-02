/**
 * EvaluateRunHealth — post-waves routing decision for the failure policy
 * (D-20). Runs after every full pass of the waves and tells the interpreter
 * where to go next:
 *
 * - clean pass (no failed tasks)            → { retry: false, report: true }
 * - contain, or retry-run with attempts
 *   exhausted (fall back to contain)        → { retry: false, report: true }
 * - retry-run with attempts remaining       → resets failed AND skipped tasks
 *   to pending (succeeded artifacts are kept), bumps the run's attempt
 *   counter, and returns { retry: true } so the interpreter re-enters the
 *   waves; only not-yet-succeeded work re-executes.
 * - fail-fast with failures (a late failure
 *   that beat the Fail-state short circuit) → { retry: false, report: false }
 *
 * Crash-safe: the attempt bump is conditional on the current value, and a
 * pass that finds no failures but pending tasks under retry-run resumes the
 * interrupted retry instead of reporting against half-reset state.
 */
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { REPORT_TASK_ID, tableKeys } from '@agentic-platform/plan-schema';
import { ddb, isConditionalCheckFailed, nowIso, requireEnv } from './lib/common';

interface EvaluateRunHealthEvent {
  runId: string;
  workflowId: string;
}

interface EvaluateRunHealthResult {
  retry: boolean;
  report: boolean;
  attempts: number;
  failedTasks: number;
}

export async function handler(
  event: EvaluateRunHealthEvent,
): Promise<EvaluateRunHealthResult> {
  const tableName = requireEnv('TABLE_NAME');
  const { runId } = event;

  const run = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.run(runId) }),
  );
  if (!run.Item) {
    throw new Error(`Run not found: ${runId}`);
  }
  const policy = (run.Item.failurePolicy as string) ?? 'contain';
  const maxAttempts = Number(run.Item.maxAttempts ?? 3);
  const attempts = Number(run.Item.attempts ?? 1);

  const records = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':sk': 'TASK#' },
    }),
  );
  const workerTasks = (records.Items ?? []).filter(
    (item) => item.taskId !== REPORT_TASK_ID,
  );
  const retryable = workerTasks.filter(
    (item) => item.status === 'failed' || item.status === 'skipped',
  );
  const failedTasks = workerTasks.filter((item) => item.status === 'failed').length;
  const pendingTasks = workerTasks.filter((item) => item.status === 'pending').length;

  if (failedTasks === 0) {
    // A crashed evaluate can leave a half-reset pass: pending tasks under
    // retry-run mean an interrupted retry — resume it rather than reporting.
    if (policy === 'retry-run' && pendingTasks > 0) {
      return { retry: true, report: false, attempts, failedTasks };
    }
    return { retry: false, report: true, attempts, failedTasks };
  }

  if (policy === 'fail-fast') {
    return { retry: false, report: false, attempts, failedTasks };
  }

  if (policy === 'retry-run' && attempts < maxAttempts) {
    // Bump first (conditionally) so a crash between bump and reset converges
    // on the pending-tasks resume path above.
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: tableKeys.run(runId),
          UpdateExpression: 'SET attempts = :next',
          ConditionExpression: 'attempts = :current',
          ExpressionAttributeValues: {
            ':next': attempts + 1,
            ':current': attempts,
          },
        }),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
      // Already bumped by a crashed prior invocation; continue with resets.
    }
    for (const task of retryable) {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: tableKeys.task(runId, String(task.taskId)),
          UpdateExpression:
            'SET #status = :pending, retriedAt = :now REMOVE statusReason, startedAt, finishedAt',
          // Never resurrect a task that somehow succeeded meanwhile.
          ConditionExpression: '#status IN (:failed, :skipped)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ':failed': 'failed',
            ':skipped': 'skipped',
            ':now': nowIso(),
          },
        }),
      ).catch((error) => {
        if (!isConditionalCheckFailed(error)) {
          throw error;
        }
      });
    }
    console.log('retry-run: re-executing pass', {
      runId,
      attempt: attempts + 1,
      maxAttempts,
      resetTasks: retryable.length,
    });
    return { retry: true, report: false, attempts: attempts + 1, failedTasks };
  }

  // contain, or retry-run exhausted: proceed to the report with gaps noted.
  return { retry: false, report: true, attempts, failedTasks };
}
