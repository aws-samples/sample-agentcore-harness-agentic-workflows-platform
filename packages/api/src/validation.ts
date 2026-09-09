/**
 * Pure validation helpers for the API (unit-tested).
 */
import { CHAT_MAX_TURNS_LIMIT } from '@agentic-platform/plan-schema';

/** EventBridge Scheduler expressions: rate(...) or cron(...). */
const RATE_PATTERN = /^rate\(\d+ (minute|minutes|hour|hours|day|days)\)$/;
const CRON_PATTERN = /^cron\([^)]{1,100}\)$/;

export function isValidScheduleExpression(expression: string): boolean {
  return RATE_PATTERN.test(expression) || CRON_PATTERN.test(expression);
}

/**
 * Presign guard: a client may only mint URLs for keys
 * inside the run it is asking about.
 */
export function artifactKeyBelongsToRun(
  key: string,
  workflowId: string,
  runId: string,
): boolean {
  if (key.includes('..')) {
    return false;
  }
  return key.startsWith(`artifacts/${workflowId}/${runId}/`);
}

const WORKFLOW_NAME_MAX = 128;
const GOAL_MAX = 4_000;

/** Run-level failure handling (D-20). Mirrors plan-schema FAILURE_POLICIES. */
export const FAILURE_POLICIES = ['contain', 'fail-fast', 'retry-run'] as const;
export type FailurePolicyInput = (typeof FAILURE_POLICIES)[number];
const MAX_ATTEMPTS_LIMIT = 3;

function parseFailurePolicy(value: unknown): FailurePolicyInput | null {
  return FAILURE_POLICIES.includes(value as FailurePolicyInput)
    ? (value as FailurePolicyInput)
    : null;
}

function parseMaxAttempts(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_ATTEMPTS_LIMIT
    ? parsed
    : null;
}

export interface CreateWorkflowInput {
  name: string;
  goal: string;
  planMode: 'static' | 'replan-each-run';
  failurePolicy: FailurePolicyInput;
  maxAttempts: number;
}

export function validateCreateWorkflow(
  body: unknown,
): { ok: true; value: CreateWorkflowInput } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  if (!name || name.length > WORKFLOW_NAME_MAX) {
    return { ok: false, error: `name is required (max ${WORKFLOW_NAME_MAX} chars)` };
  }
  if (!goal || goal.length > GOAL_MAX) {
    return { ok: false, error: `goal is required (max ${GOAL_MAX} chars)` };
  }
  const planMode =
    input.planMode === 'replan-each-run' ? 'replan-each-run' : 'static';
  const failurePolicy =
    input.failurePolicy === undefined
      ? 'contain'
      : parseFailurePolicy(input.failurePolicy);
  if (failurePolicy === null) {
    return {
      ok: false,
      error: `failurePolicy must be one of: ${FAILURE_POLICIES.join(', ')}`,
    };
  }
  const maxAttempts =
    input.maxAttempts === undefined ? 3 : parseMaxAttempts(input.maxAttempts);
  if (maxAttempts === null) {
    return {
      ok: false,
      error: `maxAttempts must be an integer between 1 and ${MAX_ATTEMPTS_LIMIT}`,
    };
  }
  return { ok: true, value: { name, goal, planMode, failurePolicy, maxAttempts } };
}

/** Plans may only reference registered workers. */
export function unknownWorkers(
  workerKeys: string[],
  registered: string[],
): string[] {
  const known = new Set(registered);
  return [...new Set(workerKeys.filter((worker) => !known.has(worker)))];
}

export interface UpdateWorkflowInput {
  name?: string;
  goal?: string;
  planMode?: 'static' | 'replan-each-run';
  failurePolicy?: FailurePolicyInput;
  maxAttempts?: number;
}

/** Owner edits after creation: any non-empty subset of the editable fields. */
export function validateUpdateWorkflow(
  body: unknown,
): { ok: true; value: UpdateWorkflowInput } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const value: UpdateWorkflowInput = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > WORKFLOW_NAME_MAX) {
      return { ok: false, error: `name must be 1-${WORKFLOW_NAME_MAX} chars` };
    }
    value.name = name;
  }
  if (input.goal !== undefined) {
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (!goal || goal.length > GOAL_MAX) {
      return { ok: false, error: `goal must be 1-${GOAL_MAX} chars` };
    }
    value.goal = goal;
  }
  if (input.planMode !== undefined) {
    if (input.planMode !== 'static' && input.planMode !== 'replan-each-run') {
      return { ok: false, error: 'planMode must be "static" or "replan-each-run"' };
    }
    value.planMode = input.planMode;
  }
  if (input.failurePolicy !== undefined) {
    const failurePolicy = parseFailurePolicy(input.failurePolicy);
    if (failurePolicy === null) {
      return {
        ok: false,
        error: `failurePolicy must be one of: ${FAILURE_POLICIES.join(', ')}`,
      };
    }
    value.failurePolicy = failurePolicy;
  }
  if (input.maxAttempts !== undefined) {
    const maxAttempts = parseMaxAttempts(input.maxAttempts);
    if (maxAttempts === null) {
      return {
        ok: false,
        error: `maxAttempts must be an integer between 1 and ${MAX_ATTEMPTS_LIMIT}`,
      };
    }
    value.maxAttempts = maxAttempts;
  }
  if (Object.keys(value).length === 0) {
    return {
      ok: false,
      error:
        'provide at least one of: name, goal, planMode, failurePolicy, maxAttempts',
    };
  }
  return { ok: true, value };
}

const INSTRUCTIONS_MAX = 50_000;
const AGENT_MODEL_ID_MAX = 128;
const THINKING_EFFORT_VALUES = ['off', 'low', 'medium', 'high'] as const;

/**
 * Admin agent-config overrides. Tri-state per field: absent = leave
 * unchanged; null/'' = clear (restore deployed default); value = set.
 * thinkingEffortOverride additionally accepts 'off' = disable thinking.
 * At least one field must be present.
 */
export interface AgentConfigPatch {
  /** undefined = untouched; null = clear; string = set. */
  instructionsOverride?: string | null;
  modelOverride?: string | null;
  thinkingEffortOverride?: 'off' | 'low' | 'medium' | 'high' | null;
}

export function validatePutAgentConfig(
  body: unknown,
): { ok: true; value: AgentConfigPatch } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const value: AgentConfigPatch = {};

  if ('instructionsOverride' in input) {
    const raw = input.instructionsOverride;
    if (raw === null || raw === '' || raw === undefined) {
      value.instructionsOverride = null;
    } else if (typeof raw !== 'string' || raw.length > INSTRUCTIONS_MAX) {
      return {
        ok: false,
        error: `instructionsOverride must be a string of at most ${INSTRUCTIONS_MAX} chars, or null to restore the deployed default`,
      };
    } else {
      value.instructionsOverride = raw;
    }
  }

  if ('modelOverride' in input) {
    const raw = input.modelOverride;
    if (raw === null || raw === '' || raw === undefined) {
      value.modelOverride = null;
    } else if (
      typeof raw !== 'string' ||
      raw.trim().length === 0 ||
      raw.length > AGENT_MODEL_ID_MAX
    ) {
      return {
        ok: false,
        error: `modelOverride must be a model/inference-profile id of at most ${AGENT_MODEL_ID_MAX} chars, or null to restore the deployed default`,
      };
    } else {
      value.modelOverride = raw.trim();
    }
  }

  if ('thinkingEffortOverride' in input) {
    const raw = input.thinkingEffortOverride;
    if (raw === null || raw === undefined || raw === '') {
      value.thinkingEffortOverride = null;
    } else if (
      typeof raw !== 'string' ||
      !(THINKING_EFFORT_VALUES as readonly string[]).includes(raw)
    ) {
      return {
        ok: false,
        error: `thinkingEffortOverride must be one of ${THINKING_EFFORT_VALUES.join(', ')} ('off' disables thinking), or null to restore the deployed default`,
      };
    } else {
      value.thinkingEffortOverride = raw as AgentConfigPatch['thinkingEffortOverride'];
    }
  }

  if (Object.keys(value).length === 0) {
    return {
      ok: false,
      error:
        'provide at least one of: instructionsOverride, modelOverride, thinkingEffortOverride',
    };
  }
  return { ok: true, value };
}

/**
 * Report chat: a conversation turn. `messages` is the prior conversation
 * (oldest first) and the new user question is the final 'user' turn. The
 * client sends the whole transcript each call — the endpoint is stateless.
 */
const CHAT_MESSAGE_MAX = 8_000;
/**
 * Shape-level ceiling. The EFFECTIVE limit is the org setting `chatMaxTurns`
 * (default CHAT_MAX_TURNS_DEFAULT), enforced by the handlers once settings
 * are loaded; this hard cap just keeps absurd payloads out before any AWS
 * call.
 */
const CHAT_HISTORY_HARD_MAX = CHAT_MAX_TURNS_LIMIT;

export interface ChatMessageInput {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatReportInput {
  messages: ChatMessageInput[];
}

/**
 * Validate a report-chat request. Requires a non-empty `messages` array whose
 * final turn is from the user; caps per-message length and history depth to
 * keep the assembled prompt within the harness budget.
 */
export function validateChatReport(
  body: unknown,
): { ok: true; value: ChatReportInput } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const raw = input.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'messages must be a non-empty array' };
  }
  if (raw.length > CHAT_HISTORY_HARD_MAX) {
    return {
      ok: false,
      error: `messages may contain at most ${CHAT_HISTORY_HARD_MAX} turns`,
    };
  }
  const messages: ChatMessageInput[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const role = entry?.role;
    if (role !== 'user' && role !== 'assistant') {
      return { ok: false, error: 'each message role must be "user" or "assistant"' };
    }
    const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
    if (!content) {
      return { ok: false, error: 'each message needs non-empty content' };
    }
    if (content.length > CHAT_MESSAGE_MAX) {
      return {
        ok: false,
        error: `message content exceeds ${CHAT_MESSAGE_MAX} chars`,
      };
    }
    messages.push({ role, content });
  }
  if (messages[messages.length - 1]!.role !== 'user') {
    return { ok: false, error: 'the final message must be from the user' };
  }
  return { ok: true, value: { messages } };
}

/** Report edits: full-document saves, bounded to keep S3 objects sane. */
const REPORT_MARKDOWN_MAX = 400_000;
const REPORT_NOTE_MAX = 512;

export interface PutReportInput {
  /** The complete new report markdown. */
  markdown: string;
  /**
   * The version the client edited from. The save is rejected (409) when the
   * run has moved past it — optimistic concurrency for concurrent editors.
   */
  baseVersion: number;
  /** Optional change note (e.g. the accepted proposal's rationale). */
  note?: string;
}

export function validatePutReport(
  body: unknown,
): { ok: true; value: PutReportInput } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const markdown =
    typeof input.markdown === 'string' ? input.markdown.replace(/\r\n/g, '\n') : '';
  if (markdown.trim().length === 0) {
    return { ok: false, error: 'markdown is required' };
  }
  if (markdown.length > REPORT_MARKDOWN_MAX) {
    return {
      ok: false,
      error: `markdown exceeds ${REPORT_MARKDOWN_MAX} chars`,
    };
  }
  const baseVersion = Number(input.baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) {
    return { ok: false, error: 'baseVersion must be a positive integer' };
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > REPORT_NOTE_MAX) {
    return { ok: false, error: `note exceeds ${REPORT_NOTE_MAX} chars` };
  }
  return {
    ok: true,
    value: { markdown, baseVersion, ...(note ? { note } : {}) },
  };
}

const MODEL_CATALOG_MAX = 16;
const MODEL_ID_MAX = 128;
const MODEL_DESCRIPTION_MAX = 512;

export interface OrgSettingsInput {
  /** undefined = untouched; null = restore default; array = set. */
  modelCatalog?: Array<{ modelId: string; description?: string }> | null;
  /** undefined = untouched; null = restore default; number = set. */
  chatMaxTurns?: number | null;
}

/**
 * Admin org settings, tri-state per field. For backwards compatibility a
 * body that names neither field is treated as "clear the model catalog"
 * (the original single-field contract); a body naming only `chatMaxTurns`
 * leaves the catalog untouched.
 */
export function validatePutOrgSettings(
  body: unknown,
): { ok: true; value: OrgSettingsInput } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const value: OrgSettingsInput = {};

  if ('chatMaxTurns' in input) {
    const raw = input.chatMaxTurns;
    if (raw === null || raw === undefined || raw === '') {
      value.chatMaxTurns = null;
    } else {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > CHAT_MAX_TURNS_LIMIT) {
        return {
          ok: false,
          error: `chatMaxTurns must be an integer between 1 and ${CHAT_MAX_TURNS_LIMIT}, or null to restore the default`,
        };
      }
      value.chatMaxTurns = parsed;
    }
    if (!('modelCatalog' in input)) {
      return { ok: true, value };
    }
  }

  const raw = input.modelCatalog;
  if (raw === null || raw === undefined) {
    return { ok: true, value: { ...value, modelCatalog: null } };
  }
  if (!Array.isArray(raw) || raw.length > MODEL_CATALOG_MAX) {
    return {
      ok: false,
      error: `modelCatalog must be an array of at most ${MODEL_CATALOG_MAX} entries, or null to restore the deployed default`,
    };
  }
  if (raw.length === 0) {
    return { ok: true, value: { ...value, modelCatalog: null } };
  }
  const catalog: OrgSettingsInput['modelCatalog'] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const modelId =
      typeof entry?.modelId === 'string' ? entry.modelId.trim() : '';
    if (!modelId || modelId.length > MODEL_ID_MAX) {
      return {
        ok: false,
        error: `every catalog entry needs a modelId (1-${MODEL_ID_MAX} chars)`,
      };
    }
    const description =
      typeof entry.description === 'string' ? entry.description.trim() : '';
    if (description.length > MODEL_DESCRIPTION_MAX) {
      return {
        ok: false,
        error: `description exceeds ${MODEL_DESCRIPTION_MAX} chars for ${modelId}`,
      };
    }
    catalog.push({ modelId, ...(description ? { description } : {}) });
  }
  return { ok: true, value: { ...value, modelCatalog: catalog } };
}
