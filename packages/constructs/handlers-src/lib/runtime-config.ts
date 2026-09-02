/**
 * Runtime configuration resolution (runtime-configurable prompts, D-19).
 *
 * Agent prompts and org settings live in the CONFIG partition of the
 * single table: deploy seeds each agent's defaults (AgenticFoundation
 * custom resource), admins write overrides via the API. Handlers resolve
 * the effective values here — deployed defaults always remain the fallback,
 * so a missing or partial record can never break a run.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  tableKeys,
  type CatalogModel,
  type CatalogWorker,
} from '@agentic-platform/plan-schema';
import { ddb } from './common';

export interface AgentConfigItem {
  name?: string;
  description?: string;
  defaultInstructions?: string;
  defaultModelId?: string;
  /** Deployed limits.maxTokens; re-applied on per-invocation model overrides. */
  defaultMaxTokens?: number;
  /** Deployed thinkingEffort (planner path; CFN can't express it). */
  defaultThinkingEffort?: ThinkingEffort;
  instructionsOverride?: string;
  /** Admin-set model replacing the deployed default. */
  modelOverride?: string;
  /** Admin-set thinking effort; 'off' disables; absent = deployed default. */
  thinkingEffortOverride?: 'off' | ThinkingEffort;
}

export type ThinkingEffort = 'low' | 'medium' | 'high';

/** Per-invocation Bedrock model override, SDK/SFN-agnostic shape. */
export interface ResolvedModelInvocation {
  modelId: string;
  maxTokens?: number;
  /** Present → enable Anthropic adaptive thinking at this effort. */
  thinkingEffort?: ThinkingEffort;
}

/**
 * Resolve the effective per-invocation model config for an agent from its
 * runtime config record. Returns undefined when the deployed harness config
 * applies unchanged (no admin model override, no thinking effort) — callers
 * then omit the Model override entirely, which is the verified base path.
 *
 * Precedence: admin override > deployed default. thinkingEffortOverride of
 * 'off' disables thinking even when a deployed default exists.
 */
export function resolveModelInvocation(
  config: AgentConfigItem | undefined,
): ResolvedModelInvocation | undefined {
  if (!config) {
    return undefined;
  }
  const effort =
    config.thinkingEffortOverride !== undefined
      ? config.thinkingEffortOverride
      : config.defaultThinkingEffort;
  const thinking = effort && effort !== 'off' ? effort : undefined;
  const modelId = config.modelOverride ?? config.defaultModelId;
  if ((!config.modelOverride && !thinking) || !modelId) {
    return undefined;
  }
  return {
    modelId,
    // A model override REPLACES the deployed bedrockModelConfig — always
    // carry the deployed output cap (MaxTokensReached live finding).
    ...(config.defaultMaxTokens !== undefined
      ? { maxTokens: config.defaultMaxTokens }
      : {}),
    ...(thinking ? { thinkingEffort: thinking } : {}),
  };
}

/** Raw agent config record; undefined when never seeded (e.g. ARN workers). */
export async function loadAgentConfig(
  tableName: string,
  agentName: string,
): Promise<AgentConfigItem | undefined> {
  const record = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: tableKeys.agentConfig(agentName),
    }),
  );
  return record.Item as AgentConfigItem | undefined;
}

/**
 * Deploy-seeded worker catalog (names + descriptions + tool scopes) for
 * planner grounding (D-14) and plan validation. Seeded by AgenticFoundation
 * on every deploy; lives in the table because rich worker descriptions
 * exceeded Lambda's 4KB env limit (live deploy finding). Returns undefined
 * when the item is missing — callers fall back to WORKER_HARNESS_MAP names.
 */
export async function loadDeployedWorkerCatalog(
  tableName: string,
): Promise<CatalogWorker[] | undefined> {
  const record = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.workerCatalog() }),
  );
  const raw = record.Item?.catalog;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const parsed = JSON.parse(raw) as CatalogWorker[];
  return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
}

/**
 * Effective model catalog: the org's admin-set override wins; the deployed
 * MODEL_CATALOG env is the fallback; undefined disables per-task models.
 */
export async function loadEffectiveModelCatalog(
  tableName: string,
): Promise<CatalogModel[] | undefined> {
  const record = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.orgSettings() }),
  );
  const override = record.Item?.modelCatalog as CatalogModel[] | undefined;
  if (Array.isArray(override) && override.length > 0) {
    return override;
  }
  const envJson = process.env.MODEL_CATALOG;
  return envJson ? (JSON.parse(envJson) as CatalogModel[]) : undefined;
}
