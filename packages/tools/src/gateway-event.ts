/**
 * AgentCore Gateway → Lambda target event adapter.
 *
 * A Gateway Lambda target receives the tool's input arguments as the event
 * payload, and the tool name via the Lambda client context
 * (`context.clientContext.custom.bedrockAgentCoreToolName`, formatted
 * `<targetName>___<toolName>`). This module extracts both
 * defensively so one handler can serve multiple tools.
 */

export interface GatewayLambdaContextLike {
  clientContext?: {
    custom?: Record<string, unknown> | undefined;
  } | undefined;
}

/** Strips the `targetName___` prefix from a gateway tool name. */
export function bareToolName(qualified: string): string {
  const separator = qualified.lastIndexOf('___');
  return separator >= 0 ? qualified.slice(separator + 3) : qualified;
}

export function extractToolName(
  context: GatewayLambdaContextLike | undefined,
  fallback?: string,
): string {
  const custom = context?.clientContext?.custom ?? {};
  const candidates = [
    custom['bedrockAgentCoreToolName'],
    custom['bedrockagentcoreToolName'],
    custom['toolName'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return bareToolName(candidate);
    }
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(
    'Unable to determine tool name from gateway invocation context',
  );
}

/**
 * Tool results follow one consistent shape: success flag, data, surfaced
 * error/fallback reasons (`via` tag), and duration — errors are returned to
 * the agent as content, never swallowed.
 */
export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
  via?: string;
  durationMs: number;
}
