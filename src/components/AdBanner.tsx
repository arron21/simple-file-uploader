'use client';

import React, { useEffect } from 'react';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

export interface SponsorCreative {
  id: string;
  eyebrow: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
}

const DEFAULT_SPONSORS: SponsorCreative[] = [
  {
    id: 'vault-pro-house',
    eyebrow: 'VAULTDROP PRO // LARGE TRANSFERS',
    headline: 'Need to send 500 MB+ RAW video, archives, or keep files forever?',
    body: 'Unlock up to 5 TB multipart uploads, 1-Year or Permanent storage, and instant zero-wait downloads starting at $2.99.',
    ctaLabel: 'Unlock Large Files →',
    ctaUrl: '#upgrade',
  },
  {
    id: 'direct-sponsor-slot',
    eyebrow: 'DIRECT SPONSORSHIP // PARTNER SLOT',
    headline: 'Reach creators, engineers, and studios sharing files daily.',
    body: 'Place your product in front of high-intent technical teams on VaultDrop — clean, privacy-first native ad placements.',
    ctaLabel: 'Sponsor This Slot →',
    ctaUrl:
      process.env.NEXT_PUBLIC_SPONSOR_INQUIRY_URL ||
      'mailto:sponsors@vaultdrop.app?subject=VaultDrop%20Sponsorship%20Inquiry',
  },
  {
    id: 'cloud-backup-spotlight',
    eyebrow: 'FEATURED PARTNER // ARCHIVAL STORAGE',
    headline: 'Stop losing expired links. Upgrade critical deliverables to Permanent.',
    body: 'Free uploads auto-delete after 7 days. Keep client deliverables live for 30 days, 1 year, or permanently with one click.',
    ctaLabel: 'View Retention Passes →',
    ctaUrl: '#upgrade',
  },
];

interface AdBannerProps {
  adFree: boolean;
  variant?: 'leaderboard' | 'compact' | 'rectangle';
  slotIndex?: number;
  onUpgradeClick: () => void;
}

export default function AdBanner({
  adFree,
  variant = 'leaderboard',
  slotIndex = 0,
  onUpgradeClick,
}: AdBannerProps) {
  const adsenseClientId = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID?.trim();
  const adsenseSlotId =
    variant === 'rectangle'
      ? process.env.NEXT_PUBLIC_ADSENSE_INTERSTITIAL_SLOT?.trim()
      : process.env.NEXT_PUBLIC_ADSENSE_BANNER_SLOT?.trim();

  useEffect(() => {
    if (adFree || !adsenseClientId || !adsenseSlotId) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // Ignore AdSense duplicate push errors during React strict mode re-renders
    }
  }, [adFree, adsenseClientId, adsenseSlotId]);

  if (adFree) return null;

  const sponsor =
    DEFAULT_SPONSORS[slotIndex % DEFAULT_SPONSORS.length] || DEFAULT_SPONSORS[0];
  const sponsorInquiryUrl =
    process.env.NEXT_PUBLIC_SPONSOR_INQUIRY_URL ||
    'mailto:sponsors@vaultdrop.app?subject=Advertise%20on%20VaultDrop';

  return (
    <aside
      className={`ad-unit ad-unit-${variant}`}
      aria-label="Sponsored Advertisement"
    >
      <div className="ad-unit-topbar">
        <span className="ad-badge-label">SPONSORED // AD-SUPPORTED FREE TIER</span>
        <div className="ad-unit-links">
          <a
            href={sponsorInquiryUrl}
            target={sponsorInquiryUrl.startsWith('http') ? '_blank' : undefined}
            rel={
              sponsorInquiryUrl.startsWith('http')
                ? 'noopener noreferrer'
                : undefined
            }
            className="ad-meta-link"
          >
            Advertise Here
          </a>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="ad-meta-link"
            onClick={onUpgradeClick}
          >
            Remove Ads
          </button>
        </div>
      </div>

      {adsenseClientId && adsenseSlotId ? (
        <div className="adsense-slot-wrap">
          <ins
            className="adsbygoogle"
            style={{ display: 'block', width: '100%' }}
            data-ad-client={adsenseClientId}
            data-ad-slot={adsenseSlotId}
            data-ad-format={variant === 'rectangle' ? 'rectangle' : 'auto'}
            data-full-width-responsive="true"
          />
        </div>
      ) : (
        <div className="ad-native-body">
          <div className="ad-native-copy">
            <span className="ad-native-eyebrow">{sponsor.eyebrow}</span>
            <p className="ad-native-headline">{sponsor.headline}</p>
            {variant !== 'compact' && (
              <p className="ad-native-desc">{sponsor.body}</p>
            )}
          </div>
          <div className="ad-native-action">
            {sponsor.ctaUrl === '#upgrade' ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onUpgradeClick}
              >
                {sponsor.ctaLabel}
              </button>
            ) : (
              <a
                href={sponsor.ctaUrl}
                target={sponsor.ctaUrl.startsWith('http') ? '_blank' : undefined}
                rel={
                  sponsor.ctaUrl.startsWith('http')
                    ? 'noopener noreferrer'
                    : undefined
                }
                className="btn btn-secondary"
              >
                {sponsor.ctaLabel}
              </a>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
