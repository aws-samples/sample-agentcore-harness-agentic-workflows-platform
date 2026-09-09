/**
 * Block-level Markdown diff for reviewing edit proposals in place.
 *
 * A word diff on Markdown source breaks rendering (stray `**` and `|`
 * fragments end up tinted). Instead we split each version into blocks —
 * paragraphs, individual list items, table rows, headings, whole fenced code
 * blocks — diff the block sequences, and render every block through the
 * normal Markdown renderer with a coloured gutter. Unchanged blocks render
 * as-is; a rewritten paragraph shows as its old block (removed) followed by
 * the new one (added). Every block stays real, rendered Markdown.
 */

export type DiffKind = 'equal' | 'removed' | 'added';

export interface DiffOp {
  kind: DiffKind;
  /** The block's markdown, exactly as it appears in its version. */
  text: string;
}

export interface DiffSummary {
  blocksAdded: number;
  blocksRemoved: number;
  blocksUnchanged: number;
  wordsAdded: number;
  wordsRemoved: number;
}

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|/;
const HEADING = /^#{1,6}\s/;

/**
 * Split markdown into diffable blocks. Paragraph text is joined across its
 * lines; list items and table rows are one block each so a single edited
 * bullet doesn't mark the whole list as changed. A fenced code block is one
 * block regardless of its contents.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(paragraph.join('\n'));
      paragraph = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      flushParagraph();
      const fence: string[] = [line];
      const marker = FENCE.exec(line)![1]!;
      i++;
      while (i < lines.length) {
        fence.push(lines[i]!);
        if (lines[i]!.trim().startsWith(marker)) {
          break;
        }
        i++;
      }
      blocks.push(fence.join('\n'));
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    if (HEADING.test(line) || LIST_ITEM.test(line) || TABLE_ROW.test(line)) {
      flushParagraph();
      blocks.push(line);
      continue;
    }
    // Continuation of a list item (indented text under a bullet) stays with
    // the item so the pair moves together.
    if (/^\s{2,}\S/.test(line) && blocks.length > 0 && paragraph.length === 0) {
      const previous = blocks[blocks.length - 1]!;
      if (LIST_ITEM.test(previous.split('\n')[0]!)) {
        blocks[blocks.length - 1] = `${previous}\n${line}`;
        continue;
      }
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

/**
 * Longest-common-subsequence diff over two block sequences. Sections are
 * small (tens of blocks), so the O(n·m) table is fine and keeps us free of a
 * diff dependency in the browser bundle.
 */
export function diffBlocks(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const norm = (s: string) => s.trim();
  // lcs[i][j] = LCS length of before[i..] and after[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        norm(before[i]!) === norm(after[j]!)
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(before[i]!) === norm(after[j]!)) {
      ops.push({ kind: 'equal', text: after[j]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: 'removed', text: before[i]! });
      i++;
    } else {
      ops.push({ kind: 'added', text: after[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'removed', text: before[i++]! });
  while (j < m) ops.push({ kind: 'added', text: after[j++]! });
  return ops;
}

/** Convenience: diff two markdown fragments at block granularity. */
export function diffMarkdown(before: string, after: string): DiffOp[] {
  return diffBlocks(splitMarkdownBlocks(before), splitMarkdownBlocks(after));
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

export function summarizeDiff(ops: DiffOp[]): DiffSummary {
  const summary: DiffSummary = {
    blocksAdded: 0,
    blocksRemoved: 0,
    blocksUnchanged: 0,
    wordsAdded: 0,
    wordsRemoved: 0,
  };
  for (const op of ops) {
    if (op.kind === 'added') {
      summary.blocksAdded++;
      summary.wordsAdded += wordCount(op.text);
    } else if (op.kind === 'removed') {
      summary.blocksRemoved++;
      summary.wordsRemoved += wordCount(op.text);
    } else {
      summary.blocksUnchanged++;
    }
  }
  return summary;
}

/** "3 blocks changed · +120 / −85 words" */
export function describeDiff(summary: DiffSummary): string {
  const changed = Math.max(summary.blocksAdded, summary.blocksRemoved);
  const blocks = `${changed} block${changed === 1 ? '' : 's'} changed`;
  return `${blocks} · +${summary.wordsAdded} / −${summary.wordsRemoved} words`;
}
