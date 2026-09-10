/**
 * Markdown section helpers for report editing.
 *
 * Edits are SECTION-SCOPED: a section is an ATX heading line (`#`…`######`)
 * plus everything down to, but not including, the next heading of the same
 * or higher level. Headings are the stable anchor the chat agent, the API,
 * and the web app all agree on. Fenced code blocks are skipped so a `#`
 * inside a code sample is never mistaken for a heading.
 */

export interface ReportSection {
  /** The heading line verbatim, e.g. "## Executive summary". */
  heading: string;
  level: number;
  /** 0-based line index of the heading. */
  startLine: number;
  /** Exclusive 0-based end line (start of the next same-or-higher heading). */
  endLine: number;
}

const HEADING = /^(#{1,6})\s+\S/;
const FENCE = /^\s*(```|~~~)/;

/** Enumerate sections in document order. */
export function listReportSections(markdown: string): ReportSection[] {
  const lines = markdown.split('\n');
  const headings: Array<{ line: number; level: number; text: string }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = HEADING.exec(line);
    if (match) {
      headings.push({ line: i, level: match[1]!.length, text: line.trimEnd() });
    }
  }
  return headings.map((heading, index) => {
    let endLine = lines.length;
    for (let j = index + 1; j < headings.length; j++) {
      if (headings[j]!.level <= heading.level) {
        endLine = headings[j]!.line;
        break;
      }
    }
    return {
      heading: heading.text,
      level: heading.level,
      startLine: heading.line,
      endLine,
    };
  });
}

/** Normalize a heading for matching: trim, collapse inner whitespace. */
export function normalizeHeading(heading: string): string {
  return heading.trim().replace(/\s+/g, ' ');
}

/**
 * Find a section by heading. Exact (normalized) match first; when the
 * document has exactly one heading whose text (sans `#`) matches
 * case-insensitively, accept that too — agents sometimes drop a `#` level.
 */
export function findReportSection(
  markdown: string,
  heading: string,
): ReportSection | undefined {
  const sections = listReportSections(markdown);
  const wanted = normalizeHeading(heading);
  const exact = sections.find((section) => normalizeHeading(section.heading) === wanted);
  if (exact) {
    return exact;
  }
  const wantedText = wanted.replace(/^#+\s*/, '').toLowerCase();
  const loose = sections.filter(
    (section) =>
      normalizeHeading(section.heading).replace(/^#+\s*/, '').toLowerCase() ===
      wantedText,
  );
  return loose.length === 1 ? loose[0] : undefined;
}

/** The section's markdown (heading line through its last body line). */
export function extractReportSection(
  markdown: string,
  section: ReportSection,
): string {
  return markdown.split('\n').slice(section.startLine, section.endLine).join('\n');
}

/**
 * The line range a replacement actually stands in for.
 *
 * A section's full range runs to the next heading of the same or higher
 * level, so it CONTAINS its sub-sections — and the `#` title's range is the
 * whole document. A replacement that carries no sub-headings is therefore
 * read as the section's OWN text (heading + body up to its first
 * sub-heading), and the children are kept. A replacement that does include
 * sub-headings restructures the whole range, as written.
 *
 * Live finding: "rename the company in the title" produced a heading-only
 * replacement for the `#` section, which the old whole-range rule turned
 * into "delete the entire report" (+13 / −2355 words in review).
 */
export function editTarget(
  markdown: string,
  section: ReportSection,
  newMarkdown: string,
): ReportSection {
  const firstChild = listReportSections(markdown).find(
    (other) => other.startLine > section.startLine && other.startLine < section.endLine,
  );
  if (!firstChild) {
    return section;
  }
  const replacementHasSubheadings = listReportSections(newMarkdown).length > 1;
  return replacementHasSubheadings ? section : { ...section, endLine: firstChild.startLine };
}

export interface ReplaceSectionResult {
  ok: true;
  markdown: string;
  /** The text that was replaced (for diff display). */
  previous: string;
}
export interface ReplaceSectionError {
  ok: false;
  error: string;
}

/**
 * Replace one section with new markdown. The replacement must begin with a
 * heading of the SAME level so the document outline stays intact (its text
 * may change — renaming a section is a legitimate edit). Trailing blank
 * lines are normalized to keep exactly one blank line before the next
 * heading.
 */
export function replaceReportSection(
  markdown: string,
  heading: string,
  newMarkdown: string,
): ReplaceSectionResult | ReplaceSectionError {
  const section = findReportSection(markdown, heading);
  if (!section) {
    return { ok: false, error: `section not found: "${normalizeHeading(heading)}"` };
  }
  const replacementLines = newMarkdown.replace(/\r\n/g, '\n').split('\n');
  const firstLine = replacementLines.find((line) => line.trim().length > 0);
  const match = firstLine ? HEADING.exec(firstLine) : null;
  if (!match) {
    return {
      ok: false,
      error: 'replacement must start with the section heading line',
    };
  }
  if (match[1]!.length !== section.level) {
    return {
      ok: false,
      error: `replacement heading level (${match[1]!.length}) must match the section's (${section.level})`,
    };
  }
  // Disallow nested headings that would break out of the section's scope.
  const innerSections = listReportSections(newMarkdown);
  if (innerSections.slice(1).some((inner) => inner.level <= section.level)) {
    return {
      ok: false,
      error: 'replacement may only contain sub-headings deeper than the section itself',
    };
  }
  const target = editTarget(markdown, section, newMarkdown);
  const lines = markdown.split('\n');
  const previous = lines.slice(target.startLine, target.endLine).join('\n');
  return { ok: true, markdown: splice(lines, target, newMarkdown).join('\n'), previous };
}

/** Replace `target`'s lines with `newMarkdown`, keeping one blank line before what follows. */
function splice(lines: string[], target: ReportSection, newMarkdown: string): string[] {
  const body = newMarkdown.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const isLast = target.endLine >= lines.length;
  return [
    ...lines.slice(0, target.startLine),
    ...(isLast ? [body] : [body, '']),
    ...lines.slice(target.endLine),
  ];
}

/** One section-scoped edit in a multi-section proposal. */
export interface SectionEdit {
  heading: string;
  newMarkdown: string;
  rationale?: string;
}

export interface ApplyEditsResult {
  ok: true;
  markdown: string;
}
export interface ApplyEditsError {
  ok: false;
  /** Which edit failed (index into the input) and why. */
  index: number;
  error: string;
}

/**
 * Apply several section edits to one document, in order. Each edit is
 * resolved against the document AS MODIFIED by the previous edits, so an
 * edit that renames a heading doesn't break a later edit that targets the
 * original name — callers pass headings from the ORIGINAL document, and we
 * resolve them there first, then splice by line range in the working copy.
 * Two edits targeting the same section is an error (ambiguous intent).
 */
export function applySectionEdits(
  markdown: string,
  edits: SectionEdit[],
): ApplyEditsResult | ApplyEditsError {
  // Resolve every target against the original, bottom-up so earlier line
  // ranges stay valid while later ones are spliced.
  const resolved: Array<{ index: number; section: ReportSection; target: ReportSection; edit: SectionEdit }> = [];
  for (const [index, edit] of edits.entries()) {
    const section = findReportSection(markdown, edit.heading);
    if (!section) {
      return { ok: false, index, error: `section not found: "${normalizeHeading(edit.heading)}"` };
    }
    if (resolved.some((r) => r.section.startLine === section.startLine)) {
      return {
        ok: false,
        index,
        error: `two edits target the same section "${section.heading}"`,
      };
    }
    // Validate the replacement's shape against the original section now.
    const check = replaceReportSection(markdown, edit.heading, edit.newMarkdown);
    if (!check.ok) {
      return { ok: false, index, error: check.error };
    }
    const target = editTarget(markdown, section, edit.newMarkdown);
    // A whole-range replacement swallows any other edit inside that range
    // (e.g. rewriting a parent with new sub-headings AND editing one of its
    // old sub-sections) — the two cannot both be honoured.
    const overlap = resolved.find(
      (r) =>
        (target.startLine < r.target.endLine && r.target.startLine < target.endLine),
    );
    if (overlap) {
      return {
        ok: false,
        index,
        error: `edit for "${section.heading}" overlaps the edit for "${overlap.section.heading}"`,
      };
    }
    resolved.push({ index, section, target, edit });
  }
  resolved.sort((a, b) => b.target.startLine - a.target.startLine);
  let lines = markdown.split('\n');
  for (const { target, edit } of resolved) {
    lines = splice(lines, target, edit.newMarkdown);
  }
  return { ok: true, markdown: lines.join('\n') };
}
