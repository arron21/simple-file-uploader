'use client';

import React, { useState } from 'react';
import {
  ORDERED_PLANS,
  type ActiveEntitlement,
  type PlanId,
  type PricingPlan,
} from '@/lib/monetization';

interface UpgradeModalProps {
  open: boolean;
  reasonBanner?: string | null;
  entitlement: ActiveEntitlement;
  onClose: () => void;
  onEntitlementUpdated: (next: ActiveEntitlement) => void;
}

export default function UpgradeModal({
  open,
  reasonBanner,
  entitlement,
  onClose,
  onEntitlementUpdated,
}: UpgradeModalProps) {
  const [loadingPlan, setLoadingPlan] = useState<PlanId | null>(null);
  const [sandboxPlan, setSandboxPlan] = useState<PricingPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemLoading, setRedeemLoading] = useState(false);
  const [copiedLicense, setCopiedLicense] = useState(false);
  const [justUnlocked, setJustUnlocked] = useState(false);

  if (!open) return null;

  const handleSelectPlan = async (planId: PlanId, sandboxConfirm = false) => {
    setLoadingPlan(planId);
    setError(null);

    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, sandboxConfirm }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Checkout failed.');
      }

      if (data.mode === 'stripe' && data.checkoutUrl) {
        window.location.assign(data.checkoutUrl);
        return;
      }

      if (data.mode === 'sandbox_prompt' && data.plan) {
        setSandboxPlan(data.plan);
        return;
      }

      if (data.mode === 'sandbox_completed' && data.entitlement) {
        setSandboxPlan(null);
        setJustUnlocked(true);
        onEntitlementUpdated(data.entitlement);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout error.');
    } finally {
      setLoadingPlan(null);
    }
  };

  const handleRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!redeemCode.trim()) return;
    setRedeemLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/billing/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: redeemCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Invalid License Key or Promo Code.');
      }
      setRedeemCode('');
      setJustUnlocked(true);
      onEntitlementUpdated(data.entitlement);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to redeem code.');
    } finally {
      setRedeemLoading(false);
    }
  };

  const handleDeactivatePass = async () => {
    const res = await fetch('/api/billing/redeem', { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.entitlement) {
      setJustUnlocked(false);
      onEntitlementUpdated(data.entitlement);
    }
  };

  const handleCopyLicense = async () => {
    if (!entitlement.licenseKey) return;
    await navigator.clipboard.writeText(entitlement.licenseKey);
    setCopiedLicense(true);
    setTimeout(() => setCopiedLicense(false), 2000);
  };

  return (
    <div
      className="modal-backdrop"
      id="upgrade-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setSandboxPlan(null);
          setJustUnlocked(false);
          onClose();
        }
      }}
    >
      <div
        className="modal-window upgrade-modal-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-modal-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <div className="modal-title" id="upgrade-modal-title">
              {entitlement.tier === 'paid'
                ? 'Active VaultDrop Pass & License Key'
                : 'Upgrade VaultDrop — Large Files & Long-Term Storage'}
            </div>
            <div className="modal-subtitle">
              Free tier includes 250 MB max/file & 7-day auto-delete · Paid passes unlock 5 TB,
              Permanent storage & Ad-Free speed
            </div>
          </div>

          <button
            type="button"
            id="close-upgrade-modal-btn"
            className="btn btn-ghost btn-icon"
            onClick={() => {
              setSandboxPlan(null);
              setJustUnlocked(false);
              onClose();
            }}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <div className="upgrade-modal-body">
          {reasonBanner && entitlement.tier !== 'paid' && (
            <div className="upgrade-reason-banner" role="status">
              <span className="mono" style={{ fontWeight: 700, fontSize: '0.75rem' }}>
                UPGRADE REQUIRED
              </span>
              <span>{reasonBanner}</span>
            </div>
          )}

          {error && (
            <div className="alert-banner alert-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          {/* Active Pass Summary Card */}
          {entitlement.tier === 'paid' && (
            <div className="active-pass-card" id="active-pass-panel">
              <div className="active-pass-header">
                <div>
                  <span className="auth-index-label" style={{ marginBottom: '0.25rem' }}>
                    {justUnlocked ? 'PASS ACTIVATED // READY' : 'ACTIVE PASS // UNLOCKED'}
                  </span>
                  <h3 style={{ fontSize: '1.15rem', fontWeight: 700 }}>
                    {entitlement.planName}
                  </h3>
                  <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                    Up to 5 TB per file ·{' '}
                    {entitlement.allowPermanentLifetime
                      ? '30-Day, 1-Year & Permanent retention unlocked'
                      : '30-Day & 1-Year retention unlocked'}{' '}
                    · 100% Ad-Free
                  </p>
                </div>

                <span className="tier-pill tier-pill-pro">
                  {entitlement.source === 'stripe'
                    ? 'Stripe Verified'
                    : entitlement.source === 'promo'
                    ? 'Promo Pass'
                    : 'Sandbox Pass'}
                </span>
              </div>

              {entitlement.expiresAt && (
                <div className="mono" style={{ fontSize: '0.77rem', color: 'var(--text-secondary)' }}>
                  Pass privileges valid through:{' '}
                  <strong>{new Date(entitlement.expiresAt).toLocaleString()}</strong> (files retain
                  their chosen lifetime even after your pass window ends)
                </div>
              )}

              {entitlement.licenseKey && (
                <div className="license-key-box">
                  <div className="field-label">
                    <span>Portable License Key (Save to unlock on other devices)</span>
                    <button
                      type="button"
                      id="copy-license-key-btn"
                      className="btn btn-secondary"
                      style={{ padding: '0.28rem 0.65rem', fontSize: '0.75rem' }}
                      onClick={handleCopyLicense}
                    >
                      {copiedLicense ? 'Copied Key!' : 'Copy License Key'}
                    </button>
                  </div>
                  <code className="license-key-code">{entitlement.licenseKey}</code>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                  paddingTop: '0.5rem',
                }}
              >
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: '0.78rem', color: 'var(--status-danger)' }}
                  onClick={handleDeactivatePass}
                >
                  Deactivate Pass on This Browser
                </button>
                <button
                  type="button"
                  id="done-upgrade-btn"
                  className="btn btn-primary"
                  onClick={() => {
                    setJustUnlocked(false);
                    onClose();
                  }}
                >
                  Continue to Vault →
                </button>
              </div>
            </div>
          )}

          {/* Sandbox Checkout Confirmation Step (when STRIPE_SECRET_KEY is not yet set) */}
          {sandboxPlan ? (
            <div className="sandbox-checkout-box" id="sandbox-checkout-step">
              <div className="auth-index-label">
                {entitlement.stripeConfigured
                  ? 'STRIPE CHECKOUT'
                  : 'SANDBOX CHECKOUT MODE // STRIPE_SECRET_KEY NOT YET SET'}
              </div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.35rem' }}>
                Confirm {sandboxPlan.name} ({sandboxPlan.priceDisplay}{' '}
                {sandboxPlan.billingLabel})
              </h3>
              <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                Live Stripe keys (<code>STRIPE_SECRET_KEY</code>) are not yet configured in Vercel
                Environment Variables, so VaultDrop is running in{' '}
                <strong>Interactive Sandbox Checkout Mode</strong>. Add{' '}
                <code>STRIPE_SECRET_KEY</code> in Vercel at any time to immediately charge real
                cards, Apple Pay, and Google Pay via Stripe Checkout.
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  id="confirm-sandbox-payment-btn"
                  className="btn btn-primary"
                  disabled={loadingPlan !== null}
                  onClick={() => handleSelectPlan(sandboxPlan.id, true)}
                >
                  {loadingPlan === sandboxPlan.id
                    ? 'Issuing Pass...'
                    : `Complete Sandbox Purchase (${sandboxPlan.priceDisplay})`}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSandboxPlan(null)}
                >
                  ← Back to Plans
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Pricing Plans Grid */}
              <div className="pricing-grid">
                {ORDERED_PLANS.map((plan) => {
                  const isCurrent = entitlement.planId === plan.id;
                  const isHighlighted = plan.id === 'pro_monthly';
                  return (
                    <div
                      key={plan.id}
                      className={`pricing-card ${isHighlighted ? 'highlighted' : ''}`}
                    >
                      <div className="pricing-card-top">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                          <span className="pricing-name">{plan.name}</span>
                          {plan.badge && (
                            <span className="pricing-badge">{plan.badge}</span>
                          )}
                        </div>
                        <p className="pricing-tagline">{plan.tagline}</p>

                        <div className="pricing-price-row">
                          <span className="pricing-amount">{plan.priceDisplay}</span>
                          <span className="pricing-cycle">{plan.billingLabel}</span>
                        </div>
                      </div>

                      <ul className="pricing-features">
                        {plan.features.map((feat) => (
                          <li key={feat}>
                            <span className="pricing-check" aria-hidden="true">
                              ✓
                            </span>
                            <span>{feat}</span>
                          </li>
                        ))}
                      </ul>

                      <button
                        type="button"
                        id={`checkout-plan-${plan.id}`}
                        className={`btn ${
                          isHighlighted ? 'btn-primary' : 'btn-secondary'
                        }`}
                        style={{ width: '100%', marginTop: 'auto' }}
                        disabled={loadingPlan !== null}
                        onClick={() => handleSelectPlan(plan.id, false)}
                      >
                        {loadingPlan === plan.id
                          ? 'Starting Checkout...'
                          : isCurrent
                          ? `Extend ${plan.priceDisplay}`
                          : `Get ${plan.name} (${plan.priceDisplay})`}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* License Key / Promo Code Redemption */}
              <form className="redeem-bar" onSubmit={handleRedeem}>
                <div className="redeem-label">
                  <strong>Already have a License Key or Promo Code?</strong>
                  <span>Paste your VD1... pass key to unlock on this browser.</span>
                </div>
                <div className="redeem-controls">
                  <input
                    id="redeem-code-input"
                    type="text"
                    className="search-input mono"
                    style={{ paddingLeft: '0.75rem', minWidth: '210px' }}
                    placeholder="VD1.... or promo code"
                    value={redeemCode}
                    onChange={(e) => setRedeemCode(e.target.value)}
                  />
                  <button
                    type="submit"
                    id="redeem-code-btn"
                    className="btn btn-secondary"
                    disabled={redeemLoading || !redeemCode.trim()}
                  >
                    {redeemLoading ? 'Verifying...' : 'Activate Key'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
