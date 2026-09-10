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

import { applySectionEdits } from '../src/report-sections';

describe('applySectionEdits', () => {
  it('applies several section edits at once, preserving everything else', () => {
    const result = applySectionEdits(DOC, [
      { heading: '## Sources', newMarkdown: '## Sources\n\n- b' },
      { heading: '## Executive summary', newMarkdown: '## Executive summary\n\nUp 12% YoY.' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('# Q2 Brief\n\n## Executive summary\n\nUp 12% YoY.\n\n## Key findings');
    expect(result.markdown).toContain('### No/low\n\nFlat.');
    expect(result.markdown.endsWith('## Sources\n\n- b')).toBe(true);
  });
  it('resolves headings against the original document regardless of edit order', () => {
    // Editing an earlier section that grows must not shift the later target.
    const result = applySectionEdits(DOC, [
      {
        heading: '## Executive summary',
        newMarkdown: '## Executive summary\n\nA\n\nB\n\nC\n\nD\n\nE',
      },
      { heading: '### No/low', newMarkdown: '### No/low\n\nDown.' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The No/low section spans through the fenced block (up to ## Sources),
    // so the whole thing is replaced.
    expect(result.markdown).toContain('### No/low\n\nDown.\n\n## Sources');
    expect(result.markdown).not.toContain('# not a heading');
    expect(result.markdown).toContain('### Premiumisation\n\nUp.');
  });
  it('reports the failing edit by index', () => {
    const missing = applySectionEdits(DOC, [
      { heading: '## Sources', newMarkdown: '## Sources\n\n- b' },
      { heading: '## Nope', newMarkdown: '## Nope\n\nx' },
    ]);
    expect(missing).toEqual({ ok: false, index: 1, error: 'section not found: "## Nope"' });
    const duplicate = applySectionEdits(DOC, [
      { heading: '## Sources', newMarkdown: '## Sources\n\n- b' },
      { heading: '## Sources', newMarkdown: '## Sources\n\n- c' },
    ]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toMatch(/same section/);
    const badLevel = applySectionEdits(DOC, [
      { heading: '## Sources', newMarkdown: '# Sources\n\n- b' },
    ]);
    expect(badLevel.ok).toBe(false);
  });
});

import { editTarget } from '../src/report-sections';

describe('editing a section that contains sub-sections', () => {
  it('renaming the title replaces only the title line, never the whole report (live finding)', () => {
    const title = findReportSection(DOC, '# Q2 Brief')!;
    expect(title.endLine).toBe(DOC.split('\n').length); // the # range IS the whole doc
    const target = editTarget(DOC, title, '# Company X Q2 Brief');
    expect([target.startLine, target.endLine]).toEqual([0, 1]);

    const result = replaceReportSection(DOC, '# Q2 Brief', '# Company X Q2 Brief');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previous).toBe('# Q2 Brief');
    expect(result.markdown).toBe(DOC.replace('# Q2 Brief', '# Company X Q2 Brief'));
  });

  it('a heading-only replacement renames a section and keeps its body and children', () => {
    // A byline under the title (the live report has one) must survive a rename.
    const withByline = DOC.replace('# Q2 Brief\n', '# Q2 Brief\n\n**Prepared for the Board**\n');
    const title = replaceReportSection(withByline, '# Q2 Brief', '# Company X Brief');
    expect(title.ok).toBe(true);
    if (!title.ok) return;
    expect(title.markdown.startsWith('# Company X Brief\n\n**Prepared for the Board**\n\n## Executive summary')).toBe(true);

    const parent = replaceReportSection(DOC, '## Key findings', '## What we found');
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    expect(parent.markdown).toContain('## What we found\n\n### Premiumisation\n\nUp.\n\n### No/low');
    expect(parent.markdown.split('\n').length).toBe(DOC.split('\n').length);
  });

  it('a replacement without sub-headings edits the parent’s own text and keeps its children', () => {
    const result = replaceReportSection(DOC, '## Key findings', '## Key findings\n\nIntro line.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('## Key findings\n\nIntro line.\n\n### Premiumisation\n\nUp.');
    expect(result.markdown).toContain('### No/low\n\nFlat.');
  });

  it('a replacement WITH sub-headings restructures the whole range, as written', () => {
    const result = replaceReportSection(
      DOC,
      '## Key findings',
      '## Key findings\n\n### Merged\n\nUp, then flat.',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('### Merged\n\nUp, then flat.\n\n## Sources');
    expect(result.markdown).not.toContain('### Premiumisation');
    expect(result.markdown).not.toContain('### No/low');
  });

  it('title rename plus ordinary section edits apply together (the reported request)', () => {
    const result = applySectionEdits(DOC, [
      { heading: '# Q2 Brief', newMarkdown: '# Company X Q2 Brief' },
      { heading: '## Sources', newMarkdown: '## Sources\n\n- Company X internal brief' },
      { heading: '### Premiumisation', newMarkdown: '### Premiumisation\n\nUp (Company X).' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown.startsWith('# Company X Q2 Brief\n\n## Executive summary')).toBe(true);
    expect(result.markdown).toContain('### Premiumisation\n\nUp (Company X).\n\n### No/low');
    expect(result.markdown.endsWith('## Sources\n\n- Company X internal brief')).toBe(true);
    expect(result.markdown.split('\n').length).toBe(DOC.split('\n').length);
  });

  it('rejects a whole-range parent rewrite combined with an edit inside it', () => {
    const result = applySectionEdits(DOC, [
      { heading: '## Key findings', newMarkdown: '## Key findings\n\n### Merged\n\nx' },
      { heading: '### No/low', newMarkdown: '### No/low\n\nFlat still.' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.index).toBe(1);
    expect(result.error).toMatch(/overlaps/);
  });
});
