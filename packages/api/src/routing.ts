/**
 * Route table + matcher for the API router Lambda.
 * Pure and unit-tested; the handler stays a thin dispatch.
 */

export type RouteKey =
  | 'listWorkflows'
  | 'createWorkflow'
  | 'getWorkflow'
  | 'updateWorkflow'
  | 'deleteWorkflow'
  | 'createPlanDraft'
  | 'getPlanDraft'
  | 'savePlan'
  | 'putSchedule'
  | 'runNow'
  | 'listRuns'
  | 'getRun'
  | 'getArtifactUrl'
  | 'getSettings'
  | 'putAgentConfig'
  | 'putOrgSettings';

interface RouteSpec {
  key: RouteKey;
  method: string;
  segments: string[]; // ':name' marks a path parameter
}

const ROUTES: RouteSpec[] = [
  { key: 'listWorkflows', method: 'GET', segments: ['workflows'] },
  { key: 'createWorkflow', method: 'POST', segments: ['workflows'] },
  { key: 'getWorkflow', method: 'GET', segments: ['workflows', ':workflowId'] },
  {
    key: 'updateWorkflow',
    method: 'PUT',
    segments: ['workflows', ':workflowId'],
  },
  {
    key: 'deleteWorkflow',
    method: 'DELETE',
    segments: ['workflows', ':workflowId'],
  },
  {
    key: 'createPlanDraft',
    method: 'POST',
    segments: ['workflows', ':workflowId', 'plan-drafts'],
  },
  { key: 'getPlanDraft', method: 'GET', segments: ['plan-drafts', ':jobId'] },
  { key: 'savePlan', method: 'PUT', segments: ['workflows', ':workflowId', 'plan'] },
  {
    key: 'putSchedule',
    method: 'PUT',
    segments: ['workflows', ':workflowId', 'schedule'],
  },
  { key: 'runNow', method: 'POST', segments: ['workflows', ':workflowId', 'run'] },
  { key: 'listRuns', method: 'GET', segments: ['workflows', ':workflowId', 'runs'] },
  { key: 'getRun', method: 'GET', segments: ['runs', ':runId'] },
  {
    key: 'getArtifactUrl',
    method: 'GET',
    segments: ['runs', ':runId', 'artifact-url'],
  },
  // Runtime configuration (D-19): readable by all signed-in users; PUTs are
  // admin-gated in the handler.
  { key: 'getSettings', method: 'GET', segments: ['settings'] },
  {
    key: 'putAgentConfig',
    method: 'PUT',
    segments: ['settings', 'agents', ':agentName'],
  },
  { key: 'putOrgSettings', method: 'PUT', segments: ['settings', 'org'] },
];

export interface RouteMatch {
  key: RouteKey;
  params: Record<string, string>;
}

export function matchRoute(method: string, rawPath: string): RouteMatch | null {
  const parts = rawPath.split('/').filter((part) => part.length > 0);
  for (const route of ROUTES) {
    if (route.method !== method.toUpperCase()) {
      continue;
    }
    if (route.segments.length !== parts.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.segments.length; i++) {
      const spec = route.segments[i]!;
      const actual = decodeURIComponent(parts[i]!);
      if (spec.startsWith(':')) {
        params[spec.slice(1)] = actual;
      } else if (spec !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { key: route.key, params };
    }
  }
  return null;
}
