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
import { replaceReportSection } from '@agentic-platform/plan-schema';

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

const PROPOSAL_FENCE = /```edit-proposal\s*\n([\s\S]*?)\n\s*```/;

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
    return { content: raw.trim() };
  }
  const content = raw.replace(PROPOSAL_FENCE, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return { content, proposalIssue: 'the assistant returned a malformed edit proposal' };
  }
  const candidate = (parsed ?? {}) as Record<string, unknown>;
  const heading = typeof candidate.heading === 'string' ? candidate.heading.trim() : '';
  const newMarkdown =
    typeof candidate.newMarkdown === 'string' ? candidate.newMarkdown.trim() : '';
  const rationale =
    typeof candidate.rationale === 'string' && candidate.rationale.trim()
      ? candidate.rationale.trim().slice(0, 512)
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
