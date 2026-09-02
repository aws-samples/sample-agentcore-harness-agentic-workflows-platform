import { describe, expect, it } from 'vitest';
import {
  AgentConfigRecordSchema,
  OrgSettingsRecordSchema,
  tableKeys,
} from '../src/records';

describe('AgentConfigRecordSchema', () => {
  const valid = {
    name: 'web_research',
    defaultInstructions: 'You are a researcher.',
    defaultModelId: 'profile/sonnet',
  };

  it('parses a seeded record without an override', () => {
    const parsed = AgentConfigRecordSchema.parse(valid);
    expect(parsed.instructionsOverride).toBeUndefined();
  });

  it('accepts an admin instructions override with audit fields', () => {
    const parsed = AgentConfigRecordSchema.parse({
      ...valid,
      instructionsOverride: 'You are a customized researcher.',
      updatedAt: '2026-08-28T00:00:00Z',
      updatedBy: 'admin-user',
    });
    expect(parsed.instructionsOverride).toContain('customized');
  });

  it('rejects an empty override (clear by removing the field instead)', () => {
    expect(
      AgentConfigRecordSchema.safeParse({ ...valid, instructionsOverride: '' })
        .success,
    ).toBe(false);
  });
});

describe('OrgSettingsRecordSchema', () => {
  it('accepts a model catalog override', () => {
    const parsed = OrgSettingsRecordSchema.parse({
      modelCatalog: [
        { modelId: 'profile/haiku', description: 'fast' },
        { modelId: 'profile/opus' },
      ],
    });
    expect(parsed.modelCatalog).toHaveLength(2);
  });

  it('accepts an empty record (all defaults)', () => {
    expect(OrgSettingsRecordSchema.parse({})).toEqual({});
  });

  it('rejects a catalog beyond 16 entries', () => {
    const oversized = Array.from({ length: 17 }, (_, i) => ({
      modelId: `model-${i}`,
    }));
    expect(
      OrgSettingsRecordSchema.safeParse({ modelCatalog: oversized }).success,
    ).toBe(false);
  });
});

describe('config table keys', () => {
  it('places agent configs and org settings in the CONFIG partition', () => {
    expect(tableKeys.agentConfig('planner')).toEqual({
      pk: 'CONFIG',
      sk: 'AGENT#planner',
    });
    expect(tableKeys.orgSettings()).toEqual({ pk: 'CONFIG', sk: 'ORG' });
  });
});

describe('failure policy fields (D-20)', async () => {
  const { WorkflowRecordSchema, FailurePolicySchema } = await import('../src/records');

  it('defaults to contain with 3 max attempts', () => {
    const parsed = WorkflowRecordSchema.parse({
      workflowId: 'wf',
      name: 'n',
      goal: 'g',
      latestVersion: 0,
      createdAt: '2026-08-28T00:00:00Z',
    });
    expect(parsed.failurePolicy).toBe('contain');
    expect(parsed.maxAttempts).toBe(3);
  });

  it('accepts the three policies and caps attempts at 3', () => {
    for (const policy of ['contain', 'fail-fast', 'retry-run']) {
      expect(FailurePolicySchema.parse(policy)).toBe(policy);
    }
    expect(
      WorkflowRecordSchema.safeParse({
        workflowId: 'wf',
        name: 'n',
        goal: 'g',
        latestVersion: 0,
        createdAt: 'x',
        maxAttempts: 4,
      }).success,
    ).toBe(false);
  });
});
