import { describe, expect, it } from 'vitest';
import { matchRoute } from '../src/routing';
import {
  artifactKeyBelongsToRun,
  isValidScheduleExpression,
  unknownWorkers,
  validateCreateWorkflow,
  validatePutAgentConfig,
  validatePutOrgSettings,
  validateUpdateWorkflow,
} from '../src/validation';
import { callerGroups, isAdmin, type HttpEvent } from '../handlers-src/lib/http';

describe('matchRoute', () => {
  it('matches static routes', () => {
    expect(matchRoute('GET', '/workflows')).toEqual({
      key: 'listWorkflows',
      params: {},
    });
  });
  it('extracts path parameters', () => {
    expect(matchRoute('PUT', '/workflows/wf-1/schedule')).toEqual({
      key: 'putSchedule',
      params: { workflowId: 'wf-1' },
    });
    expect(matchRoute('GET', '/runs/abc/artifact-url')).toEqual({
      key: 'getArtifactUrl',
      params: { runId: 'abc' },
    });
  });
  it('matches the delete-workflow route', () => {
    expect(matchRoute('DELETE', '/workflows/wf-1')).toEqual({
      key: 'deleteWorkflow',
      params: { workflowId: 'wf-1' },
    });
  });
  it('is method-sensitive', () => {
    expect(matchRoute('DELETE', '/workflows')).toBeNull();
  });
  it('rejects unknown paths', () => {
    expect(matchRoute('GET', '/workflows/x/unknown')).toBeNull();
  });
  it('decodes URI components in parameters', () => {
    expect(matchRoute('GET', '/runs/a%20b')?.params.runId).toBe('a b');
  });
  it('matches the runtime-configuration routes (D-19)', () => {
    expect(matchRoute('PUT', '/workflows/wf-1')).toEqual({
      key: 'updateWorkflow',
      params: { workflowId: 'wf-1' },
    });
    expect(matchRoute('GET', '/settings')).toEqual({
      key: 'getSettings',
      params: {},
    });
    expect(matchRoute('PUT', '/settings/agents/web_research')).toEqual({
      key: 'putAgentConfig',
      params: { agentName: 'web_research' },
    });
    expect(matchRoute('PUT', '/settings/org')).toEqual({
      key: 'putOrgSettings',
      params: {},
    });
  });
});

describe('isValidScheduleExpression', () => {
  it('accepts rate and cron expressions', () => {
    expect(isValidScheduleExpression('rate(7 days)')).toBe(true);
    expect(isValidScheduleExpression('rate(1 hour)')).toBe(true);
    expect(isValidScheduleExpression('cron(0 9 1 * ? *)')).toBe(true);
  });
  it('rejects malformed expressions', () => {
    expect(isValidScheduleExpression('every monday')).toBe(false);
    expect(isValidScheduleExpression('rate(7 fortnights)')).toBe(false);
    expect(isValidScheduleExpression('')).toBe(false);
  });
});

describe('artifactKeyBelongsToRun', () => {
  it('accepts keys inside the run prefix', () => {
    expect(
      artifactKeyBelongsToRun('artifacts/wf1/run1/t1/output.md', 'wf1', 'run1'),
    ).toBe(true);
  });
  it('rejects other runs, traversal, and foreign prefixes', () => {
    expect(
      artifactKeyBelongsToRun('artifacts/wf1/run2/t1/output.md', 'wf1', 'run1'),
    ).toBe(false);
    expect(
      artifactKeyBelongsToRun('artifacts/wf1/run1/../run2/x', 'wf1', 'run1'),
    ).toBe(false);
    expect(artifactKeyBelongsToRun('other/wf1/run1/x', 'wf1', 'run1')).toBe(false);
  });
});

describe('validateCreateWorkflow', () => {
  it('accepts a valid body and defaults planMode', () => {
    const result = validateCreateWorkflow({ name: 'Scan', goal: 'Research X' });
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Scan',
        goal: 'Research X',
        planMode: 'static',
        failurePolicy: 'contain',
        maxAttempts: 3,
      },
    });
  });
  it('accepts replan-each-run', () => {
    const result = validateCreateWorkflow({
      name: 'n',
      goal: 'g',
      planMode: 'replan-each-run',
    });
    expect(result.ok && result.value.planMode).toBe('replan-each-run');
  });
  it('rejects missing fields', () => {
    expect(validateCreateWorkflow({ goal: 'g' }).ok).toBe(false);
    expect(validateCreateWorkflow({ name: 'n' }).ok).toBe(false);
  });
});

describe('unknownWorkers', () => {
  it('reports unregistered workers once', () => {
    expect(
      unknownWorkers(['a', 'b', 'b', 'c'], ['a', 'c']),
    ).toEqual(['b']);
  });
  it('is empty when all workers are registered', () => {
    expect(unknownWorkers(['a'], ['a', 'b'])).toEqual([]);
  });
});

describe('validateUpdateWorkflow', () => {
  it('accepts a partial edit and trims values', () => {
    const result = validateUpdateWorkflow({ goal: '  new goal  ' });
    expect(result).toEqual({ ok: true, value: { goal: 'new goal' } });
  });
  it('accepts a full edit', () => {
    const result = validateUpdateWorkflow({
      name: 'n2',
      goal: 'g2',
      planMode: 'replan-each-run',
    });
    expect(result.ok).toBe(true);
  });
  it('rejects an empty edit and invalid fields', () => {
    expect(validateUpdateWorkflow({}).ok).toBe(false);
    expect(validateUpdateWorkflow({ name: '' }).ok).toBe(false);
    expect(validateUpdateWorkflow({ planMode: 'yolo' }).ok).toBe(false);
  });
  it('accepts failure policy edits and bounds maxAttempts (D-20)', () => {
    expect(validateUpdateWorkflow({ failurePolicy: 'retry-run', maxAttempts: 2 })).toEqual({
      ok: true,
      value: { failurePolicy: 'retry-run', maxAttempts: 2 },
    });
    expect(validateUpdateWorkflow({ failurePolicy: 'explode' }).ok).toBe(false);
    expect(validateUpdateWorkflow({ maxAttempts: 4 }).ok).toBe(false);
    expect(validateUpdateWorkflow({ maxAttempts: 0 }).ok).toBe(false);
  });
});

describe('createWorkflow failure policy defaults (D-20)', () => {
  it('defaults to contain with 3 attempts', () => {
    const result = validateCreateWorkflow({ name: 'n', goal: 'g' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.failurePolicy).toBe('contain');
      expect(result.value.maxAttempts).toBe(3);
    }
  });
  it('accepts explicit policy and rejects invalid ones', () => {
    expect(
      validateCreateWorkflow({ name: 'n', goal: 'g', failurePolicy: 'fail-fast' }).ok,
    ).toBe(true);
    expect(
      validateCreateWorkflow({ name: 'n', goal: 'g', failurePolicy: 'bogus' }).ok,
    ).toBe(false);
  });
});

describe('validatePutAgentConfig', () => {
  it('accepts an override string', () => {
    expect(validatePutAgentConfig({ instructionsOverride: 'You are…' })).toEqual({
      ok: true,
      value: { instructionsOverride: 'You are…' },
    });
  });
  it('normalizes present-but-null/empty to a clear', () => {
    for (const body of [{ instructionsOverride: null }, { instructionsOverride: '' }]) {
      expect(validatePutAgentConfig(body)).toEqual({
        ok: true,
        value: { instructionsOverride: null },
      });
    }
  });
  it('rejects an empty patch — absent fields stay untouched', () => {
    // Tri-state semantics: {} names no field, so nothing may change (an
    // empty body must never silently clear an override).
    expect(validatePutAgentConfig({}).ok).toBe(false);
  });
  it('rejects non-strings and oversized prompts', () => {
    expect(validatePutAgentConfig({ instructionsOverride: 42 }).ok).toBe(false);
    expect(
      validatePutAgentConfig({ instructionsOverride: 'x'.repeat(50_001) }).ok,
    ).toBe(false);
  });
  it('accepts model and thinking overrides, trimming the model id', () => {
    expect(
      validatePutAgentConfig({
        modelOverride: ' au.anthropic.claude-opus-5 ',
        thinkingEffortOverride: 'high',
      }),
    ).toEqual({
      ok: true,
      value: {
        modelOverride: 'au.anthropic.claude-opus-5',
        thinkingEffortOverride: 'high',
      },
    });
    // 'off' = explicitly disable thinking; null = restore deployed default.
    expect(validatePutAgentConfig({ thinkingEffortOverride: 'off' })).toEqual({
      ok: true,
      value: { thinkingEffortOverride: 'off' },
    });
    expect(validatePutAgentConfig({ modelOverride: null })).toEqual({
      ok: true,
      value: { modelOverride: null },
    });
  });
  it('rejects invalid model ids and unknown thinking efforts', () => {
    expect(validatePutAgentConfig({ modelOverride: 42 }).ok).toBe(false);
    expect(validatePutAgentConfig({ modelOverride: '   ' }).ok).toBe(false);
    expect(validatePutAgentConfig({ thinkingEffortOverride: 'max' }).ok).toBe(false);
    expect(validatePutAgentConfig({ thinkingEffortOverride: 16384 }).ok).toBe(false);
  });
});

describe('validatePutOrgSettings', () => {
  it('accepts a model catalog and trims entries', () => {
    const result = validatePutOrgSettings({
      modelCatalog: [{ modelId: ' profile/haiku ', description: 'fast' }],
    });
    expect(result).toEqual({
      ok: true,
      value: { modelCatalog: [{ modelId: 'profile/haiku', description: 'fast' }] },
    });
  });
  it('normalizes null/absent/empty-array to a clear', () => {
    for (const body of [{}, { modelCatalog: null }, { modelCatalog: [] }]) {
      expect(validatePutOrgSettings(body)).toEqual({
        ok: true,
        value: { modelCatalog: null },
      });
    }
  });
  it('rejects entries without modelId and oversized catalogs', () => {
    expect(validatePutOrgSettings({ modelCatalog: [{ description: 'x' }] }).ok).toBe(false);
    expect(
      validatePutOrgSettings({
        modelCatalog: Array.from({ length: 17 }, (_, i) => ({ modelId: `m${i}` })),
      }).ok,
    ).toBe(false);
  });
});

describe('caller group parsing (HTTP API stringified claims)', () => {
  const eventWith = (groups: unknown): HttpEvent => ({
    rawPath: '/settings',
    requestContext: {
      http: { method: 'GET' },
      authorizer: { jwt: { claims: { 'cognito:groups': groups } } },
    },
  });

  it('handles real arrays and bracketed strings', () => {
    expect(callerGroups(eventWith(['admin', 'analysts']))).toEqual([
      'admin',
      'analysts',
    ]);
    expect(callerGroups(eventWith('[admin analysts]'))).toEqual([
      'admin',
      'analysts',
    ]);
    expect(callerGroups(eventWith('admin'))).toEqual(['admin']);
  });
  it('isAdmin requires the admin group', () => {
    expect(isAdmin(eventWith('[admin]'))).toBe(true);
    expect(isAdmin(eventWith('[analysts]'))).toBe(false);
    expect(isAdmin(eventWith(undefined))).toBe(false);
  });
});
