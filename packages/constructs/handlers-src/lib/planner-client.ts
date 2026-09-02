/**
 * PlannerClient — invokes the Planner harness and validates its output into
 * a PlanDocument, with corrective-feedback retries.
 *
 * Uses the real data-plane SDK (`InvokeHarnessCommand`, verified against
 * @aws-sdk/client-bedrock-agentcore 3.1119.0). Corrective retries reuse the
 * SAME runtime session, so the planner sees its previous attempt and the
 * validation issues as conversation turns.
 *
 * Shared by the interpreter's PrepareRun handler (replan-each-run) and
 * the API's planner-job handler (authoring-time drafts).
 */
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessBedrockModelConfig,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  buildCorrectiveFeedback,
  parsePlanDocument,
  validatePlanAgainstCatalog,
  type CatalogModel,
  type CatalogWorker,
  type PlanDocument,
} from '@agentic-platform/plan-schema';
import { temporalGroundingBlock } from './prompt-context';
import type { ResolvedModelInvocation } from './runtime-config';

const client = new BedrockAgentCoreClient({});

export type WorkerCatalogEntry = CatalogWorker;
export type ModelCatalogEntry = CatalogModel;

export interface GeneratePlanArgs {
  plannerHarnessArn: string;
  goal: string;
  /** Workers the plan may reference — embedded in the planner user message. */
  workerCatalog: WorkerCatalogEntry[];
  /**
   * Bedrock models the planner may assign per task via `modelOverride`, with
   * complexity guidance. Omit to disable per-task model selection (overrides
   * are then rejected in validation only when explicitly provided as []).
   */
  modelCatalog?: ModelCatalogEntry[];
  /**
   * Admin-configured replacement for the planner's baked instructions
   * (runtime-configurable prompts, D-19). Applied as a per-invocation
   * systemPrompt override; the deployed harness is untouched.
   */
  instructionsOverride?: string;
  /**
   * Per-invocation model override (admin model choice and/or extended
   * thinking). Resolve via resolveModelInvocation(); undefined = the
   * deployed harness model config applies unchanged.
   */
  model?: ResolvedModelInvocation;
  /** ≥33 chars (runtime session requirement); reused across retries. */
  sessionId: string;
  /** Corrective retries after the first attempt. Default 2. */
  maxRetries?: number;
}

export interface GeneratePlanResult {
  plan: PlanDocument;
  attempts: number;
  rawText: string;
}

export class PlanGenerationError extends Error {
  constructor(
    public readonly issues: string[],
    public readonly attempts: number,
  ) {
    super(
      `Planner output failed validation after ${attempts} attempt(s): ${issues.join('; ')}`,
    );
    this.name = 'PlanGenerationError';
  }
}

export async function generatePlan(
  args: GeneratePlanArgs,
): Promise<GeneratePlanResult> {
  const maxRetries = args.maxRetries ?? 2;
  let message = buildPlannerUserMessage(
    args.goal,
    args.workerCatalog,
    args.modelCatalog,
  );
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
    const rawText = await invokeHarnessText({
      harnessArn: args.plannerHarnessArn,
      sessionId: args.sessionId,
      text: message,
      ...(args.instructionsOverride
        ? { systemPrompt: args.instructionsOverride }
        : {}),
      ...(args.model ? { model: args.model } : {}),
    });
    const parsed = parsePlanDocument(stripCodeFences(rawText));
    if (parsed.ok) {
      // Schema-valid is not enough: workers, tool names, and model ids must
      // be real (live finding D-14 — the planner invents names otherwise).
      const semanticIssues = validatePlanAgainstCatalog(
        parsed.plan,
        args.workerCatalog,
        args.modelCatalog,
      );
      if (semanticIssues.length === 0) {
        return { plan: parsed.plan, attempts: attempt, rawText };
      }
      lastIssues = semanticIssues;
      message = buildCorrectiveFeedback(semanticIssues);
      continue;
    }
    lastIssues = parsed.issues;
    // Same session: the planner sees its own previous output + this feedback.
    message = buildCorrectiveFeedback(parsed.issues);
  }
  throw new PlanGenerationError(lastIssues, 1 + maxRetries);
}

export function buildPlannerUserMessage(
  goal: string,
  workerCatalog: WorkerCatalogEntry[],
  modelCatalog?: ModelCatalogEntry[],
): string {
  const catalog = workerCatalog
    .map((worker) => {
      const tools =
        worker.tools && worker.tools.length > 0
          ? ` (tools: ${worker.tools.join(', ')})`
          : '';
      return `- ${worker.name}${tools}${worker.description ? `: ${worker.description}` : ''}`;
    })
    .join('\n');
  const modelSection =
    modelCatalog && modelCatalog.length > 0
      ? [
          `# Available models`,
          [
            modelCatalog
              .map(
                (model) =>
                  `- ${model.modelId}${model.description ? `: ${model.description}` : ''}`,
              )
              .join('\n'),
            `Set each task's "modelOverride" to the id that matches the task's complexity — a lighter model for simple extraction or lookups, a stronger one for deep synthesis. Use ONLY ids from this list; omit "modelOverride" to accept the worker's default model.`,
          ].join('\n\n'),
        ]
      : [];
  return [
    `# Research goal`,
    goal,
    `# Context`,
    `${temporalGroundingBlock()} Use this date for your own planning decisions only. Do NOT write it (or any absolute date) into task prompts — the plan may be saved and executed on a later date, and each worker receives the actual execution date in its own request context at run time. Phrase recency in task prompts relative to "today" (e.g. "the last 3 months"), never as fixed dates.`,
    `# Available workers`,
    catalog,
    ...modelSection,
    `Produce the plan now. Return ONLY the JSON plan document — no prose, no code fences.`,
  ].join('\n\n');
}

/** Invoke a harness and collect the streamed text content. */
export async function invokeHarnessText(args: {
  harnessArn: string;
  sessionId: string;
  text: string;
  /** Per-invocation system prompt override (SDK-native, D-04/D-19). */
  systemPrompt?: string;
  /** Per-invocation model override (admin model and/or extended thinking). */
  model?: ResolvedModelInvocation;
}): Promise<string> {
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn: args.harnessArn,
      runtimeSessionId: args.sessionId,
      messages: [{ role: 'user', content: [{ text: args.text }] }],
      ...(args.systemPrompt
        ? { systemPrompt: [{ text: args.systemPrompt }] }
        : {}),
      ...(args.model
        ? { model: { bedrockModelConfig: toBedrockModelConfig(args.model) } }
        : {}),
    }),
  );
  let collected = '';
  for await (const event of response.stream ?? []) {
    if ('contentBlockDelta' in event) {
      const delta = (event.contentBlockDelta as { delta?: { text?: string } })
        ?.delta;
      if (delta?.text) {
        collected += delta.text;
      }
    } else if ('runtimeClientError' in event) {
      const error = event.runtimeClientError as { message?: string };
      throw new Error(`Harness runtime error: ${error?.message ?? 'unknown'}`);
    }
  }
  return collected;
}

/**
 * SDK model-override shape for a resolved model invocation. Thinking rides
 * on additionalParams (the harness Bedrock config has no first-class
 * thinking field). Two live findings shaped this:
 * 1. additionalParams entries are spread as TOP-LEVEL Converse request
 *    parameters (a bare `thinking` key fails with "Unknown parameter in
 *    input: thinking, must be one of: modelId, ...,
 *    additionalModelRequestFields, ..."), so the Anthropic block nests
 *    under additionalModelRequestFields.
 * 2. claude-*-5 models reject thinking.type "enabled"/budget_tokens with a
 *    ValidationException directing to type "adaptive" + output_config.effort.
 */
export function toBedrockModelConfig(
  model: ResolvedModelInvocation,
): HarnessBedrockModelConfig {
  return {
    modelId: model.modelId,
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.thinkingEffort
      ? {
          additionalParams: {
            additionalModelRequestFields: {
              thinking: { type: 'adaptive' },
              output_config: { effort: model.thinkingEffort },
            },
          },
        }
      : {}),
  };
}

/** Planners occasionally wrap JSON in markdown fences despite instructions. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  return match?.[1] ?? trimmed;
}
