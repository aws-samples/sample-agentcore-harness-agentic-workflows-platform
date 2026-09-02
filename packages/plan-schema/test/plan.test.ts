import { describe, expect, it } from 'vitest';
import {
  buildCorrectiveFeedback,
  containsAbsoluteDateReference,
  parsePlanDocument,
  validatePlanAgainstCatalog,
} from '../src/plan';
import { HarnessConfigSchema } from '../src/harness-config';

const validPlan = {
  version: 1,
  goal: 'Research sparkling wine category trends for the spring campaign',
  tasks: [
    {
      id: 't1',
      name: 'web_research_trends',
      worker: 'web_research',
      allowedTools: ['tavily_search', 'browser_fetch_url'],
      prompt: 'Research current sparkling wine category trends.',
      dependsOn: [],
    },
    {
      id: 't2',
      name: 'producer_financials',
      worker: 'data_analysis',
      allowedTools: ['currency_rates'],
      prompt: 'Analyse producer pricing and FX context.',
      dependsOn: [],
    },
    {
      id: 't3',
      name: 'news_synthesis',
      worker: 'web_research',
      allowedTools: ['news_search'],
      prompt: 'Summarise recent coverage building on t1 findings.',
      dependsOn: ['t1'],
    },
  ],
  report: {
    worker: 'report_generator',
    format: 'markdown',
    instructions: 'Assemble a board-ready market brief.',
  },
};

describe('parsePlanDocument', () => {
  it('accepts a valid plan object', () => {
    const result = parsePlanDocument(validPlan);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.tasks).toHaveLength(3);
    }
  });

  it('accepts a valid plan as a JSON string (planner text output)', () => {
    const result = parsePlanDocument(JSON.stringify(validPlan));
    expect(result.ok).toBe(true);
  });

  it('applies defaults for allowedTools and dependsOn', () => {
    const minimal = {
      version: 1,
      goal: 'g',
      tasks: [{ id: 't1', name: 'n', worker: 'w', prompt: 'p' }],
      report: { worker: 'r', instructions: 'i' },
    };
    const result = parsePlanDocument(minimal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.tasks[0]?.allowedTools).toEqual([]);
      expect(result.plan.tasks[0]?.dependsOn).toEqual([]);
      expect(result.plan.report.format).toBe('markdown');
    }
  });

  it('rejects non-JSON text with a clear issue', () => {
    const result = parsePlanDocument('here is your plan!');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toContain('not valid JSON');
    }
  });

  it('rejects duplicate task ids', () => {
    const dupe = {
      ...validPlan,
      tasks: [validPlan.tasks[0], validPlan.tasks[0]],
    };
    const result = parsePlanDocument(dupe);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain('duplicate task id');
    }
  });

  it('rejects unknown dependencies', () => {
    const broken = {
      ...validPlan,
      tasks: [{ ...validPlan.tasks[0], dependsOn: ['nope'] }],
    };
    const result = parsePlanDocument(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain('unknown task "nope"');
    }
  });

  it('rejects dependency cycles', () => {
    const cyclic = {
      ...validPlan,
      tasks: [
        { ...validPlan.tasks[0], id: 'a', dependsOn: ['b'] },
        { ...validPlan.tasks[1], id: 'b', dependsOn: ['a'] },
      ],
    };
    const result = parsePlanDocument(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain('cycle');
    }
  });

  it('rejects unsupported schema versions', () => {
    const result = parsePlanDocument({ ...validPlan, version: 2 });
    expect(result.ok).toBe(false);
  });

  it('rejects a plan without a report section', () => {
    const { report: _report, ...withoutReport } = validPlan;
    const result = parsePlanDocument(withoutReport);
    expect(result.ok).toBe(false);
  });
});

describe('buildCorrectiveFeedback', () => {
  it('lists every issue as a bullet for the planner retry prompt', () => {
    const feedback = buildCorrectiveFeedback(['tasks: cycle', 'goal: too long']);
    expect(feedback).toContain('- tasks: cycle');
    expect(feedback).toContain('- goal: too long');
    expect(feedback).toContain('ONLY the corrected JSON');
  });
});

describe('HarnessConfigSchema', () => {
  it('accepts a gateway-tooled worker config', () => {
    const parsed = HarnessConfigSchema.parse({
      name: 'web_research',
      instructions: 'You research the web.',
      tools: [
        {
          type: 'agentcore_gateway',
          gatewayArn:
            'arn:aws:bedrock-agentcore:ap-southeast-2:123456789012:gateway/g-1',
        },
        { type: 'agentcore_browser' },
      ],
      memory: { enabled: true },
    });
    expect(parsed.tools).toHaveLength(2);
    expect(parsed.memory?.strategies).toEqual(['SEMANTIC']);
  });

  it('rejects invalid harness names', () => {
    expect(() =>
      HarnessConfigSchema.parse({ name: '9bad name!', instructions: 'x' }),
    ).toThrow();
  });

  it('rejects timeouts above the 1-hour platform cap', () => {
    expect(() =>
      HarnessConfigSchema.parse({
        name: 'ok',
        instructions: 'x',
        limits: { timeoutSeconds: 3_601 },
      }),
    ).toThrow();
  });
});

describe('validatePlanAgainstCatalog', () => {
  const catalog = [
    { name: 'web_research', tools: ['tavily_search', 'news_search'] },
    { name: 'report_generator', tools: [] },
  ];
  const plan = parsePlanDocument({
    version: 1,
    goal: 'g',
    tasks: [
      {
        id: 't1',
        name: 'n',
        worker: 'web_research',
        allowedTools: ['tavily_search'],
        prompt: 'p',
      },
    ],
    report: { worker: 'report_generator', instructions: 'i' },
  });

  it('passes a plan whose workers and tools are all registered', () => {
    if (!plan.ok) throw new Error('fixture invalid');

    expect(validatePlanAgainstCatalog(plan.plan, catalog)).toEqual([]);
  });

  it('flags invented tool names with the worker real tool list (D-14)', () => {
    if (!plan.ok) throw new Error('fixture invalid');

    const bad = {
      ...plan.plan,
      tasks: [{ ...plan.plan.tasks[0]!, allowedTools: ['web_search'] }],
    };
    const issues = validatePlanAgainstCatalog(bad, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('web_search');
    expect(issues[0]).toContain('tavily_search');
  });

  it('flags unknown workers including the report worker', () => {
    if (!plan.ok) throw new Error('fixture invalid');

    const bad = {
      ...plan.plan,
      report: { ...plan.plan.report, worker: 'ghost' },
    };
    const issues = validatePlanAgainstCatalog(bad, catalog);
    expect(issues.join('\n')).toContain('unknown worker "ghost"');
  });

  describe('model catalog (per-task modelOverride)', () => {
    const models = [
      { modelId: 'profile/haiku', description: 'fast' },
      { modelId: 'profile/sonnet', description: 'balanced' },
    ];

    it('accepts a modelOverride listed in the model catalog', () => {
      if (!plan.ok) throw new Error('fixture invalid');

      const withOverride = {
        ...plan.plan,
        tasks: [{ ...plan.plan.tasks[0]!, modelOverride: 'profile/haiku' }],
      };
      expect(validatePlanAgainstCatalog(withOverride, catalog, models)).toEqual([]);
    });

    it('flags an invented model id with the available list', () => {
      if (!plan.ok) throw new Error('fixture invalid');

      const bad = {
        ...plan.plan,
        tasks: [{ ...plan.plan.tasks[0]!, modelOverride: 'claude-imaginary' }],
      };
      const issues = validatePlanAgainstCatalog(bad, catalog, models);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('claude-imaginary');
      expect(issues[0]).toContain('profile/haiku');
    });

    it('forbids overrides entirely when the catalog is empty', () => {
      if (!plan.ok) throw new Error('fixture invalid');

      const bad = {
        ...plan.plan,
        tasks: [{ ...plan.plan.tasks[0]!, modelOverride: 'profile/haiku' }],
      };
      const issues = validatePlanAgainstCatalog(bad, catalog, []);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('omit modelOverride');
    });

    it('skips the check when no model catalog is provided (backwards compatible)', () => {
      if (!plan.ok) throw new Error('fixture invalid');

      const withOverride = {
        ...plan.plan,
        tasks: [{ ...plan.plan.tasks[0]!, modelOverride: 'anything-goes' }],
      };
      expect(validatePlanAgainstCatalog(withOverride, catalog)).toEqual([]);
    });
  });

  describe('literal calendar dates in task prompts (D-22)', () => {
    it('flags a "Weekday, Month D, YYYY" date frozen into a task prompt', () => {
      if (!plan.ok) throw new Error('fixture invalid');

      const bad = {
        ...plan.plan,
        tasks: [
          {
            ...plan.plan.tasks[0]!,
            prompt:
              "Today's date is Monday, August 31, 2026. Research the last 3 months of pricing.",
          },
        ],
      };
      const issues = validatePlanAgainstCatalog(bad, catalog);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('tasks.t1.prompt');
      expect(issues[0]).toContain('literal calendar date');
    });

    it('flags an ISO date frozen into the report instructions', () => {
      if (!plan.ok) throw new Error('fixture invalid');

      const bad = {
        ...plan.plan,
        report: { ...plan.plan.report, instructions: 'Dated as of 2026-08-31.' },
      };
      const issues = validatePlanAgainstCatalog(bad, catalog);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('report.instructions');
    });

    it('accepts relative recency phrasing with no absolute date', () => {
      if (!plan.ok) throw new Error('fixture invalid');

      const ok = {
        ...plan.plan,
        tasks: [
          {
            ...plan.plan.tasks[0]!,
            prompt:
              'Research pricing trends over the last 3 months and the most recent quarter.',
          },
        ],
      };
      expect(validatePlanAgainstCatalog(ok, catalog)).toEqual([]);
    });
  });
});

describe('containsAbsoluteDateReference', () => {
  it.each([
    "Today's date is Monday, August 31, 2026.",
    'The report is due August 31, 2026.',
    'Filed on 31 August 2026 for review.',
    'Data as of 2026-08-31.',
  ])('detects an absolute date in: %s', (text) => {
    expect(containsAbsoluteDateReference(text)).toBe(true);
  });

  it.each([
    'Research the last 3 months of pricing trends.',
    'Summarise the most recent quarter for the business.',
    'Cover calendar year performance without naming the year.',
    'Task 4 depends on task 3 for its input.',
  ])('does not flag relative or unrelated text: %s', (text) => {
    expect(containsAbsoluteDateReference(text)).toBe(false);
  });
});
