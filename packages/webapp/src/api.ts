/**
 * Typed API client. Attaches the Cognito id token; 401s clear
 * the session and bounce to login.
 */
import type { PlanDocument } from '@agentic-platform/plan-schema';
import { currentToken, signOut } from './auth';
import { loadConfig } from './config';

export type FailurePolicy = 'contain' | 'fail-fast' | 'retry-run';

export interface WorkflowSummary {
  workflowId: string;
  name: string;
  goal: string;
  planMode: 'static' | 'replan-each-run';
  failurePolicy?: FailurePolicy;
  maxAttempts?: number;
  latestVersion: number;
  schedule?: { expression: string; enabled: boolean };
  createdAt: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface CatalogModelEntry {
  modelId: string;
  description?: string;
}

/** Per-agent runtime config: deployed defaults + admin override (D-19). */
export interface AgentConfig {
  name: string;
  description?: string;
  defaultInstructions: string;
  defaultModelId: string;
  /** Deployed output-token cap (limits.maxTokens). */
  defaultMaxTokens?: number;
  /** Deployed adaptive-thinking effort (planner). */
  defaultThinkingEffort?: 'low' | 'medium' | 'high';
  /** Deployed tool surface: gateway tools + 'browser'/'code_interpreter'. */
  defaultTools?: string[];
  instructionsOverride?: string;
  /** Admin-set model replacing the deployed default. */
  modelOverride?: string;
  /** Admin-set thinking effort; 'off' disables; absent = deployed default. */
  thinkingEffortOverride?: 'off' | 'low' | 'medium' | 'high';
  updatedAt?: string;
  updatedBy?: string;
}

export interface OrgSettings {
  modelCatalog?: CatalogModelEntry[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface SettingsResponse {
  agents: AgentConfig[];
  org: OrgSettings;
  deployedModelCatalog: CatalogModelEntry[];
  isAdmin: boolean;
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  planVersion: number;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt?: string;
}

export interface RunDetail extends RunSummary {
  goal?: string;
  replanned?: boolean;
  tokensInputTotal?: number;
  tokensOutputTotal?: number;
  reportArtifactKey?: string;
}

export interface TaskView {
  taskId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  statusReason?: string;
  artifactKey?: string;
  tokens?: { inputTokens: number; outputTokens: number };
  startedAt?: string;
  finishedAt?: string;
}

export interface PlanDraftJob {
  jobId: string;
  workflowId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  draft?: PlanDocument;
  issues?: string[];
  attempts?: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const config = await loadConfig();
  const token = currentToken();
  if (!token) {
    signOut();
    window.location.assign('/login');
    throw new ApiError(401, 'not signed in');
  }
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) {
    // Session expired server-side: clear it and let the login page explain why.
    signOut();
    window.location.assign('/login?expired=1');
  }
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
      Array.isArray(payload.issues) ? (payload.issues as string[]) : undefined,
    );
  }
  return payload as T;
}

export const api = {
  listWorkflows: () =>
    request<{ workflows: WorkflowSummary[] }>('GET', '/workflows'),
  createWorkflow: (input: {
    name: string;
    goal: string;
    planMode: 'static' | 'replan-each-run';
  }) => request<{ workflowId: string }>('POST', '/workflows', input),
  getWorkflow: (workflowId: string) =>
    request<{ workflow: WorkflowSummary; plan: PlanDocument | null }>(
      'GET',
      `/workflows/${workflowId}`,
    ),
  updateWorkflow: (
    workflowId: string,
    input: {
      name?: string;
      goal?: string;
      planMode?: 'static' | 'replan-each-run';
      failurePolicy?: FailurePolicy;
      maxAttempts?: number;
    },
  ) =>
    request<{ workflow: WorkflowSummary }>(
      'PUT',
      `/workflows/${workflowId}`,
      input,
    ),
  deleteWorkflow: (workflowId: string) =>
    request<{
      workflowId: string;
      deleted: { items: number; runs: number };
      scheduleDeleted: boolean;
    }>('DELETE', `/workflows/${workflowId}`),
  createPlanDraft: (workflowId: string) =>
    request<{ jobId: string }>('POST', `/workflows/${workflowId}/plan-drafts`),
  getPlanDraft: (jobId: string) =>
    request<PlanDraftJob>('GET', `/plan-drafts/${jobId}`),
  savePlan: (workflowId: string, plan: PlanDocument) =>
    request<{ version: number }>('PUT', `/workflows/${workflowId}/plan`, { plan }),
  putSchedule: (workflowId: string, expression: string, enabled: boolean) =>
    request<{ schedule: { expression: string; enabled: boolean } }>(
      'PUT',
      `/workflows/${workflowId}/schedule`,
      { expression, enabled },
    ),
  runNow: (workflowId: string) =>
    request<{ executionArn: string }>('POST', `/workflows/${workflowId}/run`),
  listRuns: (workflowId: string) =>
    request<{ runs: RunSummary[] }>('GET', `/workflows/${workflowId}/runs`),
  getRun: (runId: string) =>
    request<{ run: RunDetail; tasks: TaskView[] }>('GET', `/runs/${runId}`),
  getArtifactUrl: (runId: string, key: string) =>
    request<{ url: string }>(
      'GET',
      `/runs/${runId}/artifact-url?key=${encodeURIComponent(key)}`,
    ),
  // Runtime configuration (D-19): prompts + org settings.
  getSettings: () => request<SettingsResponse>('GET', '/settings'),
  putAgentConfig: (
    agentName: string,
    patch: {
      /** undefined = leave unchanged; null = restore deployed default. */
      instructionsOverride?: string | null;
      modelOverride?: string | null;
      /** 'off' disables thinking; null restores the deployed default. */
      thinkingEffortOverride?: 'off' | 'low' | 'medium' | 'high' | null;
    },
  ) =>
    request<{ name: string }>(
      'PUT',
      `/settings/agents/${encodeURIComponent(agentName)}`,
      patch,
    ),
  putOrgSettings: (modelCatalog: CatalogModelEntry[] | null) =>
    request<{ modelCatalog: CatalogModelEntry[] | null }>(
      'PUT',
      '/settings/org',
      { modelCatalog },
    ),
};
