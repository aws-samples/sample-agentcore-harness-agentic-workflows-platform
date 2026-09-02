/**
 * Cognito auth without SDK dependencies: InitiateAuth (USER_PASSWORD_AUTH)
 * via the public cognito-idp JSON endpoint, with NEW_PASSWORD_REQUIRED
 * challenge handling for admin-created users.
 */
import { loadConfig } from './config';

const STORAGE_KEY = 'agentic.idToken';

interface CognitoAuthResult {
  AuthenticationResult?: { IdToken?: string; ExpiresIn?: number };
  ChallengeName?: string;
  Session?: string;
  message?: string;
  __type?: string;
}

export interface SignInResult {
  ok: boolean;
  /** Set when Cognito requires a new password (first sign-in). */
  newPasswordRequired?: boolean;
  session?: string;
  error?: string;
}

async function cognitoCall(
  region: string,
  target: string,
  payload: unknown,
): Promise<CognitoAuthResult> {
  const response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as CognitoAuthResult;
}

function storeToken(result: CognitoAuthResult): boolean {
  const token = result.AuthenticationResult?.IdToken;
  if (!token) {
    return false;
  }
  const expiresAt = Date.now() + (result.AuthenticationResult?.ExpiresIn ?? 3600) * 1000;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token, expiresAt }));
  return true;
}

export async function signIn(
  username: string,
  password: string,
): Promise<SignInResult> {
  const config = await loadConfig();
  const result = await cognitoCall(config.region, 'InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: config.userPoolClientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  });
  if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return { ok: false, newPasswordRequired: true, session: result.Session };
  }
  if (storeToken(result)) {
    return { ok: true };
  }
  return { ok: false, error: result.message ?? result.__type ?? 'sign-in failed' };
}

export async function completeNewPassword(
  username: string,
  newPassword: string,
  session: string,
): Promise<SignInResult> {
  const config = await loadConfig();
  const result = await cognitoCall(config.region, 'RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: config.userPoolClientId,
    Session: session,
    ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
  });
  if (storeToken(result)) {
    return { ok: true };
  }
  return { ok: false, error: result.message ?? result.__type ?? 'password change failed' };
}

export function currentToken(): string | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const { token, expiresAt } = JSON.parse(raw) as {
      token: string;
      expiresAt: number;
    };
    if (Date.now() >= expiresAt) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function signOut(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export interface TokenClaims {
  'cognito:username'?: string;
  email?: string;
  exp?: number;
  [key: string]: unknown;
}

/** Decoded (unverified) claims from the stored id token, for display only. */
export function tokenClaims(): TokenClaims | null {
  const token = currentToken();
  if (!token) {
    return null;
  }
  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized)) as TokenClaims;
  } catch {
    return null;
  }
}

/**
 * Org admin check from the id token's cognito:groups claim (display/UX
 * gating only — the API enforces the admin group server-side).
 */
export function isAdminUser(): boolean {
  const groups = tokenClaims()?.['cognito:groups'];
  if (Array.isArray(groups)) {
    return groups.includes('admin');
  }
  return typeof groups === 'string' && groups.split(/[\s,]+/).includes('admin');
}

/** Best-effort display name for the signed-in user. */
export function displayName(): string {
  const claims = tokenClaims();
  const username = claims?.['cognito:username'];
  if (typeof username === 'string' && username) {
    return username;
  }
  if (typeof claims?.email === 'string' && claims.email) {
    return claims.email;
  }
  return 'Signed in';
}
