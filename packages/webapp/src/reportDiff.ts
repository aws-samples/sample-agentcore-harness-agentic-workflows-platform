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

// ── Hunks: group changes so each can be accepted or rejected on its own ────

export type Hunk =
  | { kind: 'equal'; blocks: string[] }
  | { kind: 'change'; removed: string[]; added: string[] };

/** Collapse a flat op list into alternating equal / change hunks. */
export function groupHunks(ops: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  for (const op of ops) {
    const last = hunks[hunks.length - 1];
    if (op.kind === 'equal') {
      if (last?.kind === 'equal') last.blocks.push(op.text);
      else hunks.push({ kind: 'equal', blocks: [op.text] });
    } else {
      if (last?.kind === 'change') {
        (op.kind === 'removed' ? last.removed : last.added).push(op.text);
      } else {
        hunks.push({
          kind: 'change',
          removed: op.kind === 'removed' ? [op.text] : [],
          added: op.kind === 'added' ? [op.text] : [],
        });
      }
    }
  }
  return hunks;
}

/**
 * Rebuild section markdown from hunks given per-change-hunk decisions
 * (true = take the proposed text, false = keep the current text). Blocks are
 * joined with blank lines, which is how splitMarkdownBlocks separated them;
 * consecutive list items / table rows are re-joined with single newlines so
 * lists and tables stay intact.
 */
export function composeFromHunks(hunks: Hunk[], accepted: boolean[]): string {
  const blocks: string[] = [];
  let changeIndex = 0;
  for (const hunk of hunks) {
    if (hunk.kind === 'equal') {
      blocks.push(...hunk.blocks);
    } else {
      blocks.push(...(accepted[changeIndex] ?? true ? hunk.added : hunk.removed));
      changeIndex++;
    }
  }
  return joinBlocks(blocks);
}

const TIGHT = /^\s*(?:[-*+]|\d+[.)])\s+|^\s*\|/;

export function joinBlocks(blocks: string[]): string {
  let out = '';
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (i === 0) {
      out = block;
      continue;
    }
    const previous = blocks[i - 1]!;
    const tight =
      TIGHT.test(block) && TIGHT.test(previous.split('\n').pop()!) &&
      // list→table or table→list boundaries still get a blank line
      /^\s*\|/.test(block) === /^\s*\|/.test(previous);
    out += (tight ? '\n' : '\n\n') + block;
  }
  return out;
}

// ── Word-level diff inside a changed paragraph ─────────────────────────────

/**
 * Merge an old and new block into one markdown string with removed words in
 * <del> and added words in <ins>. marked passes inline HTML through and
 * DOMPurify allows del/ins, so surrounding markdown (bold, links, list
 * markers) still renders. Returns null when the two texts share too little
 * to read as one edited paragraph — callers then show them stacked.
 */
export function wordDiffMarkdown(before: string, after: string): string | null {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return null;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  // Similarity on word tokens only (ignore whitespace tokens).
  const words = (tokens: string[]) => tokens.filter((t) => !/^\s+$/.test(t)).length;
  const common = lcs[0]![0]!;
  const commonWords = countCommonWords(a, b, lcs);
  if (commonWords / Math.max(words(a), words(b)) < 0.3) return null;
  void common;

  let out = '';
  let del = '';
  let ins = '';
  const flush = () => {
    if (del) out += `<del>${del}</del>`;
    if (ins) out += `<ins>${ins}</ins>`;
    del = '';
    ins = '';
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      out += a[i];
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      del += a[i++];
    } else {
      ins += b[j++];
    }
  }
  while (i < n) del += a[i++];
  while (j < m) ins += b[j++];
  flush();
  // Whitespace-only del/ins are noise; drop them.
  return out.replace(/<(del|ins)>(\s*)<\/\1>/g, '$2');
}

function tokenize(text: string): string[] {
  // Words, punctuation runs, and whitespace runs as separate tokens so a
  // changed comma or a merged sentence diffs cleanly.
  return text.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]+/gu) ?? [];
}

function countCommonWords(a: string[], b: string[], lcs: number[][]): number {
  let i = 0;
  let j = 0;
  let count = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      if (!/^\s+$/.test(a[i]!)) count++;
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  return count;
}
