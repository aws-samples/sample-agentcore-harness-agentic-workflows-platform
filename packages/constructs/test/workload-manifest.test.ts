import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkloadManifest } from '../src/workload-manifest';

function manifest(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workload-'));
  const file = path.join(dir, 'workload.yaml');
  writeFileSync(file, content);
  return file;
}

const GW = 'arn:aws:bedrock-agentcore:ap-southeast-2:123456789012:gateway/g-1';

describe('loadWorkloadManifest', () => {
  it('maps YAML agents to HarnessConfigInput with symbolic refs resolved', () => {
    const file = manifest(`
snippets:
  anchor: |
    TEMPORAL ANCHOR: trust the Context date.
agents:
  - name: web_research
    description: Web research specialist
    instructions: |
      You are an analyst.

      {{snippet:anchor}}

      Do good research.
    tools:
      - gateway: default
        allowedTools: [tavily_search, news_search]
      - browser: true
    memory: true
    limits: { maxIterations: 24, timeoutSeconds: 1800 }
  - name: report_generator
    model: au.anthropic.claude-opus-5
    instructions: Assemble the report.
`);
    const configs = loadWorkloadManifest(file, { gateways: { default: GW } });
    expect(configs).toHaveLength(2);

    const research = configs[0]!;
    expect(research.name).toBe('web_research');
    expect(research.instructions).toContain(
      'TEMPORAL ANCHOR: trust the Context date.',
    );
    expect(research.instructions).not.toContain('{{snippet');
    expect(research.tools).toEqual([
      {
        type: 'agentcore_gateway',
        gatewayArn: GW,
        allowedTools: ['tavily_search', 'news_search'],
      },
      { type: 'agentcore_browser' },
    ]);
    expect(research.memory).toEqual({ enabled: true });
    expect(research.modelId).toBeUndefined(); // workload default applies

    expect(configs[1]!.modelId).toBe('au.anthropic.claude-opus-5');
    expect(configs[1]!.tools).toEqual([]);
  });

  it('fails synth-style with agent-and-field-precise errors', () => {
    const file = manifest(`
agents:
  - name: bad-name-with-hyphens
    instructions: x
    limits: { timeoutSeconds: 99999 }
  - name: ok_agent
    instructions: fine
    typo_key: true
`);
    expect(() => loadWorkloadManifest(file)).toThrow(
      /agent "bad-name-with-hyphens": name.*no hyphens[\s\S]*timeoutSeconds[\s\S]*agent "ok_agent": unknown key "typo_key"/,
    );
  });

  it('rejects unknown gateway names and unknown snippets', () => {
    const file = manifest(`
agents:
  - name: worker
    instructions: "{{snippet:nope}} hello"
    tools:
      - gateway: missing
`);
    expect(() => loadWorkloadManifest(file, { gateways: { default: GW } })).toThrow(
      /unknown snippet "nope"[\s\S]*unknown gateway "missing" \(stack provides: default\)/,
    );
  });

  it('rejects duplicate agent names and empty manifests', () => {
    expect(() =>
      loadWorkloadManifest(manifest('agents: []')),
    ).toThrow(/non-empty list/);
    const dupes = manifest(`
agents:
  - { name: planner, instructions: a }
  - { name: planner, instructions: b }
`);
    expect(() => loadWorkloadManifest(dupes)).toThrow(
      /duplicate agent name "planner"/,
    );
  });

  it('allows full-form tool passthrough for power users', () => {
    const file = manifest(`
agents:
  - name: worker
    instructions: x
    tools:
      - type: agentcore_gateway
        gatewayArn: ${GW}
        allowedTools: [news_search]
`);
    const configs = loadWorkloadManifest(file);
    expect(configs[0]!.tools).toEqual([
      { type: 'agentcore_gateway', gatewayArn: GW, allowedTools: ['news_search'] },
    ]);
  });
});
