export const ENTITLEMENT_COOKIE_NAME = 'vault_entitlement';

export const FREE_MAX_FILE_BYTES = 250 * 1024 * 1024; // 250 MB
export const PAID_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024 * 1024; // 5 TB

export type LifetimeId = '1d' | '7d' | '30d' | '365d' | 'forever';

export interface LifetimeConfig {
  id: LifetimeId;
  label: string;
  shortLabel: string;
  ttlDays: number | null; // null = never auto-delete
  durationMs: number | null;
  requiresPaid: boolean;
  requiresPermanentTier: boolean;
}

export const LIFETIME_OPTIONS: Record<LifetimeId, LifetimeConfig> = {
  '1d': {
    id: '1d',
    label: '24 Hours',
    shortLabel: '24h',
    ttlDays: 1,
    durationMs: 24 * 60 * 60 * 1000,
    requiresPaid: false,
    requiresPermanentTier: false,
  },
  '7d': {
    id: '7d',
    label: '1 Week (Default)',
    shortLabel: '7 Days',
    ttlDays: 7,
    durationMs: 7 * 24 * 60 * 60 * 1000,
    requiresPaid: false,
    requiresPermanentTier: false,
  },
  '30d': {
    id: '30d',
    label: '30 Days',
    shortLabel: '30 Days',
    ttlDays: 30,
    durationMs: 30 * 24 * 60 * 60 * 1000,
    requiresPaid: true,
    requiresPermanentTier: false,
  },
  '365d': {
    id: '365d',
    label: '1 Year',
    shortLabel: '1 Year',
    ttlDays: 365,
    durationMs: 365 * 24 * 60 * 60 * 1000,
    requiresPaid: true,
    requiresPermanentTier: false,
  },
  forever: {
    id: 'forever',
    label: 'Permanent (Never Delete)',
    shortLabel: 'Permanent',
    ttlDays: null,
    durationMs: null,
    requiresPaid: true,
    requiresPermanentTier: true,
  },
};

export const ORDERED_LIFETIMES: LifetimeConfig[] = [
  LIFETIME_OPTIONS['1d'],
  LIFETIME_OPTIONS['7d'],
  LIFETIME_OPTIONS['30d'],
  LIFETIME_OPTIONS['365d'],
  LIFETIME_OPTIONS['forever'],
];

export type PlanId = 'pass_boost' | 'pass_permanent' | 'pro_monthly';

export interface PricingPlan {
  id: PlanId;
  name: string;
  tagline: string;
  priceCents: number;
  priceDisplay: string;
  billingLabel: string;
  mode: 'payment' | 'subscription';
  passDurationMs: number;
  allowsPermanentFiles: boolean;
  maxFileBytes: number;
  badge?: string;
  features: string[];
}

export const PRICING_PLANS: Record<PlanId, PricingPlan> = {
  pass_boost: {
    id: 'pass_boost',
    name: 'Large File & 1-Year Pass',
    tagline: 'One-time pass for big transfers & extended retention',
    priceCents: 299,
    priceDisplay: '$2.99',
    billingLabel: 'one-time · 72h pass',
    mode: 'payment',
    passDurationMs: 3 * 24 * 60 * 60 * 1000,
    allowsPermanentFiles: false,
    maxFileBytes: PAID_MAX_FILE_BYTES,
    features: [
      'Upload large files over 250 MB (up to 5 TB)',
      'Unlock 30-Day & 1-Year file lifetimes',
      'Extend lifetime on existing stored files',
      'Ad-free UI & zero-wait instant downloads',
    ],
  },
  pass_permanent: {
    id: 'pass_permanent',
    name: 'Permanent Archival Pass',
    tagline: 'Keep critical files live forever without auto-delete',
    priceCents: 699,
    priceDisplay: '$6.99',
    billingLabel: 'one-time · 7-day pass',
    mode: 'payment',
    passDurationMs: 7 * 24 * 60 * 60 * 1000,
    allowsPermanentFiles: true,
    maxFileBytes: PAID_MAX_FILE_BYTES,
    features: [
      'Unlock Permanent (Never Auto-Delete) storage',
      'Upload large files up to 5 TB (8 MB multipart)',
      'Upgrade existing files to Permanent lifetime',
      '7 days of ad-free, zero-wait downloads',
    ],
  },
  pro_monthly: {
    id: 'pro_monthly',
    name: 'VaultDrop Pro Unlimited',
    tagline: 'Full power for teams & frequent creators',
    priceCents: 900,
    priceDisplay: '$9',
    billingLabel: 'per month',
    mode: 'subscription',
    passDurationMs: 32 * 24 * 60 * 60 * 1000,
    allowsPermanentFiles: true,
    maxFileBytes: PAID_MAX_FILE_BYTES,
    badge: 'Most Popular',
    features: [
      'Unlimited large file uploads up to 5 TB',
      'All lifetimes: 30 Days, 1 Year & Permanent',
      '100% Ad-Free vault & instant 0s downloads',
      'Portable License Key for all your devices',
    ],
  },
};

export const ORDERED_PLANS: PricingPlan[] = [
  PRICING_PLANS.pass_boost,
  PRICING_PLANS.pass_permanent,
  PRICING_PLANS.pro_monthly,
];

export interface EntitlementTokenPayload {
  v: 1;
  planId: PlanId;
  allowPermanent: boolean;
  iat: number;
  exp: number;
  source: 'stripe' | 'sandbox' | 'promo';
  ref?: string;
}

export interface ActiveEntitlement {
  tier: 'free' | 'paid';
  planId: PlanId | null;
  planName: string;
  maxFileBytes: number;
  adFree: boolean;
  allowExtendedLifetime: boolean;
  allowPermanentLifetime: boolean;
  expiresAt: string | null;
  licenseKey: string | null;
  source: 'stripe' | 'sandbox' | 'promo' | null;
  stripeConfigured: boolean;
}

export function isValidLifetimeId(val: unknown): val is LifetimeId {
  return (
    typeof val === 'string' &&
    (val === '1d' ||
      val === '7d' ||
      val === '30d' ||
      val === '365d' ||
      val === 'forever')
  );
}

/**
 * Checks whether a given entitlement is permitted to use the requested file lifetime.
 */
export function canUseLifetime(
  entitlement: ActiveEntitlement,
  lifetime: LifetimeId
): { allowed: boolean; reason?: string } {
  const cfg = LIFETIME_OPTIONS[lifetime];
  if (!cfg) {
    return { allowed: false, reason: 'Invalid file lifetime option.' };
  }
  if (!cfg.requiresPaid) {
    return { allowed: true };
  }
  if (entitlement.tier !== 'paid') {
    return {
      allowed: false,
      reason: `${cfg.label} retention requires a Paid Pass or Pro Unlimited membership.`,
    };
  }
  if (cfg.requiresPermanentTier && !entitlement.allowPermanentLifetime) {
    return {
      allowed: false,
      reason:
        'Permanent (Never Delete) storage requires the Permanent Archival Pass ($6.99) or Pro Unlimited ($9/mo).',
    };
  }
  return { allowed: true };
}
