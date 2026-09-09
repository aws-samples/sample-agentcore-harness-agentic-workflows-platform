import { describe, expect, it } from 'vitest';
import {
  extractReportSection,
  findReportSection,
  listReportSections,
  replaceReportSection,
} from '../src/report-sections';

const DOC = [
  '# Q2 Brief',
  '',
  '## Executive summary',
  '',
  'Revenue grew 12%.',
  '',
  '## Key findings',
  '',
  '### Premiumisation',
  '',
  'Up.',
  '',
  '### No/low',
  '',
  'Flat.',
  '',
  '```',
  '# not a heading',
  '```',
  '',
  '## Sources',
  '',
  '- a',
].join('\n');

describe('listReportSections', () => {
  it('finds headings with correct scopes and skips fenced code', () => {
    const sections = listReportSections(DOC);
    expect(sections.map((s) => s.heading)).toEqual([
      '# Q2 Brief',
      '## Executive summary',
      '## Key findings',
      '### Premiumisation',
      '### No/low',
      '## Sources',
    ]);
    const findings = sections.find((s) => s.heading === '## Key findings')!;
    // Key findings runs through both ### subsections up to ## Sources.
    expect(DOC.split('\n')[findings.endLine]).toBe('## Sources');
    const premium = sections.find((s) => s.heading === '### Premiumisation')!;
    expect(DOC.split('\n')[premium.endLine]).toBe('### No/low');
    // Last section extends to EOF.
    const sources = sections.find((s) => s.heading === '## Sources')!;
    expect(sources.endLine).toBe(DOC.split('\n').length);
  });
});

describe('findReportSection', () => {
  it('matches exact headings with whitespace normalization', () => {
    expect(findReportSection(DOC, '##   Executive summary ')?.heading).toBe(
      '## Executive summary',
    );
  });
  it('accepts a unique case-insensitive text match when the level is off', () => {
    expect(findReportSection(DOC, '# key findings')?.heading).toBe('## Key findings');
  });
  it('returns undefined for unknown or ambiguous headings', () => {
    expect(findReportSection(DOC, '## Nope')).toBeUndefined();
    const dup = '## A\n\nx\n\n## B\n\n### A\n\ny';
    // "A" appears at two levels → ambiguous under loose matching.
    expect(findReportSection(dup, '#### A')).toBeUndefined();
  });
});

describe('extractReportSection', () => {
  it('returns the heading through its body', () => {
    const section = findReportSection(DOC, '## Executive summary')!;
    expect(extractReportSection(DOC, section)).toBe(
      '## Executive summary\n\nRevenue grew 12%.\n',
    );
  });
});

describe('replaceReportSection', () => {
  it('replaces a middle section and preserves surrounding content', () => {
    const result = replaceReportSection(
      DOC,
      '## Executive summary',
      '## Executive summary\n\nRevenue grew 12% year on year.',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previous).toBe('## Executive summary\n\nRevenue grew 12%.\n');
    expect(result.markdown).toContain('# Q2 Brief\n\n## Executive summary\n\nRevenue grew 12% year on year.\n\n## Key findings');
    // Nothing else changed.
    expect(result.markdown).toContain('### No/low\n\nFlat.');
    expect(result.markdown.endsWith('## Sources\n\n- a')).toBe(true);
  });
  it('replaces the last section without adding a trailing blank line', () => {
    const result = replaceReportSection(DOC, '## Sources', '## Sources\n\n- b\n\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown.endsWith('## Sources\n\n- b')).toBe(true);
  });
  it('allows renaming the heading text and deeper sub-headings', () => {
    const result = replaceReportSection(
      DOC,
      '## Key findings',
      '## Key themes\n\n### One\n\nx\n\n#### Deeper\n\ny',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('## Key themes\n\n### One');
    expect(result.markdown).not.toContain('### Premiumisation');
    expect(result.markdown).toContain('\n\n## Sources');
  });
  it('rejects missing heading, wrong level, and scope-breaking sub-headings', () => {
    expect(replaceReportSection(DOC, '## Executive summary', 'just text').ok).toBe(false);
    expect(
      replaceReportSection(DOC, '## Executive summary', '# Executive summary\n\nx').ok,
    ).toBe(false);
    expect(
      replaceReportSection(DOC, '### Premiumisation', '### Premiumisation\n\nx\n\n## Sneaky').ok,
    ).toBe(false);
    expect(replaceReportSection(DOC, '## Nope', '## Nope\n\nx').ok).toBe(false);
  });
});
