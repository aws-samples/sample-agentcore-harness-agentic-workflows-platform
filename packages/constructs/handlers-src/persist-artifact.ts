/**
 * PersistArtifact — the idempotent side-effect step.
 *
 * Success path: extracts text + token usage from the invokeHarness result,
 * writes the S3 artifact, marks the task record succeeded (conditionally, so
 * Step Functions retries never double-count tokens), and accumulates run
 * token totals.
 *
 * Failure path (invoked from Catch): records the failure reason on the task,
 * never throwing back so the wave can continue.
 */
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  REPORT_TASK_ID,
  artifactKeys,
  tableKeys,
} from '@agentic-platform/plan-schema';
import {
  ddb,
  isConditionalCheckFailed,
  nowIso,
  putArtifactText,
  requireEnv,
} from './lib/common';
import { extractText, extractUsage, summarizeFailure } from './lib/invocation';

interface PersistArtifactEvent {
  runId: string;
  workflowId: string;
  taskId: string;
  invocation?: unknown;
  failure?: unknown;
}

export async function handler(
  event: PersistArtifactEvent,
): Promise<{ status: 'succeeded' | 'failed'; deduped?: boolean; failFast?: boolean }> {
  const tableName = requireEnv('TABLE_NAME');
  const bucketName = requireEnv('BUCKET_NAME');
  const { runId, workflowId, taskId } = event;
  const isReport = taskId === REPORT_TASK_ID;

  if (event.failure !== undefined || event.invocation === undefined) {
    const reason = summarizeFailure(event.failure);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: tableKeys.task(runId, taskId),
          UpdateExpression:
            'SET #status = :failed, statusReason = :reason, finishedAt = :now',
          ConditionExpression: '#status <> :succeeded',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':failed': 'failed',
            ':succeeded': 'succeeded',
            ':reason': reason,
            ':now': nowIso(),
          },
        }),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
      // Task already succeeded on an earlier attempt; keep it.
    }
    // Fail-fast (D-20): tell the interpreter to stop the whole run. Report
    // failures never fail fast — the run is already at its final step.
    let failFast = false;
    if (!isReport) {
      const run = await ddb.send(
        new GetCommand({ TableName: tableName, Key: tableKeys.run(runId) }),
      );
      failFast = run.Item?.failurePolicy === 'fail-fast';
    }
    return { status: 'failed', failFast };
  }

  const text = extractText(event.invocation);
  const usage = extractUsage(event.invocation);
  const artifactKey = isReport
    ? artifactKeys.report(workflowId, runId)
    : artifactKeys.task(workflowId, runId, taskId);

  // S3 put is an idempotent overwrite of identical content on retry.
  await putArtifactText(bucketName, artifactKey, text);

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: tableKeys.task(runId, taskId),
        UpdateExpression:
          'SET #status = :succeeded, artifactKey = :key, tokens = :tokens, finishedAt = :now',
        ConditionExpression: '#status <> :succeeded',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':succeeded': 'succeeded',
          ':key': artifactKey,
          ':tokens': usage,
          ':now': nowIso(),
        },
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      // Retry after a successful persist: skip run-level token accumulation.
      return { status: 'succeeded', deduped: true };
    }
    throw error;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: tableKeys.run(runId),
      UpdateExpression: isReport
        ? 'ADD tokensInputTotal :in, tokensOutputTotal :out SET reportArtifactKey = :key'
        : 'ADD tokensInputTotal :in, tokensOutputTotal :out',
      ExpressionAttributeValues: {
        ':in': usage.inputTokens,
        ':out': usage.outputTokens,
        ...(isReport ? { ':key': artifactKey } : {}),
      },
    }),
  );

  return { status: 'succeeded' };
}
