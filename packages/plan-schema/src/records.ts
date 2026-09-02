/**
 * Run/task record contracts + DynamoDB single-table key conventions
 * and S3 artifact key conventions.
 * Shared by the interpreter handlers, the API, and the web app.
 */
import { z } from 'zod';

export const RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;
export const TASK_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;
export const TRIGGER_SOURCES = ['schedule', 'manual'] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const TriggerSourceSchema = z.enum(TRIGGER_SOURCES);

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const PLAN_MODES = ['static', 'replan-each-run'] as const;
export const PlanModeSchema = z.enum(PLAN_MODES);
export type PlanMode = z.infer<typeof PlanModeSchema>;

/**
 * Run-level failure handling (D-20):
 * - contain: task failures skip dependents; the report flags gaps.
 * - fail-fast: the first task failure stops the whole run; no report.
 * - retry-run: after a full pass with failures, re-execute the failed and
 *   skipped tasks (succeeded artifacts are kept) for up to maxAttempts total
 *   passes; when attempts are exhausted, fall back to contain semantics.
 */
export const FAILURE_POLICIES = ['contain', 'fail-fast', 'retry-run'] as const;
export const FailurePolicySchema = z.enum(FAILURE_POLICIES);
export type FailurePolicy = z.infer<typeof FailurePolicySchema>;
export const MAX_RUN_ATTEMPTS_LIMIT = 3;

export const WorkflowRecordSchema = z.object({
  workflowId: z.string().min(1),
  name: z.string().min(1).max(128),
  goal: z.string().min(1).max(4_000),
  planMode: PlanModeSchema.default('static'),
  failurePolicy: FailurePolicySchema.default('contain'),
  /** Total passes for retry-run (1-3). Ignored by other policies. */
  maxAttempts: z.number().int().min(1).max(MAX_RUN_ATTEMPTS_LIMIT).default(3),
  latestVersion: z.number().int().min(0),
  schedule: z
    .object({
      expression: z.string().min(1),
      enabled: z.boolean(),
    })
    .optional(),
  createdAt: z.string(),
  createdBy: z.string().optional(),
});
export type WorkflowRecord = z.infer<typeof WorkflowRecordSchema>;

/** GSI used to list entities across partitions (workflow catalog). */
export const LIST_INDEX_NAME = 'gsi1';

export const TaskRecordSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  status: TaskStatusSchema,
  /** Failure message or skip reason. */
  statusReason: z.string().optional(),
  artifactKey: z.string().optional(),
  tokens: TokenUsageSchema.optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const RunRecordSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  planVersion: z.number().int().min(1),
  status: RunStatusSchema,
  trigger: TriggerSourceSchema,
  goal: z.string().optional(),
  failurePolicy: FailurePolicySchema.optional(),
  maxAttempts: z.number().int().min(1).optional(),
  /** Completed execution passes (retry-run bumps it per retry). */
  attempts: z.number().int().min(1).optional(),
  tokens: TokenUsageSchema.optional(),
  reportArtifactKey: z.string().optional(),
  sfnExecutionArn: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The report pseudo-task id used by the interpreter's final step. */
export const REPORT_TASK_ID = '__report';

/**
 * Per-agent runtime configuration (design: runtime-configurable prompts).
 * Deploy seeds the `default*` fields from the synthesized harness configs on
 * every deploy; admins set `instructionsOverride` from the UI. The override
 * is applied at invocation time as an InvokeHarness systemPrompt override —
 * the deployed harness resource itself is never mutated at runtime.
 */
export const AgentConfigRecordSchema = z.object({
  /** Harness name (worker key, 'planner', or the report worker). */
  name: z.string().min(1).max(64),
  description: z.string().max(1_024).optional(),
  /** Baked instructions from the deployed config (refreshed each deploy). */
  defaultInstructions: z.string().min(1).max(50_000),
  /** The agent's deployed default model id. */
  defaultModelId: z.string().min(1).max(128),
  /**
   * The agent's deployed output-token cap (limits.maxTokens). Carried into
   * per-invocation model overrides: an InvokeHarness Model override REPLACES
   * the deployed bedrockModelConfig, so omitting MaxTokens there silently
   * reverts the agent to the service default cap (live MaxTokensReached
   * finding on a modelOverride task).
   */
  defaultMaxTokens: z.number().int().min(1).optional(),
  /**
   * The agent's deployed adaptive-thinking effort (thinkingEffort).
   * Applied per-invocation on the planner path; CFN cannot express it.
   */
  defaultThinkingEffort: z.enum(['low', 'medium', 'high']).optional(),
  /**
   * Deployed tool surface for UI display: gateway tool names plus the
   * capability markers 'browser' and 'code_interpreter'. Informational —
   * plan validation uses the WORKER_CATALOG item, not this field.
   */
  defaultTools: z.array(z.string()).optional(),
  /** Admin-set replacement for defaultInstructions; absent = use default. */
  instructionsOverride: z.string().min(1).max(50_000).optional(),
  /** Admin-set model replacing the deployed default; absent = use default. */
  modelOverride: z.string().min(1).max(128).optional(),
  /**
   * Admin-set thinking effort: overrides defaultThinkingEffort; 'off'
   * disables thinking outright; absent = use the deployed default.
   */
  thinkingEffortOverride: z.enum(['off', 'low', 'medium', 'high']).optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type AgentConfigRecord = z.infer<typeof AgentConfigRecordSchema>;

/**
 * Organization-wide settings (admin-editable). Absent fields fall back to
 * the deployed defaults (e.g. the MODEL_CATALOG environment).
 */
export const OrgSettingsRecordSchema = z.object({
  /** Replaces the deployed model catalog for planner model assignment. */
  modelCatalog: z
    .array(
      z.object({
        modelId: z.string().min(1).max(128),
        description: z.string().max(512).optional(),
      }),
    )
    .max(16)
    .optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type OrgSettingsRecord = z.infer<typeof OrgSettingsRecordSchema>;

/** DynamoDB single-table key builders. */
export const tableKeys = {
  workflowMeta: (workflowId: string) => ({
    pk: `WF#${workflowId}`,
    sk: 'META',
  }),
  /** GSI attributes stamped on workflow meta items for catalog listing. */
  workflowListIndex: (createdAtIso: string, workflowId: string) => ({
    gsi1pk: 'WORKFLOW',
    gsi1sk: `${createdAtIso}#${workflowId}`,
  }),
  plannerJob: (jobId: string) => ({
    pk: `JOB#${jobId}`,
    sk: 'META',
  }),
  planVersion: (workflowId: string, version: number) => ({
    pk: `WF#${workflowId}`,
    sk: `VER#${String(version).padStart(6, '0')}`,
  }),
  /** Canonical run record, addressable by runId alone (handlers). */
  run: (runId: string) => ({
    pk: `RUN#${runId}`,
    sk: 'META',
  }),
  /** Lightweight listing item under the workflow partition (UI run history). */
  runListItem: (workflowId: string, startedAtIso: string, runId: string) => ({
    pk: `WF#${workflowId}`,
    sk: `RUN#${startedAtIso}#${runId}`,
  }),
  task: (runId: string, taskId: string) => ({
    pk: `RUN#${runId}`,
    sk: `TASK#${taskId}`,
  }),
  /** Per-agent runtime config: deploy-seeded defaults + admin overrides. */
  agentConfig: (agentName: string) => ({
    pk: 'CONFIG',
    sk: `AGENT#${agentName}`,
  }),
  /**
   * Deploy-seeded worker catalog (names + descriptions + tool scopes) for
   * planner grounding and plan validation. Lives in the table rather than
   * Lambda env because rich worker descriptions blew the 4KB env limit
   * (live deploy finding). Source of truth remains the workload manifest;
   * every deploy overwrites this item.
   */
  workerCatalog: () => ({
    pk: 'CONFIG',
    sk: 'WORKER_CATALOG',
  }),
  /** Organization-wide settings (single item per deployment). */
  orgSettings: () => ({
    pk: 'CONFIG',
    sk: 'ORG',
  }),
} as const;

/** S3 artifact key builders. */
export const artifactKeys = {
  task: (workflowId: string, runId: string, taskId: string) =>
    `artifacts/${workflowId}/${runId}/${taskId}/output.md`,
  report: (workflowId: string, runId: string) =>
    `artifacts/${workflowId}/${runId}/report.md`,
} as const;
