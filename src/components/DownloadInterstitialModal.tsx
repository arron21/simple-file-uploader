'use client';

import React, { useEffect, useState, useRef } from 'react';
import type { StoredFileItem } from '@/lib/storage';
import AdBanner from './AdBanner';

interface DownloadInterstitialModalProps {
  queuedFiles: StoredFileItem[] | null;
  onClose: () => void;
  onCompleteDownload: (files: StoredFileItem[]) => void;
  onSkipWithUpgrade: () => void;
  formatBytes: (bytes: number) => string;
}

const WAIT_SECONDS = 5;

function InterstitialDialogContent({
  files,
  onClose,
  onCompleteDownload,
  onSkipWithUpgrade,
  formatBytes,
}: {
  files: StoredFileItem[];
  onClose: () => void;
  onCompleteDownload: (files: StoredFileItem[]) => void;
  onSkipWithUpgrade: () => void;
  formatBytes: (bytes: number) => string;
}) {
  const [remainingMs, setRemainingMs] = useState(WAIT_SECONDS * 1000);
  const triggeredRef = useRef(false);

  useEffect(() => {
    const startedAt = Date.now();
    const totalMs = WAIT_SECONDS * 1000;

    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const left = Math.max(0, totalMs - elapsed);
      setRemainingMs(left);

      if (left <= 0 && !triggeredRef.current) {
        triggeredRef.current = true;
        window.clearInterval(timer);
        onCompleteDownload(files);
      }
    }, 100);

    return () => window.clearInterval(timer);
  }, [files, onCompleteDownload]);

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const progressPct = Math.min(
    100,
    Math.round(
      ((WAIT_SECONDS * 1000 - remainingMs) / (WAIT_SECONDS * 1000)) * 100
    )
  );
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const titleLabel =
    files.length === 1 ? files[0].name : `${files.length} selected files`;

  return (
    <div
      className="modal-backdrop"
      id="download-interstitial-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-window interstitial-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="interstitial-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <div className="modal-title" id="interstitial-title">
              {remainingMs > 0
                ? `Preparing Free Download (${secondsLeft}s)...`
                : 'Download Started'}
            </div>
            <div className="modal-subtitle">
              {titleLabel} · {formatBytes(totalBytes)}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Cancel download"
          >
            ✕
          </button>
        </div>

        <div className="interstitial-body">
          <div className="interstitial-progress-card">
            <div className="interstitial-progress-row">
              <span className="mono" style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                {remainingMs > 0
                  ? `Ad-supported transfer starts in ${secondsLeft} second${
                      secondsLeft === 1 ? '' : 's'
                    }`
                  : 'Your file transfer is starting automatically'}
              </span>
              <span className="mono" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {progressPct}%
              </span>
            </div>
            <div className="upload-progress-track" style={{ height: '6px' }}>
              <div
                className={`upload-progress-fill ${remainingMs === 0 ? 'done' : ''}`}
                style={{ width: `${progressPct}%`, transition: 'width 100ms linear' }}
              />
            </div>
          </div>

          <AdBanner
            adFree={false}
            variant="rectangle"
            slotIndex={2}
            onUpgradeClick={onSkipWithUpgrade}
          />
        </div>

        <div className="modal-footer">
          <button
            type="button"
            id="interstitial-skip-upgrade-btn"
            className="btn btn-primary"
            onClick={onSkipWithUpgrade}
          >
            Skip Wait & Remove Ads ($2.99)
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {remainingMs === 0 ? (
              <button
                type="button"
                id="interstitial-manual-dl-btn"
                className="btn btn-secondary"
                onClick={() => {
                  onCompleteDownload(files);
                  onClose();
                }}
              >
                Download Again & Close
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" disabled>
                Please wait {secondsLeft}s...
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DownloadInterstitialModal({
  queuedFiles,
  onClose,
  onCompleteDownload,
  onSkipWithUpgrade,
  formatBytes,
}: DownloadInterstitialModalProps) {
  if (!queuedFiles || queuedFiles.length === 0) return null;
  const key = queuedFiles.map((f) => f.id).join('|');
  return (
    <InterstitialDialogContent
      key={key}
      files={queuedFiles}
      onClose={onClose}
      onCompleteDownload={onCompleteDownload}
      onSkipWithUpgrade={onSkipWithUpgrade}
      formatBytes={formatBytes}
    />
  );
}
