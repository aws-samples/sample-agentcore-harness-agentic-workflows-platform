/**
 * Pure validation helpers for the API (unit-tested).
 */

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

const MODEL_CATALOG_MAX = 16;
const MODEL_ID_MAX = 128;
const MODEL_DESCRIPTION_MAX = 512;

export interface OrgSettingsInput {
  modelCatalog: Array<{ modelId: string; description?: string }> | null;
}

/** Admin org settings: model catalog override; null/empty restores default. */
export function validatePutOrgSettings(
  body: unknown,
): { ok: true; value: OrgSettingsInput } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const raw = input.modelCatalog;
  if (raw === null || raw === undefined) {
    return { ok: true, value: { modelCatalog: null } };
  }
  if (!Array.isArray(raw) || raw.length > MODEL_CATALOG_MAX) {
    return {
      ok: false,
      error: `modelCatalog must be an array of at most ${MODEL_CATALOG_MAX} entries, or null to restore the deployed default`,
    };
  }
  if (raw.length === 0) {
    return { ok: true, value: { modelCatalog: null } };
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
  return { ok: true, value: { modelCatalog: catalog } };
}
