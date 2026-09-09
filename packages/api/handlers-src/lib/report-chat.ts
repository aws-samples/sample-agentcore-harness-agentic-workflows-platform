/**
 * Pure helpers for the report chat route: request assembly for the
 * report_chat harness and parsing of its optional edit proposal.
 *
 * The agent's instructions (workload.yaml `report_chat`) define the
 * contract: answer text, optionally followed by ONE fenced block
 *
 *   ```edit-proposal
 *   {"heading": "## X", "newMarkdown": "## X\n\n...", "rationale": "..."}
 *   ```
 *
 * We strip that block from the visible answer and return it structured,
 * after checking the heading exists in the report and the replacement
 * splices cleanly — a proposal the UI could not apply is dropped with a
 * note rather than shown as a broken "Apply" button.
 */
import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  REPORT_TASK_ID,
  findReportSection,
  replaceReportSection,
  tableKeys,
  type ReportVersion,
} from '@agentic-platform/plan-schema';
import {
  loadAgentConfig,
  resolveModelInvocation,
  type ResolvedModelInvocation,
} from '@agentic-platform/constructs/dist/handlers-src/lib/runtime-config';
import { ddb } from './common';

const s3 = new S3Client({});

/**
 * Reserved agent name (mirrors REPORT_CHAT_AGENT_NAME in the constructs
 * package; duplicated here so the Lambda bundle never imports CDK code).
 */
export const REPORT_CHAT_AGENT_NAME = 'report_chat';

/** Character budgets for grounding material injected into each request. */
export const CHAT_REPORT_MAX_CHARS = 60_000;
export const CHAT_SOURCES_TOTAL_MAX_CHARS = 90_000;
export const CHAT_SOURCE_MAX_CHARS = 20_000;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface GroundingSource {
  taskId: string;
  name: string;
  text: string;
}

export interface ProposedEdit {
  heading: string;
  newMarkdown: string;
  rationale?: string;
}

export function truncateText(text: string, maxChars: number, label: string): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n\n[${label} truncated at ${maxChars} characters]`;
}

/**
 * Build the single user message for the harness. The agent's system prompt
 * (its deployed instructions, or the admin override) carries the rules; the
 * request carries the material: report, sources, transcript, question.
 */
export function buildChatRequest(args: {
  reportMarkdown: string;
  reportVersion: number;
  sources: GroundingSource[];
  messages: ChatTurn[];
}): string {
  const { messages } = args;
  const question = messages[messages.length - 1]!.content;
  const prior = messages.slice(0, -1);
  const sections: string[] = [
    `# Report (version ${args.reportVersion})`,
    truncateText(args.reportMarkdown, CHAT_REPORT_MAX_CHARS, 'report'),
  ];
  if (args.sources.length > 0) {
    sections.push(
      `# Sources`,
      `The specialist task outputs the report was synthesised from. Cite these when the user asks where a fact came from.`,
    );
    let budget = CHAT_SOURCES_TOTAL_MAX_CHARS;
    for (const source of args.sources) {
      if (budget <= 0) {
        sections.push(`## ${source.name} (${source.taskId})`, `[omitted: grounding budget exhausted]`);
        continue;
      }
      const text = truncateText(
        source.text,
        Math.min(CHAT_SOURCE_MAX_CHARS, budget),
        'source',
      );
      budget -= text.length;
      sections.push(`## ${source.name} (${source.taskId})`, text);
    }
  }
  if (prior.length > 0) {
    sections.push(
      `# Conversation so far`,
      prior
        .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
        .join('\n\n'),
    );
  }
  sections.push(`# User message`, question);
  return sections.join('\n\n');
}

// The proposal body may itself contain fenced code (a table sample, say), so
// match to the LAST closing fence rather than the first.
const PROPOSAL_FENCE = /```edit-proposal\s*\n([\s\S]*)\n\s*```\s*$/;

/**
 * Decode the fenced proposal body. Preferred form is a small header block
 * plus RAW markdown:
 *
 *   heading: ## Executive summary
 *   rationale: why
 *   ---
 *   ## Executive summary
 *   …the full replacement, verbatim…
 *
 * Models cannot reliably JSON-escape ~2k chars of prose (live: ~1 in 3
 * proposals had a stray quote deep in `newMarkdown`), so raw markdown is
 * the contract. The original JSON form is still accepted.
 */
export function decodeProposalBody(
  body: string,
): { heading: string; newMarkdown: string; rationale?: string } | { error: string } {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        heading: typeof parsed.heading === 'string' ? parsed.heading : '',
        newMarkdown: typeof parsed.newMarkdown === 'string' ? parsed.newMarkdown : '',
        ...(typeof parsed.rationale === 'string' ? { rationale: parsed.rationale } : {}),
      };
    } catch {
      return { error: 'the assistant returned a malformed edit proposal' };
    }
  }
  const separator = /\n-{3,}\s*\n/.exec(trimmed);
  if (!separator) {
    return { error: 'the edit proposal was missing the "---" separator before the markdown' };
  }
  const header = trimmed.slice(0, separator.index);
  const newMarkdown = trimmed.slice(separator.index + separator[0].length);
  const field = (name: string) =>
    new RegExp(`^${name}:\\s*(.+)$`, 'mi').exec(header)?.[1]?.trim();
  return {
    heading: field('heading') ?? '',
    newMarkdown,
    ...(field('rationale') ? { rationale: field('rationale')! } : {}),
  };
}

export interface ParsedAnswer {
  /** The answer with the proposal block removed. */
  content: string;
  proposedEdit?: ProposedEdit;
  /** Why a present-but-unusable proposal was dropped (surfaced to the UI). */
  proposalIssue?: string;
}

/**
 * Split the harness reply into visible answer + validated proposal. The
 * proposal is validated against the CURRENT report so "Apply" is guaranteed
 * to splice.
 */
export function parseChatAnswer(raw: string, reportMarkdown: string): ParsedAnswer {
  const match = PROPOSAL_FENCE.exec(raw);
  if (!match) {
    return inferProposal(raw.trim(), reportMarkdown);
  }
  const content = raw.replace(PROPOSAL_FENCE, '').trim();
  const decoded = decodeProposalBody(match[1]!);
  if ('error' in decoded) {
    return { content, proposalIssue: decoded.error };
  }
  const heading = decoded.heading.trim();
  const newMarkdown = decoded.newMarkdown.trim();
  const rationale = decoded.rationale?.trim()
    ? decoded.rationale.trim().slice(0, 512)
    : undefined;
  if (!heading || !newMarkdown) {
    return { content, proposalIssue: 'the edit proposal was missing a heading or replacement' };
  }
  const splice = replaceReportSection(reportMarkdown, heading, newMarkdown);
  if (!splice.ok) {
    return { content, proposalIssue: `the edit proposal could not be applied: ${splice.error}` };
  }
  return {
    content,
    proposedEdit: { heading, newMarkdown, ...(rationale ? { rationale } : {}) },
  };
}

/** Minimum body size for an unfenced section rewrite to count as a proposal. */
const INFERRED_MIN_CHARS = 200;

/**
 * Fallback for replies that rewrite a section INLINE instead of in the fence
 * (live: the model sometimes narrates "here is the revised section:" and
 * pastes it as prose). A wall of rewritten text is unreadable in the chat
 * drawer and, worse, can't be diffed or applied. If the visible reply
 * contains a heading line that matches a report section, treat everything
 * from that heading to the end (or to the next heading of the same/higher
 * level) as the proposal, validate it the same way, and strip it from the
 * visible text so it shows up in the review diff instead.
 */
function inferProposal(content: string, reportMarkdown: string): ParsedAnswer {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const heading = /^(#{1,6})\s+\S/.exec(line);
    if (!heading) continue;
    const section = findReportSection(reportMarkdown, line);
    if (!section) continue;
    // Extend to the next heading of the same or higher level in the reply.
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = /^(#{1,6})\s+\S/.exec(lines[j]!.trim());
      if (next && next[1]!.length <= heading[1]!.length) {
        end = j;
        break;
      }
    }
    const body = lines.slice(i, end).join('\n').trim();
    if (body.length - line.length < INFERRED_MIN_CHARS) continue;
    // Use the report's exact heading line so the splice matches its level.
    const newMarkdown = `${section.heading}\n\n${body.slice(line.length).trim()}`;
    const splice = replaceReportSection(reportMarkdown, section.heading, newMarkdown);
    if (!splice.ok) continue;
    const visible = [...lines.slice(0, i), ...lines.slice(end)].join('\n').trim();
    return {
      content: visible,
      proposedEdit: {
        heading: section.heading,
        newMarkdown,
        rationale: 'Inferred from the reply — review the diff before saving.',
      },
    };
  }
  return { content };
}

// ── Shared grounding core (router sync route + streaming Function URL) ─────

/**
 * A run's report version list. Runs created before editing existed have no
 * list; synthesize v1 from reportArtifactKey so callers always see ≥1 entry.
 */
export function reportVersionsOf(run: Record<string, unknown>): ReportVersion[] {
  const stored = run.reportVersions;
  if (Array.isArray(stored) && stored.length > 0) {
    return stored as ReportVersion[];
  }
  return [
    {
      version: 1,
      artifactKey: String(run.reportArtifactKey ?? ''),
      savedAt: String(run.finishedAt ?? run.startedAt ?? ''),
    },
  ];
}

export async function readArtifact(
  bucket: string,
  key: string,
  maxChars?: number,
): Promise<string> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = (await object.Body?.transformToString()) ?? '';
  return maxChars === undefined ? body : body.slice(0, maxChars);
}

export interface ChatContext {
  runId: string;
  reportMarkdown: string;
  reportVersion: number;
  sources: GroundingSource[];
  /** Per-invocation overrides from the agent's runtime config (D-19). */
  systemPrompt?: string;
  model?: ResolvedModelInvocation;
}

export type ChatContextResult =
  | { ok: true; context: ChatContext }
  | { ok: false; status: number; error: string };

/**
 * Everything both chat handlers need before invoking the harness: the run
 * (404), its report (409 until one exists), the current version's markdown
 * plus every succeeded task's output (502 on artifact read failure), and the
 * report_chat agent's admin overrides.
 */
export async function loadChatContext(args: {
  tableName: string;
  bucketName: string;
  runId: string;
}): Promise<ChatContextResult> {
  const { tableName, bucketName, runId } = args;
  const run = await ddb.send(
    new GetCommand({ TableName: tableName, Key: tableKeys.run(runId) }),
  );
  if (!run.Item) {
    return { ok: false, status: 404, error: `run ${runId}` };
  }
  const reportKey =
    typeof run.Item.reportArtifactKey === 'string'
      ? run.Item.reportArtifactKey
      : undefined;
  if (!reportKey) {
    return {
      ok: false,
      status: 409,
      error:
        'this run has no report yet — a report is available once the run finishes (succeeded or partial)',
    };
  }
  const versions = reportVersionsOf(run.Item);
  const reportVersion = versions[versions.length - 1]!.version;

  let reportMarkdown: string;
  const sources: GroundingSource[] = [];
  try {
    reportMarkdown = await readArtifact(bucketName, reportKey);
    const tasks = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':sk': 'TASK#' },
      }),
    );
    const plan = run.Item.plan as
      | { tasks?: Array<{ id: string; name?: string }> }
      | undefined;
    const names = new Map(
      (plan?.tasks ?? []).map((task) => [task.id, task.name ?? task.id]),
    );
    for (const task of tasks.Items ?? []) {
      const taskId = String(task.taskId ?? '');
      if (
        taskId === REPORT_TASK_ID ||
        task.status !== 'succeeded' ||
        typeof task.artifactKey !== 'string'
      ) {
        continue;
      }
      sources.push({
        taskId,
        name: names.get(taskId) ?? taskId,
        text: await readArtifact(bucketName, task.artifactKey, CHAT_SOURCE_MAX_CHARS),
      });
    }
  } catch (error) {
    console.error('report-chat: grounding fetch failed', { runId, error });
    return {
      ok: false,
      status: 502,
      error: 'could not load the report artifacts for this run',
    };
  }

  const agentConfig = await loadAgentConfig(tableName, REPORT_CHAT_AGENT_NAME);
  const model = resolveModelInvocation(agentConfig);
  return {
    ok: true,
    context: {
      runId,
      reportMarkdown,
      reportVersion,
      sources,
      ...(agentConfig?.instructionsOverride
        ? { systemPrompt: agentConfig.instructionsOverride }
        : {}),
      ...(model ? { model } : {}),
    },
  };
}

/** The InvokeHarness arguments for a chat turn (shared by both handlers). */
export function chatInvocationArgs(
  harnessArn: string,
  context: ChatContext,
  messages: ChatTurn[],
) {
  return {
    harnessArn,
    // ONE SESSION PER TURN, deliberately. The request already carries all
    // the context a turn needs (report, sources, the client-held
    // transcript), so harness session memory adds nothing — and it is
    // harmful: a shared per-run session replays every prior turn's full
    // grounding payload into the model on each call. Live finding: after a
    // handful of turns one run's session hit 181,868 input tokens (vs 6,953
    // fresh), right at Haiku's context limit — the model returned an empty
    // answer and latencies had climbed into the 20–30s band that caused the
    // original 29s 500. Ids must be ≥33 chars.
    sessionId: `chat-${context.runId}-${randomUUID()}`.padEnd(33, '0'),
    text: buildChatRequest({
      reportMarkdown: context.reportMarkdown,
      reportVersion: context.reportVersion,
      sources: context.sources,
      messages,
    }),
    ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
    ...(context.model ? { model: context.model } : {}),
  };
}

/** The final chat payload both handlers return once the answer is complete. */
export function finalChatPayload(raw: string, context: ChatContext) {
  const parsed = parseChatAnswer(raw, context.reportMarkdown);
  return {
    message: {
      role: 'assistant' as const,
      content: parsed.content,
      ...(parsed.proposedEdit ? { proposedEdit: parsed.proposedEdit } : {}),
      ...(parsed.proposalIssue ? { proposalIssue: parsed.proposalIssue } : {}),
    },
    reportVersion: context.reportVersion,
  };
}

// ── Streaming: keep the edit-proposal block out of the visible stream ─────

const FENCE_OPEN = '```edit-proposal';

/**
 * Feed model deltas in; get back only the text that is safe to show live.
 * Once the proposal fence begins, everything after it is withheld (the
 * client receives the parsed proposal in the final `done` event instead).
 * A small tail is always held back so a fence split across deltas is never
 * partially emitted. Call `flush()` at the end to release the held tail
 * when no fence ever appeared.
 */
export class ProposalGate {
  private pending = '';
  /** True once the proposal fence has begun; visible output stops here. */
  public fenced = false;
  /** Everything received so far (for final parsing). */
  public collected = '';

  push(delta: string): string {
    this.collected += delta;
    if (this.fenced) {
      return '';
    }
    this.pending += delta;
    const fenceAt = this.pending.indexOf(FENCE_OPEN);
    if (fenceAt >= 0) {
      this.fenced = true;
      const visible = this.pending.slice(0, fenceAt);
      this.pending = '';
      return visible;
    }
    // Hold back enough to cover a fence opener split across deltas.
    const safeLength = Math.max(0, this.pending.length - (FENCE_OPEN.length - 1));
    // Never split inside a run of backticks — emit up to the last safe
    // boundary that isn't the start of a possible fence.
    let cut = safeLength;
    const tail = this.pending.slice(0, cut);
    const lastTick = tail.lastIndexOf('`');
    if (lastTick >= 0 && lastTick >= cut - FENCE_OPEN.length) {
      cut = lastTick;
    }
    const visible = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return visible;
  }

  flush(): string {
    if (this.fenced) {
      return '';
    }
    const visible = this.pending;
    this.pending = '';
    return visible;
  }
}
