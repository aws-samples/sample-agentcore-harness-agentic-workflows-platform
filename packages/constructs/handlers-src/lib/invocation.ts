/**
 * Defensive extraction of text + token usage from an invokeHarness result.
 *
 * The Step Functions optimized integration returns Converse-shaped responses;
 * exact field casing was validated against the live service, so this module
 * probes the known shapes rather than assuming one.
 */

interface ContentBlock {
  text?: string;
  Text?: string;
}

function collectText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) {
    return undefined;
  }
  const parts = blocks
    .map((block: ContentBlock) => block?.text ?? block?.Text)
    .filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export function extractText(invocation: unknown): string {
  if (typeof invocation === 'string') {
    return invocation;
  }
  const inv = (invocation ?? {}) as Record<string, any>;
  const candidates: unknown[] = [
    inv.output?.message?.content,
    inv.Output?.Message?.Content,
    inv.message?.content,
    inv.Message?.Content,
    inv.content,
    inv.Content,
  ];
  for (const candidate of candidates) {
    const text = collectText(candidate);
    if (text) {
      return text;
    }
  }
  if (typeof inv.outputText === 'string') {
    return inv.outputText;
  }
  if (typeof inv.OutputText === 'string') {
    return inv.OutputText;
  }
  // Last resort: keep the raw payload so nothing is silently lost.
  return JSON.stringify(invocation ?? {}, null, 2).slice(0, 200_000);
}

export interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
}

export function extractUsage(invocation: unknown): ExtractedUsage {
  const inv = (invocation ?? {}) as Record<string, any>;
  const usage = inv.usage ?? inv.Usage ?? inv.metadata?.usage ?? inv.Metadata?.Usage ?? {};
  const input = usage.inputTokens ?? usage.InputTokens ?? 0;
  const output = usage.outputTokens ?? usage.OutputTokens ?? 0;
  return {
    inputTokens: Number.isFinite(Number(input)) ? Number(input) : 0,
    outputTokens: Number.isFinite(Number(output)) ? Number(output) : 0,
  };
}

/** Render a Step Functions Catch payload ({ Error, Cause }) as a short reason. */
export function summarizeFailure(failure: unknown): string {
  const f = (failure ?? {}) as Record<string, any>;
  const error = typeof f.Error === 'string' ? f.Error : 'UnknownError';
  let cause = typeof f.Cause === 'string' ? f.Cause : '';
  try {
    const parsed = JSON.parse(cause);
    cause = parsed.errorMessage ?? cause;
  } catch {
    // cause was not JSON; keep as-is
  }
  const summary = `${error}${cause ? `: ${cause}` : ''}`;
  return summary.slice(0, 1_000);
}
