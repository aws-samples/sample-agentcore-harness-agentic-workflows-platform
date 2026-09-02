/**
 * createToolHandler — one Lambda per tool (independent-targets design,
 * docs/decisions.md D-25).
 *
 * Each gateway tool ships as its own Lambda function with its own IAM role
 * scoped to exactly its secret. This factory wraps a single executor in the
 * house ToolResult contract: errors surface as structured content, never
 * thrown at the gateway. A name check keeps target/handler wiring mistakes
 * loud instead of silently running the wrong executor.
 */
import {
  extractToolName,
  type GatewayLambdaContextLike,
  type ToolResult,
} from './gateway-event';

export interface ToolHandlerOptions<I, D> {
  /** The one tool this handler serves, e.g. 'news_search'. */
  toolName: string;
  /** Provenance tag for the result, or a function deriving it from data. */
  via: string | ((data: D) => string);
  executor: (input: I) => Promise<D>;
}

export type ToolHandler = (
  event: unknown,
  context?: GatewayLambdaContextLike,
) => Promise<ToolResult>;

export function createToolHandler<I, D>(
  options: ToolHandlerOptions<I, D>,
): ToolHandler {
  return async (event, context) => {
    const start = Date.now();
    // Fallback = own name: direct invocations (tests, console) work without
    // the gateway's client context; a mismatched gateway context still fails
    // loudly below.
    const requested = extractToolName(context, options.toolName);
    if (requested !== options.toolName) {
      return {
        success: false,
        data: null,
        error: `this target serves only "${options.toolName}" (invoked as "${requested}")`,
        durationMs: Date.now() - start,
      };
    }
    try {
      const data = await options.executor(event as I);
      const via =
        typeof options.via === 'function' ? options.via(data) : options.via;
      return { success: true, data, via, durationMs: Date.now() - start };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      };
    }
  };
}
