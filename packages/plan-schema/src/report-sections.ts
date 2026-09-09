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
  const lines = markdown.split('\n');
  const previous = lines.slice(section.startLine, section.endLine).join('\n');
  const body = newMarkdown.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const isLast = section.endLine >= lines.length;
  const replacement = isLast ? [body] : [body, ''];
  const next = [
    ...lines.slice(0, section.startLine),
    ...replacement,
    ...lines.slice(section.endLine),
  ].join('\n');
  return { ok: true, markdown: next, previous };
}
