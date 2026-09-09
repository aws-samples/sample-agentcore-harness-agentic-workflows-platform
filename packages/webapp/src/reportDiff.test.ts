import { describe, expect, it } from 'vitest';
import {
  describeDiff,
  diffBlocks,
  diffMarkdown,
  splitMarkdownBlocks,
  summarizeDiff,
} from './reportDiff';

describe('splitMarkdownBlocks', () => {
  it('splits headings, paragraphs, list items, and table rows into blocks', () => {
    const md = [
      '## Risks',
      '',
      'First paragraph line one',
      'continues here.',
      '',
      '- item one',
      '- item two',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');
    expect(splitMarkdownBlocks(md)).toEqual([
      '## Risks',
      'First paragraph line one\ncontinues here.',
      '- item one',
      '- item two',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ]);
  });
  it('keeps a fenced code block as one block even with blank lines and # inside', () => {
    const md = 'Intro\n\n```js\nconst a = 1;\n\n# not a heading\n```\n\nOutro';
    expect(splitMarkdownBlocks(md)).toEqual([
      'Intro',
      '```js\nconst a = 1;\n\n# not a heading\n```',
      'Outro',
    ]);
  });
  it('keeps indented continuation text with its list item', () => {
    const md = '- item\n  more about the item\n- next';
    expect(splitMarkdownBlocks(md)).toEqual(['- item\n  more about the item', '- next']);
  });
});

describe('diffBlocks', () => {
  it('marks unchanged blocks equal and a rewritten paragraph as removed+added', () => {
    const ops = diffBlocks(['## H', 'old para', '- a'], ['## H', 'new para', '- a']);
    expect(ops).toEqual([
      { kind: 'equal', text: '## H' },
      { kind: 'removed', text: 'old para' },
      { kind: 'added', text: 'new para' },
      { kind: 'equal', text: '- a' },
    ]);
  });
  it('handles pure insertions and deletions at either end', () => {
    expect(diffBlocks(['a'], ['x', 'a', 'y'])).toEqual([
      { kind: 'added', text: 'x' },
      { kind: 'equal', text: 'a' },
      { kind: 'added', text: 'y' },
    ]);
    expect(diffBlocks(['x', 'a', 'y'], ['a'])).toEqual([
      { kind: 'removed', text: 'x' },
      { kind: 'equal', text: 'a' },
      { kind: 'removed', text: 'y' },
    ]);
  });
  it('ignores surrounding whitespace when matching', () => {
    expect(diffBlocks(['  a  '], ['a'])).toEqual([{ kind: 'equal', text: 'a' }]);
  });
});

describe('diffMarkdown + summary', () => {
  it('summarizes a section edit at block granularity', () => {
    const before = '## S\n\nOne two three.\n\n- keep\n- drop me';
    const after = '## S\n\nOne two three four five.\n\n- keep';
    const ops = diffMarkdown(before, after);
    expect(ops.map((op) => op.kind)).toEqual(['equal', 'removed', 'added', 'equal', 'removed']);
    const summary = summarizeDiff(ops);
    expect(summary).toEqual({
      blocksAdded: 1,
      blocksRemoved: 2,
      blocksUnchanged: 2,
      // "One two three four five." → 5 words
      wordsAdded: 5,
      // "One two three." → 3 words; "- drop me" → 3 whitespace tokens
      wordsRemoved: 6,
    });
    expect(describeDiff(summary)).toBe('2 blocks changed · +5 / −6 words');
  });
});
