import crypto from 'crypto';
import { cookies } from 'next/headers';
import {
  ENTITLEMENT_COOKIE_NAME,
  FREE_MAX_FILE_BYTES,
  PAID_MAX_FILE_BYTES,
  PRICING_PLANS,
  type ActiveEntitlement,
  type EntitlementTokenPayload,
  type PlanId,
} from './monetization';

function getEntitlementSecret(): string {
  const baseSecret =
    process.env.ENTITLEMENT_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.BLOB_READ_WRITE_TOKEN ||
    'vaultdrop-entitlement-secret-v1';
  return crypto
    .createHash('sha256')
    .update(`entitlement::${baseSecret}`)
    .digest('hex');
}

function signTokenPart(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', getEntitlementSecret())
    .update(encodedPayload)
    .digest('base64url');
}

export function isStripeConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_SECRET_KEY.trim().startsWith('sk_')
  );
}

export function createEntitlementLicense(params: {
  planId: PlanId;
  source: 'stripe' | 'sandbox' | 'promo';
  ref?: string;
  customDurationMs?: number;
}): { licenseKey: string; payload: EntitlementTokenPayload } {
  const plan = PRICING_PLANS[params.planId];
  const now = Date.now();
  const duration = params.customDurationMs ?? plan.passDurationMs;

  const payload: EntitlementTokenPayload = {
    v: 1,
    planId: plan.id,
    allowPermanent: plan.allowsPermanentFiles,
    iat: now,
    exp: now + duration,
    source: params.source,
    ...(params.ref ? { ref: params.ref.slice(0, 64) } : {}),
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url'
  );
  const sig = signTokenPart(encoded);
  return {
    licenseKey: `VD1.${encoded}.${sig}`,
    payload,
  };
}

export function verifyEntitlementLicense(
  token: string | undefined | null
): EntitlementTokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const trimmed = token.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts[0] !== 'VD1') return null;

  const [, encoded, sig] = parts;
  const expectedSig = signTokenPart(encoded);

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as EntitlementTokenPayload;
    if (
      decoded.v !== 1 ||
      typeof decoded.exp !== 'number' ||
      Date.now() > decoded.exp ||
      !PRICING_PLANS[decoded.planId]
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function verifyPromoCode(code: string): boolean {
  const configured = process.env.PRO_PROMO_CODE?.trim();
  if (!configured) return false;
  const a = Buffer.from(code.trim(), 'utf8');
  const b = Buffer.from(configured, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function buildEntitlementState(
  token: string | undefined | null
): ActiveEntitlement {
  const stripeConfigured = isStripeConfigured();
  const verified = verifyEntitlementLicense(token);

  if (!verified) {
    return {
      tier: 'free',
      planId: null,
      planName: 'Free Ad-Supported Tier',
      maxFileBytes: FREE_MAX_FILE_BYTES,
      adFree: false,
      allowExtendedLifetime: false,
      allowPermanentLifetime: false,
      expiresAt: null,
      licenseKey: null,
      source: null,
      stripeConfigured,
    };
  }

  const plan = PRICING_PLANS[verified.planId];
  return {
    tier: 'paid',
    planId: verified.planId,
    planName: plan.name,
    maxFileBytes: PAID_MAX_FILE_BYTES,
    adFree: true,
    allowExtendedLifetime: true,
    allowPermanentLifetime: verified.allowPermanent,
    expiresAt: new Date(verified.exp).toISOString(),
    licenseKey: token!.trim(),
    source: verified.source,
    stripeConfigured,
  };
}

export async function getActiveEntitlement(): Promise<ActiveEntitlement> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(ENTITLEMENT_COOKIE_NAME)?.value;
  return buildEntitlementState(rawToken);
}

export function getEntitlementCookieOptions(expiresAtMs: number) {
  const maxAgeSeconds = Math.max(
    60,
    Math.floor((expiresAtMs - Date.now()) / 1000)
  );
  return {
    name: ENTITLEMENT_COOKIE_NAME,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
