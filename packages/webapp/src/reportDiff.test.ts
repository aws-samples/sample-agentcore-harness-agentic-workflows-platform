import { describe, expect, it } from 'vitest';
import {
  describeDiff,
  diffBlocks,
  diffMarkdown,
  removesMostContent,
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

import { composeFromHunks, groupHunks, joinBlocks, wordDiffMarkdown } from './reportDiff';

describe('groupHunks + composeFromHunks', () => {
  const before = '## S\n\nIntro.\n\nOld para.\n\n- keep\n- drop';
  const after = '## S\n\nIntro.\n\nNew para.\n\n- keep\n\nAdded tail.';
  it('groups alternating equal/change hunks', () => {
    const hunks = groupHunks(diffMarkdown(before, after));
    expect(hunks.map((h) => h.kind)).toEqual(['equal', 'change', 'equal', 'change']);
    expect(hunks[1]).toEqual({ kind: 'change', removed: ['Old para.'], added: ['New para.'] });
    expect(hunks[3]).toEqual({ kind: 'change', removed: ['- drop'], added: ['Added tail.'] });
  });
  it('accepting every hunk reproduces the proposal; rejecting every hunk reproduces the current text', () => {
    const hunks = groupHunks(diffMarkdown(before, after));
    expect(composeFromHunks(hunks, [true, true])).toBe(after);
    expect(composeFromHunks(hunks, [false, false])).toBe(before);
  });
  it('mixes decisions per hunk', () => {
    const hunks = groupHunks(diffMarkdown(before, after));
    expect(composeFromHunks(hunks, [true, false])).toBe(
      '## S\n\nIntro.\n\nNew para.\n\n- keep\n- drop',
    );
  });
  it('joinBlocks keeps lists and tables tight and paragraphs spaced', () => {
    expect(joinBlocks(['a', '- x', '- y', 'b', '| c |', '|---|'])).toBe(
      'a\n\n- x\n- y\n\nb\n\n| c |\n|---|',
    );
  });
});

describe('wordDiffMarkdown', () => {
  it('marks changed words with del/ins and leaves the rest untouched', () => {
    const merged = wordDiffMarkdown(
      'Revenue grew **12%** in Q2, driven by premium wines.',
      'Revenue grew **14%** in Q2, driven mainly by premium wines.',
    );
    expect(merged).toBe(
      'Revenue grew **<del>12</del><ins>14</ins>%** in Q2, driven <ins>mainly </ins>by premium wines.',
    );
  });
  it('returns null when the paragraphs are essentially different', () => {
    expect(
      wordDiffMarkdown('Alpha beta gamma delta epsilon.', 'Completely unrelated sentence here now.'),
    ).toBeNull();
  });
  it('handles pure appends and removals', () => {
    expect(wordDiffMarkdown('One two three.', 'One two three. Four.')).toBe(
      'One two three.<ins> Four.</ins>',
    );
    expect(wordDiffMarkdown('One two three. Four.', 'One two three.')).toBe(
      'One two three.<del> Four.</del>',
    );
  });
});

describe('removesMostContent', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  it('flags a replacement that keeps under 30% of the words', () => {
    expect(removesMostContent(`## S\n\n${words(100)}`, '## S\n\nshort.')).toBe(true);
    expect(removesMostContent(`## S\n\n${words(100)}`, `## S\n\n${words(25)}`)).toBe(true);
  });
  it('does not flag ordinary rewrites, including halving a section', () => {
    expect(removesMostContent(`## S\n\n${words(100)}`, `## S\n\n${words(50)}`)).toBe(false);
    expect(removesMostContent(`## S\n\n${words(100)}`, `## S\n\n${words(120)}`)).toBe(false);
  });
  it('ignores tiny sections such as a title line', () => {
    expect(removesMostContent('# Solera Estates Brief', '# Company X Brief')).toBe(false);
  });
});
