'use client';

import React, { useState } from 'react';
import {
  ORDERED_LIFETIMES,
  canUseLifetime,
  type ActiveEntitlement,
  type LifetimeId,
} from '@/lib/monetization';
import type { StoredFileItem } from '@/lib/storage';

interface FileLifetimeModalProps {
  file: StoredFileItem | null;
  entitlement: ActiveEntitlement;
  onClose: () => void;
  onUpdated: (updatedFile: StoredFileItem) => void;
  onRequireUpgrade: (reason: string) => void;
  formatExpiryLabel: (expiresAt: string | null) => string;
}

export default function FileLifetimeModal({
  file,
  entitlement,
  onClose,
  onUpdated,
  onRequireUpgrade,
  formatExpiryLabel,
}: FileLifetimeModalProps) {
  const [savingId, setSavingId] = useState<LifetimeId | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!file) return null;

  const handleChooseLifetime = async (lifetimeId: LifetimeId) => {
    const check = canUseLifetime(entitlement, lifetimeId);
    if (!check.allowed) {
      onClose();
      onRequireUpgrade(
        check.reason ||
          'Upgrade your pass to unlock extended 30-Day, 1-Year, or Permanent file retention.'
      );
      return;
    }

    setSavingId(lifetimeId);
    setError(null);

    try {
      const res = await fetch('/api/files', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: file.id, lifetime: lifetimeId }),
      });
      const data = await res.json();

      if (res.status === 402) {
        onClose();
        onRequireUpgrade(data.error || 'Upgrade required for extended retention.');
        return;
      }

      if (!res.ok || !data.file) {
        throw new Error(data.error || 'Failed to update file lifetime.');
      }

      onUpdated(data.file);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update lifetime.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div
      className="modal-backdrop"
      id="lifetime-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-window"
        style={{ maxWidth: '520px' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifetime-modal-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <div className="modal-title" id="lifetime-modal-title">
              Change File Auto-Delete Lifetime
            </div>
            <div className="modal-subtitle">
              {file.name} · Current: {formatExpiryLabel(file.expiresAt)}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="lifetime-modal-body">
          {error && (
            <div className="alert-banner alert-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Select how long this file stays live online before automatic deletion. Choosing a new
            duration resets the timer from right now.
          </p>

          <div className="lifetime-options-stack">
            {ORDERED_LIFETIMES.map((opt) => {
              const permCheck = canUseLifetime(entitlement, opt.id);
              const isCurrent = file.lifetime === opt.id;
              const isSaving = savingId === opt.id;

              return (
                <button
                  key={opt.id}
                  type="button"
                  id={`set-file-lifetime-${opt.id}`}
                  className={`lifetime-choice-row ${isCurrent ? 'active' : ''}`}
                  disabled={savingId !== null}
                  onClick={() => handleChooseLifetime(opt.id)}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                      {opt.label}
                    </div>
                    <div className="mono" style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                      {opt.ttlDays === null
                        ? 'Never expires · Kept online indefinitely'
                        : `Auto-deletes ${opt.ttlDays} day${opt.ttlDays === 1 ? '' : 's'} from today`}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    {isSaving ? (
                      <span className="mono" style={{ fontSize: '0.75rem' }}>
                        Saving...
                      </span>
                    ) : !permCheck.allowed ? (
                      <span className="tier-pill tier-pill-locked">
                        🔒 {opt.requiresPermanentTier ? '$6.99 / Pro' : '$2.99+ Pass'}
                      </span>
                    ) : isCurrent ? (
                      <span className="tier-pill tier-pill-pro">Current</span>
                    ) : (
                      <span className="tier-pill">Apply</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
