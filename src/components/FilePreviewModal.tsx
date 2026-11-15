'use client';

import React, { useEffect, useState } from 'react';
import type { StoredFileItem } from '@/lib/storage';

interface FilePreviewModalProps {
  file: StoredFileItem | null;
  onClose: () => void;
  onDelete: (id: string) => void;
  formatBytes: (bytes: number) => string;
  formatDate: (iso: string) => string;
}

export default function FilePreviewModal({
  file,
  onClose,
  onDelete,
  formatBytes,
  formatDate,
}: FilePreviewModalProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const isTextPreviewable =
    file &&
    (file.category === 'text' || file.category === 'code') &&
    file.size <= 512 * 1024;

  useEffect(() => {
    if (!file) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [file, onClose]);

  useEffect(() => {
    if (!file || !isTextPreviewable) {
      setTextContent(null);
      setLoadingText(false);
      return;
    }

    let cancelled = false;
    setLoadingText(true);
    fetch(`/api/files/download?id=${encodeURIComponent(file.id)}&inline=1&proxy=1`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load text preview');
        return res.text();
      })
      .then((txt) => {
        if (!cancelled) {
          setTextContent(txt);
          setLoadingText(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTextContent('Unable to load text preview.');
          setLoadingText(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [file, isTextPreviewable]);

  if (!file) return null;

  const inlineUrl = `/api/files/download?id=${encodeURIComponent(file.id)}&inline=1`;
  const downloadUrl = `/api/files/download?id=${encodeURIComponent(file.id)}`;

  const handleCopyLink = async () => {
    const fullUrl = `${window.location.origin}${downloadUrl}`;
    await navigator.clipboard.writeText(fullUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleCopyText = async () => {
    if (textContent === null) return;
    await navigator.clipboard.writeText(textContent);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  return (
    <div
      className="modal-backdrop"
      id="file-preview-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-modal-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <div className="modal-title" id="preview-modal-title">
              {file.name}
            </div>
            <div className="modal-subtitle">
              {formatBytes(file.size)} · {file.contentType} · Uploaded{' '}
              {formatDate(file.uploadedAt)}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            {isTextPreviewable && textContent !== null && (
              <button
                type="button"
                id="preview-copy-text-btn"
                className="btn btn-secondary"
                onClick={handleCopyText}
              >
                {copiedText ? 'Copied Contents' : 'Copy Text'}
              </button>
            )}
            <button
              type="button"
              id="preview-close-btn"
              className="btn btn-ghost btn-icon"
              onClick={onClose}
              aria-label="Close preview"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="modal-body">
          {file.category === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={inlineUrl}
              alt={file.name}
              className="preview-image"
            />
          )}

          {file.category === 'video' && (
            <video
              src={inlineUrl}
              controls
              autoPlay
              className="preview-video"
            />
          )}

          {file.category === 'audio' && (
            <div style={{ width: '100%', maxWidth: '480px', textAlign: 'center' }}>
              <audio src={inlineUrl} controls autoPlay style={{ width: '100%' }} />
            </div>
          )}

          {file.category === 'pdf' && (
            <iframe
              src={inlineUrl}
              title={file.name}
              className="preview-iframe"
            />
          )}

          {isTextPreviewable && (
            <pre className="preview-code-block">
              {loadingText ? 'Loading file contents...' : textContent}
            </pre>
          )}

          {file.category !== 'image' &&
            file.category !== 'video' &&
            file.category !== 'audio' &&
            file.category !== 'pdf' &&
            !isTextPreviewable && (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <div
                  className="file-grid-ext-tag"
                  style={{ display: 'inline-block', marginBottom: '1rem' }}
                >
                  {file.name.includes('.')
                    ? file.name.split('.').pop()?.slice(0, 6)
                    : file.category}
                </div>
                <p style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
                  Binary / Archival File
                </p>
                <p
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--text-secondary)',
                    marginBottom: '1.25rem',
                  }}
                >
                  Direct in-browser preview is not available for this format ({file.contentType}).
                  Download the file below to open it locally.
                </p>
                <a
                  href={downloadUrl}
                  download={file.name}
                  className="btn btn-primary"
                  id="preview-center-download-btn"
                >
                  Download {file.name} ({formatBytes(file.size)})
                </a>
              </div>
            )}
        </div>

        <div className="modal-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              type="button"
              id="preview-delete-btn"
              className="btn btn-danger"
              onClick={() => {
                onDelete(file.id);
                onClose();
              }}
            >
              Delete File
            </button>
            <button
              type="button"
              id="preview-copy-link-btn"
              className="btn btn-secondary"
              onClick={handleCopyLink}
            >
              {copiedLink ? 'Download Link Copied' : 'Copy Download URL'}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <a
              href={inlineUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              id="preview-open-tab-btn"
            >
              Open Raw
            </a>
            <a
              href={downloadUrl}
              download={file.name}
              className="btn btn-primary"
              id="preview-download-btn"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download File
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
