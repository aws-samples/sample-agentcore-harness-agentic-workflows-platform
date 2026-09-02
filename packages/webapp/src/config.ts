/**
 * Runtime configuration. Deployed environments serve /config.json alongside
 * the SPA (written at deploy time); local dev falls back to Vite env vars.
 */
export interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolClientId: string;
}

let cached: Promise<AppConfig> | null = null;

export function loadConfig(): Promise<AppConfig> {
  if (!cached) {
    cached = (async () => {
      try {
        const response = await fetch('/config.json', { cache: 'no-store' });
        if (response.ok) {
          const config = (await response.json()) as Partial<AppConfig>;
          if (config.apiUrl && config.region && config.userPoolClientId) {
            return config as AppConfig;
          }
        }
      } catch {
        // fall through to env config
      }
      const env = import.meta.env;
      const apiUrl = env.VITE_API_URL as string | undefined;
      const region = env.VITE_AWS_REGION as string | undefined;
      const userPoolClientId = env.VITE_USER_POOL_CLIENT_ID as string | undefined;
      if (!apiUrl || !region || !userPoolClientId) {
        throw new Error(
          'Missing app configuration: provide /config.json or VITE_API_URL, VITE_AWS_REGION, VITE_USER_POOL_CLIENT_ID',
        );
      }
      return { apiUrl, region, userPoolClientId };
    })();
  }
  return cached;
}
