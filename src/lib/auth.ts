import crypto from 'crypto';
import { cookies } from 'next/headers';

export const SESSION_COOKIE_NAME = 'vault_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Returns the configured shared password.
 * Checks APP_PASSWORD, UPLOAD_PASSWORD, and falls back to "vault2026" for out-of-the-box local/demo usage.
 */
export function getConfiguredPassword(): string {
  return (
    process.env.APP_PASSWORD ||
    process.env.UPLOAD_PASSWORD ||
    'vault2026'
  );
}

/**
 * Indicates whether the app is currently using the fallback default password.
 */
export function isUsingDefaultPassword(): boolean {
  return getConfiguredPassword() === 'vault2026';
}

function getSigningSecret(): string {
  const baseSecret =
    process.env.SESSION_SECRET ||
    process.env.BLOB_READ_WRITE_TOKEN ||
    'vault-signing-key-v1';
  // Bind the signing key to the current password so changing the password immediately invalidates old sessions
  return crypto
    .createHash('sha256')
    .update(`${baseSecret}::${getConfiguredPassword()}`)
    .digest('hex');
}

function signPayload(payload: string): string {
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('base64url');
}

/**
 * Constant-time password verification to prevent timing side-channel attacks.
 */
export function verifyPassword(inputPassword: string): boolean {
  const expected = getConfiguredPassword();
  const inputBuf = Buffer.from(inputPassword, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (inputBuf.length !== expectedBuf.length) {
    // Perform a dummy comparison of equal length to keep execution time uniform
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }

  return crypto.timingSafeEqual(inputBuf, expectedBuf);
}

/**
 * Creates a signed stateless session token containing an expiration timestamp.
 */
export function createSessionToken(): string {
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = Buffer.from(
    JSON.stringify({ v: 1, exp: expiresAt }),
    'utf8'
  ).toString('base64url');
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

/**
 * Verifies a signed stateless session token.
 */
export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;
  const expectedSig = signPayload(payload);

  const sigBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');

  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );
    if (typeof decoded.exp !== 'number' || Date.now() > decoded.exp) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether the current HTTP request has a valid session cookie.
 */
export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token);
}

export function getSessionCookieOptions() {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
