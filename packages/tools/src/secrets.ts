/**
 * API-key lookup: environment variable first (local dev / injected), then
 * Secrets Manager, memoized per container. Region comes from AWS_REGION —
 * deliberately no hardcoded default region, so tools deploy to any region
 * without code changes.
 */
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
const cache = new Map<string, Promise<string | null>>();

export interface KeySource {
  /** Environment variable checked first (e.g. TAVILY_API_KEY). */
  envVar: string;
  /** Secrets Manager secret id checked second (e.g. marketing-workflow/tavily-api-key). */
  secretName?: string;
}

export function lookupApiKey(source: KeySource): Promise<string | null> {
  const cacheKey = `${source.envVar}:${source.secretName ?? ''}`;
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }
  const lookup = (async () => {
    const envValue = process.env[source.envVar];
    if (envValue && envValue.trim().length > 0) {
      return envValue.trim();
    }
    if (!source.secretName) {
      return null;
    }
    try {
      const response = await client.send(
        new GetSecretValueCommand({ SecretId: source.secretName }),
      );
      const value = response.SecretString?.trim();
      return value && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  })();
  cache.set(cacheKey, lookup);
  return lookup;
}

/** Test seam: clears the memoized lookups. */
export function resetKeyCache(): void {
  cache.clear();
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** fetch with a 30s AbortController timeout. */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
