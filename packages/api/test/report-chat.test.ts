import { describe, expect, it } from 'vitest';
import {
  CHAT_REPORT_MAX_CHARS,
  CHAT_SOURCES_TOTAL_MAX_CHARS,
  buildChatRequest,
  parseChatAnswer,
} from '../handlers-src/lib/report-chat';

const REPORT = '# Brief\n\n## Executive summary\n\nRevenue grew 12%.\n\n## Sources\n\n- a';

describe('buildChatRequest', () => {
  it('lays out report, sources, transcript, and the user message', () => {
    const text = buildChatRequest({
      reportMarkdown: REPORT,
      reportVersion: 3,
      sources: [{ taskId: 't1', name: 'Competitor scan', text: 'Rival cut prices.' }],
      messages: [
        { role: 'user', content: 'Summarize' },
        { role: 'assistant', content: 'It grew.' },
        { role: 'user', content: 'Why?' },
      ],
    });
    const order = [
      '# Report (version 3)',
      'Revenue grew 12%.',
      '# Sources',
      '## Competitor scan (t1)',
      'Rival cut prices.',
      '# Conversation so far',
      'User: Summarize',
      'Assistant: It grew.',
      '# User message',
      'Why?',
    ].map((needle) => text.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.trim().endsWith('Why?')).toBe(true);
  });
  it('omits the sources and transcript sections when empty', () => {
    const text = buildChatRequest({
      reportMarkdown: REPORT,
      reportVersion: 1,
      sources: [],
      messages: [{ role: 'user', content: 'q' }],
    });
    // The report itself contains "## Sources"; the request-level section
    // header is a top-level "# Sources" line, which must be absent.
    expect(text).not.toMatch(/^# Sources$/m);
    expect(text).not.toContain('# Conversation so far');
  });
  it('truncates the report and enforces the total sources budget', () => {
    const text = buildChatRequest({
      reportMarkdown: 'x'.repeat(CHAT_REPORT_MAX_CHARS + 10),
      reportVersion: 1,
      sources: Array.from({ length: 8 }, (_, i) => ({
        taskId: `t${i}`,
        name: `T${i}`,
        text: 'Ω'.repeat(20_000),
      })),
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(text).toContain(`[report truncated at ${CHAT_REPORT_MAX_CHARS} characters]`);
    // 8 × 20k = 160k requested; only ~90k may be injected, the rest omitted.
    expect(text).toContain('[omitted: grounding budget exhausted]');
    const injected = (text.match(/Ω+/g) ?? []).reduce((n, run) => n + run.length, 0);
    expect(injected).toBeLessThanOrEqual(CHAT_SOURCES_TOTAL_MAX_CHARS);
  });
});

describe('parseChatAnswer', () => {
  it('returns plain answers untouched', () => {
    expect(parseChatAnswer('  Revenue grew 12%.  ', REPORT)).toEqual({
      content: 'Revenue grew 12%.',
    });
  });
  it('extracts and validates a well-formed proposal', () => {
    const raw = [
      'Tightened the summary.',
      '',
      '```edit-proposal',
      JSON.stringify({
        heading: '## Executive summary',
        newMarkdown: '## Executive summary\n\nRevenue grew 12% year on year.',
        rationale: 'Adds the comparison basis.',
      }),
      '```',
    ].join('\n');
    const parsed = parseChatAnswer(raw, REPORT);
    expect(parsed.content).toBe('Tightened the summary.');
    expect(parsed.proposalIssue).toBeUndefined();
    expect(parsed.proposedEdit).toEqual({
      heading: '## Executive summary',
      newMarkdown: '## Executive summary\n\nRevenue grew 12% year on year.',
      rationale: 'Adds the comparison basis.',
    });
  });
  it('extracts the raw-markdown proposal form (header block + --- + markdown)', () => {
    const raw = [
      'Tightened the summary.',
      '',
      '```edit-proposal',
      'heading: ## Executive summary',
      'rationale: Adds the "comparison basis" — with quotes, unescaped.',
      '---',
      '## Executive summary',
      '',
      'Revenue grew 12% "year on year" and here\'s a table:',
      '',
      '```',
      'a | b',
      '```',
      '```',
    ].join('\n');
    const parsed = parseChatAnswer(raw, REPORT);
    expect(parsed.content).toBe('Tightened the summary.');
    expect(parsed.proposalIssue).toBeUndefined();
    expect(parsed.proposedEdit).toEqual({
      heading: '## Executive summary',
      rationale: 'Adds the "comparison basis" — with quotes, unescaped.',
      newMarkdown:
        '## Executive summary\n\nRevenue grew 12% "year on year" and here\'s a table:\n\n```\na | b\n```',
    });
  });

  it('reports a raw-form proposal with no separator as an issue', () => {
    const parsed = parseChatAnswer(
      'x\n```edit-proposal\nheading: ## Sources\n## Sources\n\ny\n```',
      REPORT,
    );
    expect(parsed.proposedEdit).toBeUndefined();
    expect(parsed.proposalIssue).toMatch(/separator/);
  });

  it('drops proposals that cannot be applied, keeping the answer', () => {
    const unknownHeading = parseChatAnswer(
      'x\n```edit-proposal\n{"heading":"## Nope","newMarkdown":"## Nope\\n\\ny"}\n```',
      REPORT,
    );
    expect(unknownHeading.content).toBe('x');
    expect(unknownHeading.proposedEdit).toBeUndefined();
    expect(unknownHeading.proposalIssue).toMatch(/section not found/);

    const malformed = parseChatAnswer('x\n```edit-proposal\n{not json\n```', REPORT);
    expect(malformed.proposedEdit).toBeUndefined();
    expect(malformed.proposalIssue).toMatch(/malformed/);

    const missingField = parseChatAnswer(
      'x\n```edit-proposal\n{"heading":"## Sources"}\n```',
      REPORT,
    );
    expect(missingField.proposalIssue).toMatch(/missing/);
  });
});
