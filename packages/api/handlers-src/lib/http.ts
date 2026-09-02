/**
 * Minimal API Gateway HTTP API (payload v2) helpers — no framework.
 */

export interface HttpEvent {
  rawPath: string;
  requestContext: {
    http: { method: string };
    authorizer?: {
      jwt?: { claims?: Record<string, unknown> };
    };
  };
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function json(statusCode: number, payload: unknown): HttpResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export function badRequest(message: string): HttpResponse {
  return json(400, { error: message });
}

export function notFound(message = 'not found'): HttpResponse {
  return json(404, { error: message });
}

export function parseBody(event: HttpEvent): unknown {
  if (!event.body) {
    return {};
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function callerId(event: HttpEvent): string | undefined {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const value = claims['username'] ?? claims['cognito:username'] ?? claims['sub'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Cognito group memberships from the JWT. The HTTP API JWT authorizer
 * stringifies array claims (e.g. "[admin analysts]"), so both the array and
 * the bracketed-string encodings are handled.
 */
export function callerGroups(event: HttpEvent): string[] {
  const raw = (event.requestContext.authorizer?.jwt?.claims ?? {})[
    'cognito:groups'
  ];
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === 'string') {
    return raw
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(/[\s,]+/)
      .filter(Boolean);
  }
  return [];
}

/** Org administrator check (D-19): membership in the 'admin' group. */
export function isAdmin(event: HttpEvent): boolean {
  return callerGroups(event).includes('admin');
}

export function forbidden(message: string): HttpResponse {
  return json(403, { error: message });
}
