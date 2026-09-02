/**
 * PrepareTaskInput — assembles a task's harness invocation input.
 *
 * For worker tasks: checks dependency outcomes (skip propagation),
 * gathers dependency artifacts from S3 under a character budget, and builds
 * the user message. For the report pseudo-task: gathers all task outputs plus
 * gap notes.
 *
 * Returns { skip } or { skip: false, taskInput: { harnessArn, sessionId,
 * messages, allowedTools, modelId } }. The interpreter's default invoke
 * parameters use harnessArn/sessionId/messages; allowedTools/modelId are the
 * forward-compatible per-invocation override seam.
 */
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  REPORT_TASK_ID,
  tableKeys,
  type PlanDocument,
  type PlanTask,
} from '@agentic-platform/plan-schema';
import { ddb, getArtifactText, nowIso, requireEnv } from './lib/common';
import { temporalGroundingBlock } from './lib/prompt-context';
import { loadAgentConfig } from './lib/runtime-config';

interface PrepareTaskInputEvent {
  runId: string;
  workflowId: string;
  taskId: string;
}

/**
 * Live-verified (docs/decisions.md D-15): the SF optimized invokeHarness
 * integration requires PascalCase fields THROUGHOUT Parameters, including
 * nested message content — `role` fails with States.Runtime ("Did you mean
 * 'Role'?"), which is uncatchable and kills the execution.
 *
 * `model` and `systemPrompt` mirror the InvokeHarness per-invocation
 * overrides (SDK: model.bedrockModelConfig.modelId / systemPrompt[].text) in
 * that PascalCase convention (D-18, D-19). SF Parameters templates cannot
 * include a field conditionally, so the interpreter routes on which fields
 * are present: both → WithOverrides, model alone → WithModel, none → the
 * verified base template. When an admin instructions override applies, the
 * pair is always emitted together (model falls back to the agent's seeded
 * default) so the single WithOverrides template suffices.
 */
interface TaskInput {
  harnessArn: string;
  sessionId: string;
  messages: Array<{ Role: 'user'; Content: Array<{ Text: string }> }>;
  allowedTools: string[];
  model?: { BedrockModelConfig: { ModelId: string; MaxTokens?: number } };
  systemPrompt?: Array<{ Text: string }>;
  modelId?: string;
}

type PrepareTaskInputResult =
  | { skip: true; taskId: string; reason: string }
  | { skip: false; taskId: string; taskInput: TaskInput };

const MAX_DEP_CHARS = Number(process.env.MAX_DEP_CHARS ?? 24_000);
const MAX_TOTAL_CHARS = Number(process.env.MAX_TOTAL_CHARS ?? 100_000);

export async function handler(
  event: PrepareTaskInputEvent,
): Promise<PrepareTaskInputResult> {
  const tableName = requireEnv('TABLE_NAME');
  const bucketName = requireEnv('BUCKET_NAME');
  const workerMap = JSON.parse(requireEnv('WORKER_HARNESS_MAP')) as Record<
    string,
    string
  >;
  const { runId, workflowId, taskId } = event;

  const run = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.run(runId) }),
  );
  if (!run.Item?.plan) {
    throw new Error(`Run not found or missing plan: ${runId}`);
  }
  const plan = run.Item.plan as PlanDocument;

  if (taskId === REPORT_TASK_ID) {
    return prepareReportInput({
      tableName,
      bucketName,
      workerMap,
      runId,
      workflowId,
      plan,
    });
  }

  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not present in plan for run ${runId}`);
  }

  // Skip propagation: every dependency must have succeeded.
  const unavailable: string[] = [];
  for (const dep of task.dependsOn) {
    const record = await ddb.send(
      new GetCommand({ TableName: tableName, Key: tableKeys.task(runId, dep) }),
    );
    if (record.Item?.status !== 'succeeded') {
      unavailable.push(dep);
    }
  }
  if (unavailable.length > 0) {
    const reason = `dependency not satisfied: ${unavailable.join(', ')}`;
    await updateTaskStatus(tableName, runId, taskId, 'skipped', reason);
    return { skip: true, taskId, reason };
  }

  const sections: string[] = [
    `# Goal`,
    plan.goal,
    `# Context`,
    `${temporalGroundingBlock()} The task prompt below may have been authored on an earlier date — if it mentions any other date or year, today's date above is authoritative. Include the current year in time-sensitive search queries and note publication dates for the sources you use.`,
    `# Your task: ${task.name}`,
    task.prompt,
  ];
  if (task.dependsOn.length > 0) {
    sections.push(`# Inputs from earlier tasks`);
    let budget = MAX_TOTAL_CHARS;
    for (const dep of task.dependsOn) {
      const record = await ddb.send(
        new GetCommand({ TableName: tableName, Key: tableKeys.task(runId, dep) }),
      );
      const key = record.Item?.artifactKey as string | undefined;
      if (!key || budget <= 0) {
        continue;
      }
      const text = await getArtifactText(
        bucketName,
        key,
        Math.min(MAX_DEP_CHARS, budget),
      );
      budget -= text.length;
      sections.push(`## Output of task "${dep}"`, text);
    }
  }

  const harnessArn = workerMap[task.worker];
  if (!harnessArn) {
    throw new Error(
      `No harness registered for worker "${task.worker}" (known: ${Object.keys(workerMap).join(', ')})`,
    );
  }

  await updateTaskStatus(tableName, runId, taskId, 'running');

  return {
    skip: false,
    taskId,
    taskInput: {
      harnessArn,
      sessionId: `${runId}-${taskId}`,
      messages: [{ Role: 'user', Content: [{ Text: sections.join('\n\n') }] }],
      allowedTools: task.allowedTools,
      ...(await resolveInvocationOverrides(
        tableName,
        task.worker,
        task.modelOverride ?? undefined,
      )),
    },
  };
}

/**
 * Resolve per-invocation overrides (D-18 model, D-19 prompts) for a worker.
 * Emission rules (must match the interpreter's Choice routing):
 * - admin instructionsOverride set → systemPrompt AND model together
 *   (model = task override ?? seeded default), for the WithOverrides state;
 * - only a task modelOverride → model alone, for the WithModel state;
 * - neither (or the agent was never seeded) → nothing: verified base state.
 */
async function resolveInvocationOverrides(
  tableName: string,
  workerName: string,
  taskModelOverride?: string,
): Promise<Partial<TaskInput>> {
  const config = await loadAgentConfig(tableName, workerName);
  // Model precedence: admin agent-level override (a deliberate human
  // decision from Settings) > the plan task's modelOverride (planner
  // heuristic) > the seeded deployed default.
  const chosenModel = config?.modelOverride ?? taskModelOverride;
  const effectiveModel = chosenModel ?? config?.defaultModelId;
  // A per-invocation Model override REPLACES the deployed bedrockModelConfig
  // wholesale — it is not merged. Re-apply the deployed maxTokens cap so an
  // override never silently reverts the agent to the service default output
  // cap (live MaxTokensReached finding on a modelOverride task).
  const maxTokens =
    config?.defaultMaxTokens !== undefined
      ? { MaxTokens: config.defaultMaxTokens }
      : {};
  if (config?.instructionsOverride && effectiveModel) {
    return {
      systemPrompt: [{ Text: config.instructionsOverride }],
      model: { BedrockModelConfig: { ModelId: effectiveModel, ...maxTokens } },
      modelId: effectiveModel,
    };
  }
  if (chosenModel) {
    return {
      model: {
        BedrockModelConfig: { ModelId: chosenModel, ...maxTokens },
      },
      modelId: chosenModel,
    };
  }
  return {};
}

async function prepareReportInput(args: {
  tableName: string;
  bucketName: string;
  workerMap: Record<string, string>;
  runId: string;
  workflowId: string;
  plan: PlanDocument;
}): Promise<PrepareTaskInputResult> {
  const { tableName, bucketName, workerMap, runId, plan } = args;

  const records = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `RUN#${runId}`,
        ':sk': 'TASK#',
      },
    }),
  );

  const sections: string[] = [
    `# Goal`,
    plan.goal,
    `# Context`,
    `${temporalGroundingBlock()} The brief is produced as of this date; date it and frame all recency claims accordingly.`,
    `# Report instructions`,
    plan.report.instructions,
    `# Task outputs`,
  ];
  const gaps: string[] = [];
  let budget = MAX_TOTAL_CHARS;

  const byId = new Map<string, PlanTask>(plan.tasks.map((task) => [task.id, task]));
  for (const item of records.Items ?? []) {
    const taskId = item.taskId as string;
    if (taskId === REPORT_TASK_ID) {
      continue;
    }
    const name = byId.get(taskId)?.name ?? taskId;
    if (item.status === 'succeeded' && item.artifactKey && budget > 0) {
      const text = await getArtifactText(
        bucketName,
        item.artifactKey as string,
        Math.min(MAX_DEP_CHARS, budget),
      );
      budget -= text.length;
      sections.push(`## ${name} (${taskId})`, text);
    } else if (item.status !== 'succeeded') {
      gaps.push(
        `- ${name} (${taskId}): ${item.status}${item.statusReason ? ` — ${item.statusReason}` : ''}`,
      );
    }
  }
  if (gaps.length > 0) {
    sections.push(
      `# Gaps`,
      `The following tasks did not produce output. Note these gaps explicitly in the report rather than inventing content:`,
      ...gaps,
    );
  }

  const harnessArn = workerMap[plan.report.worker];
  if (!harnessArn) {
    throw new Error(
      `No harness registered for report worker "${plan.report.worker}"`,
    );
  }

  await updateTaskStatus(tableName, runId, REPORT_TASK_ID, 'running');

  return {
    skip: false,
    taskId: REPORT_TASK_ID,
    taskInput: {
      harnessArn,
      sessionId: `${runId}-report`,
      messages: [{ Role: 'user', Content: [{ Text: sections.join('\n\n') }] }],
      allowedTools: [],
      ...(await resolveInvocationOverrides(tableName, plan.report.worker)),
    },
  };
}

async function updateTaskStatus(
  tableName: string,
  runId: string,
  taskId: string,
  status: 'running' | 'skipped',
  reason?: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: tableKeys.task(runId, taskId),
      UpdateExpression: reason
        ? 'SET #status = :status, statusReason = :reason, finishedAt = :now'
        : 'SET #status = :status, startedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':now': nowIso(),
        ...(reason ? { ':reason': reason } : {}),
      },
    }),
  );
}
