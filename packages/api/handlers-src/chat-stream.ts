/**
 * chat-stream — the streaming report chat (Lambda Function URL, response
 * streaming, SSE). Fixes the live 500 on edit requests: API Gateway HTTP API
 * buffers responses and caps the integration at 29s, and a section-rewrite
 * proposal regularly lands in the 20–30s band (D-30). A streaming Function
 * URL lifts the cap and lets the user watch the answer arrive.
 *
 * Trust boundary, two layers. The Function URL is AWS_IAM and sits behind
 * CloudFront with Origin Access Control, which SigV4-signs origin requests
 * (a NONE-auth URL was live-rejected: account guardrails strip the public
 * permission). Independently, THIS handler verifies the caller's Cognito id
 * token (signature, issuer, audience, expiry, token_use) before touching
 * any AWS resource — the same claims the JWT authorizer hands the router.
 * Unauthenticated calls get a 401 and nothing else.
 *
 * Wire format (text/event-stream), one `data:` JSON line per event:
 *   {"type":"delta","text":"..."}          visible answer text as it arrives
 *   {"type":"done", ...finalChatPayload}    full content + proposedEdit/issue
 *   {"type":"error","status":N,"error":".."} before any delta = plain
 *                                            non-200 JSON response instead
 * The edit-proposal fence never streams as text (ProposalGate); it arrives
 * parsed in `done`.
 */
/// <reference types="aws-lambda" />
import type { Writable } from 'node:stream';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { invokeHarnessStream } from '@agentic-platform/constructs/dist/handlers-src/lib/planner-client';
import { requireEnv } from './lib/common';
import { parseBody, type HttpEvent } from './lib/http';
import {
  ProposalGate,
  chatInvocationArgs,
  finalChatPayload,
  loadChatContext,
} from './lib/report-chat';
import { validateChatReport } from '../src/validation';

/** Lambda Function URL event (payload v2 shape, same as HTTP API). */
export interface FunctionUrlEvent extends HttpEvent {
  headers?: Record<string, string | undefined>;
}

/** Minimal sink both the Lambda response stream and tests can satisfy. */
export interface ChatStreamSink {
  /** Send the HTTP prelude (status + headers). Must be called exactly once, first. */
  start(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export interface JwtVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

let cachedVerifier: JwtVerifier | undefined;
function defaultVerifier(): JwtVerifier {
  if (!cachedVerifier) {
    cachedVerifier = CognitoJwtVerifier.create({
      userPoolId: requireEnv('USER_POOL_ID'),
      clientId: requireEnv('USER_POOL_CLIENT_ID'),
      tokenUse: 'id',
    }) as unknown as JwtVerifier;
  }
  return cachedVerifier;
}

/**
 * Header carrying the Cognito id token. Behind CloudFront OAC (signing
 * behavior `always`) the viewer's `Authorization` header is REPLACED by
 * CloudFront's SigV4 signature before it reaches the origin, so the SPA sends
 * the token in this custom header instead. `Authorization: Bearer` is still
 * accepted for direct callers.
 */
export const TOKEN_HEADER = 'x-agentic-token';

function bearerToken(event: FunctionUrlEvent): string | undefined {
  const headers = event.headers ?? {};
  const custom = headers[TOKEN_HEADER] ?? headers[TOKEN_HEADER.toUpperCase()];
  if (custom && custom.trim()) {
    return custom.trim().replace(/^Bearer\s+/i, '');
  }
  const header = headers.authorization ?? headers.Authorization ?? undefined;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match?.[1];
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The streaming chat, independent of the Lambda runtime wrapper so it can be
 * exercised in tests with a fake sink and verifier.
 */
export async function runChatStream(
  event: FunctionUrlEvent,
  sink: ChatStreamSink,
  deps: {
    verifier: JwtVerifier;
    invoke: typeof invokeHarnessStream;
    /** Emit CORS headers for this origin (unset = same-origin via CloudFront). */
    corsOrigin?: string;
    /** SSE keepalive interval while waiting on the model. Default 10s. */
    keepaliveMs?: number;
  },
): Promise<void> {
  const baseHeaders: Record<string, string> = {
    'cache-control': 'no-cache',
    ...(deps.corsOrigin
      ? {
          'access-control-allow-origin': deps.corsOrigin,
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'POST, OPTIONS',
        }
      : {}),
  };
  const fail = (status: number, error: string) => {
    sink.start(status, { ...baseHeaders, 'content-type': 'application/json' });
    sink.write(JSON.stringify({ error }));
    sink.end();
  };

  const method = event.requestContext.http.method.toUpperCase();
  if (method === 'OPTIONS') {
    // CORS preflight (also configured on the Function URL; belt and braces).
    sink.start(204, baseHeaders);
    sink.end();
    return;
  }
  if (method !== 'POST') {
    return fail(405, `no route: ${method} ${event.rawPath}`);
  }

  // ── Auth first: nothing else runs on an unverified token.
  const token = bearerToken(event);
  if (!token) {
    return fail(401, 'missing bearer token');
  }
  try {
    await deps.verifier.verify(token);
  } catch (error) {
    console.warn('chat-stream: token rejected', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return fail(401, 'invalid or expired token');
  }

  // Direct: /runs/{runId}/chat. Behind CloudFront the behavior path prefix
  // (e.g. /chat) is forwarded as-is, so allow one leading segment.
  const runId = /^(?:\/[^/]+)?\/runs\/([^/]+)\/chat\/?$/.exec(event.rawPath)?.[1];
  if (!runId) {
    return fail(404, `no route: POST ${event.rawPath}`);
  }
  const validated = validateChatReport(parseBody(event));
  if (!validated.ok) {
    return fail(400, validated.error);
  }
  const harnessArn = process.env.REPORT_CHAT_HARNESS_ARN;
  if (!harnessArn) {
    return fail(
      503,
      'report chat is not enabled for this deployment — add an agent named "report_chat" to the workload',
    );
  }
  const loaded = await loadChatContext({
    tableName: requireEnv('TABLE_NAME'),
    bucketName: requireEnv('BUCKET_NAME'),
    runId: decodeURIComponent(runId),
  });
  if (!loaded.ok) {
    return fail(loaded.status, loaded.error);
  }

  // ── From here on the response is a 200 event stream.
  sink.start(200, { ...baseHeaders, 'content-type': 'text/event-stream' });
  // Flush the prelude immediately and keep the connection warm: CloudFront's
  // origin read timeout counts idle time between bytes, and the model can
  // think for 20s+ before its first token. SSE comments are ignored by the
  // client parser.
  sink.write(': connected\n\n');
  const keepalive = setInterval(
    () => sink.write(': keepalive\n\n'),
    deps.keepaliveMs ?? 10_000,
  );
  const gate = new ProposalGate();
  try {
    for await (const delta of deps.invoke(
      chatInvocationArgs(harnessArn, loaded.context, validated.value.messages),
    )) {
      const visible = gate.push(delta);
      if (visible) {
        sink.write(sse({ type: 'delta', text: visible }));
      }
    }
    const tail = gate.flush();
    if (tail) {
      sink.write(sse({ type: 'delta', text: tail }));
    }
    sink.write(sse({ type: 'done', ...finalChatPayload(gate.collected, loaded.context) }));
  } catch (error) {
    console.error('chat-stream: harness invocation failed', { runId, error });
    sink.write(
      sse({
        type: 'error',
        status: 502,
        error: 'the report assistant could not answer right now — please try again',
      }),
    );
  } finally {
    clearInterval(keepalive);
    sink.end();
  }
}

/** Adapt the Lambda HttpResponseStream to the sink interface. */
function lambdaSink(responseStream: awslambda.HttpResponseStream): ChatStreamSink {
  let stream: Writable = responseStream;
  return {
    start(status, headers) {
      stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: status,
        headers,
      });
    },
    write(chunk) {
      stream.write(chunk);
    },
    end() {
      stream.end();
    },
  };
}

const streamHandler = async (
  event: FunctionUrlEvent,
  responseStream: awslambda.HttpResponseStream,
) => {
  await runChatStream(event, lambdaSink(responseStream), {
    verifier: defaultVerifier(),
    invoke: invokeHarnessStream,
    // Same-origin behind CloudFront by default; set CORS_ORIGIN only for a
    // cross-origin deployment.
    ...(process.env.CORS_ORIGIN ? { corsOrigin: process.env.CORS_ORIGIN } : {}),
  });
};

/**
 * `awslambda.streamifyResponse` is provided by the Lambda Node runtime (not
 * an npm module). Guard on the FUNCTION, not the namespace: the SDK's
 * transitive `@aws/lambda-invoke-store` also defines `globalThis.awslambda`
 * (as a bare object) outside Lambda, so a namespace check passes under
 * vitest and then explodes on the missing decorator.
 */
const streamify = (
  globalThis as { awslambda?: { streamifyResponse?: typeof awslambda.streamifyResponse } }
).awslambda?.streamifyResponse;
export const handler =
  typeof streamify === 'function' ? streamify(streamHandler) : streamHandler;
