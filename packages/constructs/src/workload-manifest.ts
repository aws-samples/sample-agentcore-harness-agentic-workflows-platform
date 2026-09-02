/**
 * loadWorkloadManifest — agents as YAML, for teams that don't write
 * TypeScript (Python-first customers; docs/python-developers.md).
 *
 * A workload.yaml declares the agents that a stack passes to
 * AgenticFoundation. The loader:
 *   1. parses YAML,
 *   2. expands {{snippet:name}} references inside instructions (shared
 *      prompt blocks — the YAML equivalent of the template-literal
 *      composition the TS configs used),
 *   3. resolves symbolic tool references (`gateway: default` → the real
 *      gatewayArn supplied by the stack; YAML can't take constructor
 *      arguments),
 *   4. validates every agent against the SAME zod HarnessConfigSchema that
 *      TS-authored configs go through — a bad manifest fails `cdk synth`
 *      with agent-and-field-precise errors, never a deploy.
 *
 * Manifest shape:
 *
 *   snippets:                       # optional reusable prompt blocks
 *     temporal_anchor: |
 *       TEMPORAL ANCHOR: ...
 *   agents:
 *     - name: web_research
 *       description: ...
 *       model: default              # optional; 'default' or omitted →
 *                                   # the workload's defaultModelId
 *       instructions: |
 *         You are ... {{snippet:temporal_anchor}} ...
 *       tools:
 *         - gateway: default        # symbolic name from the stack bindings
 *           allowedTools: [tavily_search, news_search]
 *         - browser: true
 *         - codeInterpreter: true
 *       memory: true                # or { strategies: [...], eventExpiryDays: n }
 *       limits: { maxIterations: 24, timeoutSeconds: 1800, maxTokens: 16384 }
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  HarnessConfigSchema,
  type HarnessConfigInput,
} from '@agentic-platform/plan-schema';

export interface WorkloadManifestBindings {
  /** Symbolic gateway names used in the manifest → deployed gateway ARNs. */
  readonly gateways?: Record<string, string>;
}

const SNIPPET_REF = /\{\{\s*snippet:([a-zA-Z0-9_-]+)\s*\}\}/g;
const AGENT_KEYS = new Set([
  'name',
  'description',
  'model',
  'instructions',
  'tools',
  'memory',
  'limits',
  'thinkingEffort',
]);

export function loadWorkloadManifest(
  filePath: string,
  bindings: WorkloadManifestBindings = {},
): HarnessConfigInput[] {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `workload manifest ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`workload manifest ${filePath}: top level must be a mapping`);
  }
  const doc = raw as Record<string, unknown>;
  const issues: string[] = [];

  const snippets = readSnippets(doc, issues);
  if (!Array.isArray(doc.agents) || doc.agents.length === 0) {
    throw new Error(
      `workload manifest ${filePath}: "agents" must be a non-empty list`,
    );
  }

  const configs: HarnessConfigInput[] = [];
  for (const [index, entry] of (doc.agents as unknown[]).entries()) {
    const label = agentLabel(entry, index);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push(`${label}: must be a mapping`);
      continue;
    }
    const agent = entry as Record<string, unknown>;
    for (const key of Object.keys(agent)) {
      if (!AGENT_KEYS.has(key)) {
        issues.push(
          `${label}: unknown key "${key}" (allowed: ${[...AGENT_KEYS].join(', ')})`,
        );
      }
    }

    const candidate: Record<string, unknown> = {
      name: agent.name,
      ...(agent.description !== undefined
        ? { description: agent.description }
        : {}),
      ...(resolveModel(agent.model, label, issues) ?? {}),
      instructions: expandSnippets(agent.instructions, snippets, label, issues),
      tools: resolveTools(agent.tools, bindings, label, issues),
      ...(resolveMemory(agent.memory, label, issues) ?? {}),
      ...(agent.limits !== undefined ? { limits: agent.limits } : {}),
      ...(agent.thinkingEffort !== undefined
        ? { thinkingEffort: agent.thinkingEffort }
        : {}),
    };

    const parsed = HarnessConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(agent)';
        issues.push(`${label}: ${path}: ${issue.message}`);
      }
      continue;
    }
    configs.push(candidate as HarnessConfigInput);
  }

  const names = configs.map((config) => config.name);
  for (const duplicate of names.filter((n, i) => names.indexOf(n) !== i)) {
    issues.push(`duplicate agent name "${duplicate}"`);
  }

  if (issues.length > 0) {
    throw new Error(
      `workload manifest ${filePath} is invalid:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
  }
  return configs;
}

function agentLabel(entry: unknown, index: number): string {
  const name =
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).name
      : undefined;
  return typeof name === 'string' && name.length > 0
    ? `agent "${name}"`
    : `agents[${index}]`;
}

function readSnippets(
  doc: Record<string, unknown>,
  issues: string[],
): Map<string, string> {
  const snippets = new Map<string, string>();
  if (doc.snippets === undefined) {
    return snippets;
  }
  if (typeof doc.snippets !== 'object' || doc.snippets === null) {
    issues.push('"snippets" must be a mapping of name → text');
    return snippets;
  }
  for (const [name, text] of Object.entries(doc.snippets)) {
    if (typeof text !== 'string') {
      issues.push(`snippet "${name}": must be a string`);
      continue;
    }
    snippets.set(name, text.trimEnd());
  }
  return snippets;
}

function expandSnippets(
  instructions: unknown,
  snippets: Map<string, string>,
  label: string,
  issues: string[],
): unknown {
  if (typeof instructions !== 'string') {
    return instructions; // schema validation reports the type error
  }
  return instructions.replace(SNIPPET_REF, (_match, name: string) => {
    const text = snippets.get(name);
    if (text === undefined) {
      issues.push(
        `${label}: unknown snippet "${name}" (defined: ${[...snippets.keys()].join(', ') || 'none'})`,
      );
      return '';
    }
    return text;
  });
}

function resolveModel(
  model: unknown,
  label: string,
  issues: string[],
): { modelId: string } | undefined {
  if (model === undefined || model === null || model === 'default') {
    return undefined; // workload defaultModelId applies
  }
  if (typeof model !== 'string' || model.length === 0) {
    issues.push(`${label}: "model" must be a model id string or "default"`);
    return undefined;
  }
  return { modelId: model };
}

function resolveMemory(
  memory: unknown,
  label: string,
  issues: string[],
): { memory: Record<string, unknown> } | undefined {
  if (memory === undefined || memory === false || memory === null) {
    return undefined;
  }
  if (memory === true) {
    return { memory: { enabled: true } };
  }
  if (typeof memory === 'object' && !Array.isArray(memory)) {
    return { memory: { enabled: true, ...(memory as Record<string, unknown>) } };
  }
  issues.push(`${label}: "memory" must be true or a mapping`);
  return undefined;
}

function resolveTools(
  tools: unknown,
  bindings: WorkloadManifestBindings,
  label: string,
  issues: string[],
): unknown[] {
  if (tools === undefined || tools === null) {
    return [];
  }
  if (!Array.isArray(tools)) {
    issues.push(`${label}: "tools" must be a list`);
    return [];
  }
  const resolved: unknown[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) {
      issues.push(`${label}: each tool entry must be a mapping`);
      continue;
    }
    const entry = tool as Record<string, unknown>;
    if (typeof entry.type === 'string') {
      resolved.push(entry); // full form passthrough (power users)
    } else if (typeof entry.gateway === 'string') {
      const arn = bindings.gateways?.[entry.gateway];
      if (!arn) {
        issues.push(
          `${label}: unknown gateway "${entry.gateway}" (stack provides: ${Object.keys(bindings.gateways ?? {}).join(', ') || 'none'})`,
        );
        continue;
      }
      resolved.push({
        type: 'agentcore_gateway',
        gatewayArn: arn,
        ...(entry.allowedTools !== undefined
          ? { allowedTools: entry.allowedTools }
          : {}),
      });
    } else if (entry.browser !== undefined && entry.browser !== false) {
      resolved.push({
        type: 'agentcore_browser',
        ...(typeof entry.browser === 'string' ? { name: entry.browser } : {}),
      });
    } else if (
      entry.codeInterpreter !== undefined &&
      entry.codeInterpreter !== false
    ) {
      resolved.push({
        type: 'agentcore_code_interpreter',
        ...(typeof entry.codeInterpreter === 'string'
          ? { name: entry.codeInterpreter }
          : {}),
      });
    } else {
      issues.push(
        `${label}: tool entry must have one of "gateway", "browser", "codeInterpreter", or a full "type" form (got keys: ${Object.keys(entry).join(', ')})`,
      );
    }
  }
  return resolved;
}
