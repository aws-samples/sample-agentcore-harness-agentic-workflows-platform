/**
 * Plan document schema — the contract between the Planner harness and the
 * plan interpreter.
 */
import { z } from 'zod';
import {
  PlanCycleError,
  UnknownDependencyError,
  computeWaves,
} from './waves';

export const TASK_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const PLAN_MAX_TASKS = 25;

export const PlanTaskSchema = z.object({
  id: z
    .string()
    .regex(
      TASK_ID_PATTERN,
      'task id must be lowercase alphanumeric/underscore/hyphen and start with a letter',
    ),
  name: z.string().min(1).max(128),
  /** Worker harness key — must resolve to a registered worker. */
  worker: z.string().min(1).max(64),
  /** Narrows the worker's Cedar-bounded tool grant; never widens it. */
  allowedTools: z.array(z.string().min(1)).max(16).default([]),
  modelOverride: z.string().min(1).max(128).nullish(),
  prompt: z.string().min(1).max(20_000),
  dependsOn: z.array(z.string()).max(16).default([]),
});

export const PlanReportSchema = z.object({
  worker: z.string().min(1).max(64),
  format: z.enum(['markdown', 'json']).default('markdown'),
  instructions: z.string().min(1).max(20_000),
});

export const PlanDocumentSchema = z
  .object({
    version: z.literal(1),
    goal: z.string().min(1).max(4_000),
    tasks: z.array(PlanTaskSchema).min(1).max(PLAN_MAX_TASKS),
    report: PlanReportSchema,
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    for (const [index, task] of plan.tasks.entries()) {
      if (seen.has(task.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'id'],
          message: `duplicate task id "${task.id}"`,
        });
      }
      seen.add(task.id);
    }
    if (seen.size !== plan.tasks.length) {
      return; // cycle/dependency checks are meaningless with duplicate ids
    }
    try {
      computeWaves(plan.tasks);
    } catch (error) {
      if (
        error instanceof UnknownDependencyError ||
        error instanceof PlanCycleError
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks'],
          message: error.message,
        });
      } else {
        throw error;
      }
    }
  });

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type PlanReport = z.infer<typeof PlanReportSchema>;
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

export type PlanParseResult =
  | { ok: true; plan: PlanDocument }
  | { ok: false; issues: string[] };

/**
 * Parse and validate raw planner output. Accepts an object or a JSON string
 * (planner harnesses return text content blocks).
 */
export function parsePlanDocument(raw: unknown): PlanParseResult {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ['(root): output is not valid JSON'] };
    }
  }
  const result = PlanDocumentSchema.safeParse(candidate);
  if (result.success) {
    return { ok: true, plan: result.data };
  }
  return { ok: false, issues: formatPlanIssues(result.error) };
}

export function formatPlanIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Corrective-feedback prompt fragment for planner retries:
 * appended to the planner conversation when its output fails validation.
 */
export function buildCorrectiveFeedback(issues: readonly string[]): string {
  return [
    'Your previous plan output failed validation. Fix ALL of the issues below and return ONLY the corrected JSON plan document, with no surrounding prose:',
    ...issues.map((issue) => `- ${issue}`),
  ].join('\n');
}

/** Worker catalog entry for semantic plan validation. */
export interface CatalogWorker {
  name: string;
  description?: string | undefined;
  /** Tool names this worker may use. When present, allowedTools must ⊆ it. */
  tools?: string[] | undefined;
}

/**
 * Model catalog entry: a Bedrock model the planner may assign to a task via
 * `modelOverride`, with complexity guidance for the planner's choice.
 */
export interface CatalogModel {
  /** Bedrock model id or inference profile id/ARN. */
  modelId: string;
  /** When to pick it, e.g. "fast/cheap — simple extraction or lookups". */
  description?: string | undefined;
}

/** Zod mirror of CatalogModel for validating admin-edited org settings. */
export const CatalogModelSchema = z.object({
  modelId: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
});

const MONTH_NAMES =
  'January|February|March|April|May|June|July|August|September|October|November|December';
const WEEKDAY_NAMES =
  'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';

/**
 * Literal calendar-date patterns the planner may still write into task
 * prompts or report instructions despite planner rule 7 (decision D-22) —
 * that rule is an LLM instruction, not an enforced constraint, so
 * non-compliant output must be caught in validation. Task prompts are
 * authored once but may execute much later (saved static plans, schedules,
 * reruns), so a baked drafting-day date goes stale; recency must be phrased
 * relative to "today" and the actual run date is injected at runtime.
 * Matches "August 31, 2026", "31 August 2026", "Monday, August 31" style
 * openers, and ISO dates like "2026-08-31".
 */
const ABSOLUTE_DATE_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(?:${MONTH_NAMES})\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'i'),
  new RegExp(`\\b\\d{1,2}\\s+(?:${MONTH_NAMES})\\s+\\d{4}\\b`, 'i'),
  new RegExp(`\\b(?:${WEEKDAY_NAMES}),?\\s+(?:${MONTH_NAMES})\\b`, 'i'),
  /\b\d{4}-\d{2}-\d{2}\b/,
];

/** True if `text` contains a literal calendar date (see ABSOLUTE_DATE_PATTERNS). */
export function containsAbsoluteDateReference(text: string): boolean {
  return ABSOLUTE_DATE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Semantic validation beyond the schema (live-verified need, decisions D-14):
 * the planner must reference only registered workers and their real tool
 * names — without this it invents plausible tool names like "web_search".
 * The same failure mode applies to model ids, so when a model catalog is
 * provided, every task `modelOverride` must be one of its entries
 * (`undefined` skips the check — deployment offers no per-task models; an
 * empty catalog forbids overrides entirely).
 * Also rejects literal calendar dates in task prompts / report instructions
 * (decision D-22 — planner rule 7 asks the model not to write them, this
 * enforces it) so a drafting-day date can never freeze into a saved plan.
 * Returned issues feed the corrective-retry loop and the savePlan 422 path.
 */
export function validatePlanAgainstCatalog(
  plan: PlanDocument,
  catalog: readonly CatalogWorker[],
  modelCatalog?: readonly CatalogModel[],
): string[] {
  const byName = new Map(catalog.map((worker) => [worker.name, worker]));
  const issues: string[] = [];
  const workerNames = [...byName.keys()].join(', ');
  const modelIds = modelCatalog
    ? new Set(modelCatalog.map((model) => model.modelId))
    : undefined;

  for (const task of plan.tasks) {
    if (modelIds && task.modelOverride && !modelIds.has(task.modelOverride)) {
      issues.push(
        `tasks.${task.id}.modelOverride: unknown model "${task.modelOverride}" (available: ${
          [...modelIds].join(', ') || 'none — omit modelOverride'
        })`,
      );
    }
    if (containsAbsoluteDateReference(task.prompt)) {
      issues.push(
        `tasks.${task.id}.prompt: contains a literal calendar date — phrase recency relative to "today" (e.g. "the last 3 months"); the run date is injected at execution time`,
      );
    }
    const worker = byName.get(task.worker);
    if (!worker) {
      issues.push(
        `tasks.${task.id}.worker: unknown worker "${task.worker}" (available: ${workerNames})`,
      );
      continue;
    }
    if (worker.tools) {
      const unknown = task.allowedTools.filter(
        (tool) => !worker.tools!.includes(tool),
      );
      if (unknown.length > 0) {
        issues.push(
          `tasks.${task.id}.allowedTools: worker "${task.worker}" has no tool(s) ${unknown
            .map((t) => `"${t}"`)
            .join(', ')} (its tools: ${worker.tools.join(', ') || 'none'})`,
        );
      }
    }
  }
  if (containsAbsoluteDateReference(plan.report.instructions)) {
    issues.push(
      `report.instructions: contains a literal calendar date — phrase recency relative to "today"; the run date is injected at execution time`,
    );
  }
  if (!byName.has(plan.report.worker)) {
    issues.push(
      `report.worker: unknown worker "${plan.report.worker}" (available: ${workerNames})`,
    );
  }
  return issues;
}
