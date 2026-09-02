/**
 * Temporal grounding for runtime-composed agent messages.
 *
 * Models default to their training-cutoff year when interpreting "recent",
 * "latest", or "current" — without an explicit date they plan searches and
 * frame reports around the wrong year. Every message the planner client or
 * interpreter composes must therefore carry this context block.
 *
 * Deliberately injected at runtime, NOT into the CDK-baked harness system
 * prompts: a date baked at synth time would freeze at the deploy date and go
 * stale. Kept dependency-free so planner-client.ts stays light.
 */

/** Human-readable UTC date line, e.g. "Today's date is Friday, August 28, 2026." */
export function currentDateLine(now: Date = new Date()): string {
  const formatted = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return `Today's date is ${formatted}.`;
}

/**
 * Full grounding sentence for a message's `# Context` section: the date plus
 * the instruction to trust it over the model's internal sense of "now".
 */
export function temporalGroundingBlock(now: Date = new Date()): string {
  return [
    currentDateLine(now),
    'Anchor every time reference to this date: "recent", "latest", and',
    '"current" mean relative to today, not to your training data. Treat your',
    'built-in sense of the current year as stale.',
  ].join(' ');
}
