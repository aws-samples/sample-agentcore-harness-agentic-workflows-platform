/**
 * FinalizeRun — run status rollup + straggler sweep.
 *
 * Sweeps task records that never reached a terminal state (a crashed
 * iteration leaves 'running'; a never-started task leaves 'pending') so a run
 * can never end with dangling state — runs must always reach a terminal
 * status, never "stuck in progress". Then rolls up the run status:
 * report failed → failed; all workers succeeded → succeeded; some → partial;
 * none → failed.
 */
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { REPORT_TASK_ID, tableKeys, type RunStatus } from '@agentic-platform/plan-schema';
import { ddb, nowIso, requireEnv } from './lib/common';

interface FinalizeRunEvent {
  runId: string;
  workflowId: string;
}

export async function handler(
  event: FinalizeRunEvent,
): Promise<{ status: RunStatus }> {
  const tableName = requireEnv('TABLE_NAME');
  const { runId, workflowId } = event;
  const finishedAt = nowIso();

  const records = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':sk': 'TASK#' },
    }),
  );

  const statuses = new Map<string, string>();
  for (const item of records.Items ?? []) {
    const taskId = item.taskId as string;
    let status = item.status as string;
    if (status === 'running' || status === 'pending') {
      const swept = status === 'running' ? 'failed' : 'skipped';
      const reason =
        status === 'running'
          ? 'did not complete before finalize (interrupted)'
          : 'never started';
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: tableKeys.task(runId, taskId),
          UpdateExpression:
            'SET #status = :status, statusReason = :reason, finishedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': swept,
            ':reason': reason,
            ':now': finishedAt,
          },
        }),
      );
      status = swept;
    }
    statuses.set(taskId, status);
  }

  const reportOk = statuses.get(REPORT_TASK_ID) === 'succeeded';
  const workerStatuses = [...statuses.entries()]
    .filter(([taskId]) => taskId !== REPORT_TASK_ID)
    .map(([, status]) => status);
  const succeeded = workerStatuses.filter((s) => s === 'succeeded').length;

  let status: RunStatus;
  if (!reportOk || succeeded === 0) {
    status = 'failed';
  } else if (succeeded === workerStatuses.length) {
    status = 'succeeded';
  } else {
    status = 'partial';
  }

  const run = await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: tableKeys.run(runId),
      UpdateExpression: 'SET #status = :status, finishedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':now': finishedAt },
      ReturnValues: 'ALL_NEW',
    }),
  );

  // Keep the workflow-partition listing item in sync for the UI.
  const startedAt = run.Attributes?.startedAt as string | undefined;
  if (startedAt) {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: tableKeys.runListItem(workflowId, startedAt, runId),
        UpdateExpression: 'SET #status = :status, finishedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':now': finishedAt },
      }),
    );
  }

  return { status };
}
