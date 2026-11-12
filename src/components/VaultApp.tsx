'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { upload as vercelClientUpload } from '@vercel/blob/client';
import type { StoredFileItem, StorageMode, FileCategory } from '@/lib/storage';
import FilePreviewModal from './FilePreviewModal';

interface VaultAppProps {
  initialAuthenticated: boolean;
  initialStorageMode: StorageMode;
  initialIsDefaultPassword: boolean;
  initialFiles: StoredFileItem[];
}

interface UploadQueueItem {
  uid: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  errorMessage?: string;
}

type SortField = 'uploadedAt' | 'name' | 'size';
type SortOrder = 'asc' | 'desc';
type ViewMode = 'table' | 'grid';

const CATEGORY_FILTERS: { value: 'all' | FileCategory; label: string }[] = [
  { value: 'all', label: 'All Files' },
  { value: 'image', label: 'Images' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'document', label: 'Docs' },
  { value: 'code', label: 'Code' },
  { value: 'text', label: 'Text' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'archive', label: 'Archives' },
];

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${sizes[i]}`;
}

export function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return iso;
  }
}

function getExtensionBadge(filename: string, category: FileCategory): string {
  const parts = filename.split('.');
  if (parts.length > 1) {
    const ext = parts.pop()?.toUpperCase() || '';
    if (ext.length >= 1 && ext.length <= 5) return ext;
  }
  return category.slice(0, 4).toUpperCase();
}

export default function VaultApp({
  initialAuthenticated,
  initialStorageMode,
  initialIsDefaultPassword,
  initialFiles,
}: VaultAppProps) {
  // Auth state
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [storageMode, setStorageMode] = useState<StorageMode>(initialStorageMode);
  const [isDefaultPassword, setIsDefaultPassword] = useState(initialIsDefaultPassword);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Vault files state
  const [files, setFiles] = useState<StoredFileItem[]>(initialFiles);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Upload state
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [isDraggingOverZone, setIsDraggingOverZone] = useState(false);
  const [isDraggingOverWindow, setIsDraggingOverWindow] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Filter, sort & view state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | FileCategory>('all');
  const [sortField, setSortField] = useState<SortField>('uploadedAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [viewMode, setViewMode] = useState<ViewMode>('table');

  // Selection & Preview modal state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewFile, setPreviewFile] = useState<StoredFileItem | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  // Initialize theme from localStorage or system preference
  useEffect(() => {
    const saved = localStorage.getItem('vaultdrop-theme') as 'light' | 'dark' | null;
    if (saved === 'dark' || saved === 'light') {
      setTheme(saved);
      document.documentElement.setAttribute('data-theme', saved);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setTheme('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('vaultdrop-theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  const fetchFiles = useCallback(async () => {
    setLoadingFiles(true);
    setGlobalError(null);
    try {
      const res = await fetch('/api/files', { cache: 'no-store' });
      if (res.status === 401) {
        setAuthenticated(false);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load files');
      }
      setFiles(data.files || []);
      if (data.storageMode) setStorageMode(data.storageMode);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Error loading files');
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  // Upload handler supporting both standard XHR progress and direct @vercel/blob/client for large files
  const handleFilesUpload = useCallback(
    async (incomingFiles: FileList | File[]) => {
      const fileArray = Array.from(incomingFiles);
      if (fileArray.length === 0) return;

      setGlobalError(null);

      const newQueueItems: UploadQueueItem[] = fileArray.map((f, idx) => ({
        uid: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name,
        size: f.size,
        progress: 0,
        status: 'uploading',
      }));

      setUploadQueue((prev) => [...newQueueItems, ...prev]);

      for (let i = 0; i < fileArray.length; i++) {
        const file = fileArray[i];
        const queueItem = newQueueItems[i];

        try {
          // Use direct @vercel/blob/client upload when in vercel-blob mode and file > 4 MB
          if (storageMode === 'vercel-blob' && file.size > 4 * 1024 * 1024) {
            const uniquePrefix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
            const safeName = file.name.replace(/[^\w.\- ()]/g, '_');
            await vercelClientUpload(`vault/${uniquePrefix}/${safeName}`, file, {
              access: 'public',
              handleUploadUrl: '/api/files/client-upload',
              onUploadProgress: (progressEvent) => {
                setUploadQueue((prev) =>
                  prev.map((item) =>
                    item.uid === queueItem.uid
                      ? { ...item, progress: Math.round(progressEvent.percentage) }
                      : item
                  )
                );
              },
            });

            setUploadQueue((prev) =>
              prev.map((item) =>
                item.uid === queueItem.uid
                  ? { ...item, progress: 100, status: 'done' }
                  : item
              )
            );
            await fetchFiles();
          } else {
            // Standard multipart XHR upload with granular progress events
            const uploadedItem = await new Promise<StoredFileItem>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              const formData = new FormData();
              formData.append('files', file);

              xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable) {
                  const pct = Math.min(99, Math.round((event.loaded / event.total) * 100));
                  setUploadQueue((prev) =>
                    prev.map((item) =>
                      item.uid === queueItem.uid ? { ...item, progress: pct } : item
                    )
                  );
                }
              });

              xhr.addEventListener('load', () => {
                try {
                  const response = JSON.parse(xhr.responseText || '{}');
                  if (xhr.status >= 200 && xhr.status < 300 && response.uploaded?.[0]) {
                    resolve(response.uploaded[0]);
                  } else {
                    reject(new Error(response.error || `Upload failed (HTTP ${xhr.status})`));
                  }
                } catch {
                  reject(new Error(`Upload failed (HTTP ${xhr.status})`));
                }
              });

              xhr.addEventListener('error', () => {
                reject(new Error('Network error while uploading file.'));
              });

              xhr.open('POST', '/api/files');
              xhr.send(formData);
            });

            setUploadQueue((prev) =>
              prev.map((item) =>
                item.uid === queueItem.uid
                  ? { ...item, progress: 100, status: 'done' }
                  : item
              )
            );

            setFiles((prev) => [uploadedItem, ...prev]);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Upload failed';
          setUploadQueue((prev) =>
            prev.map((item) =>
              item.uid === queueItem.uid
                ? { ...item, status: 'error', errorMessage: message }
                : item
            )
          );
        }
      }
    },
    [storageMode, fetchFiles]
  );

  // Full-window drag-and-drop and clipboard paste support when authenticated
  useEffect(() => {
    if (!authenticated) return;

    const handleWindowDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) {
        setIsDraggingOverWindow(true);
      }
    };

    const handleWindowDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    };

    const handleWindowDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setIsDraggingOverWindow(false);
      }
    };

    const handleWindowDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingOverWindow(false);
      setIsDraggingOverZone(false);
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        handleFilesUpload(e.dataTransfer.files);
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
        e.preventDefault();
        handleFilesUpload(e.clipboardData.files);
      }
    };

    window.addEventListener('dragenter', handleWindowDragEnter);
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('dragleave', handleWindowDragLeave);
    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('paste', handlePaste);

    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter);
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('dragleave', handleWindowDragLeave);
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('paste', handlePaste);
    };
  }, [authenticated, handleFilesUpload]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setAuthError('Please enter the access password.');
      return;
    }

    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Invalid password.');
        return;
      }

      setAuthenticated(true);
      if (data.storageMode) setStorageMode(data.storageMode);
      if (typeof data.isDefaultPassword === 'boolean') {
        setIsDefaultPassword(data.isDefaultPassword);
      }
      setPassword('');
      await fetchFiles();
    } catch {
      setAuthError('Network error while verifying password.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthenticated(false);
    setFiles([]);
    setSelectedIds(new Set());
    setUploadQueue([]);
  };

  const handleDeleteFiles = async (idsToDelete: string[]) => {
    if (idsToDelete.length === 0) return;
    setGlobalError(null);
    setDeletingIds((prev) => {
      const next = new Set(prev);
      idsToDelete.forEach((id) => next.add(id));
      return next;
    });

    try {
      const res = await fetch('/api/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: idsToDelete }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete file(s).');
      }

      const deletedSet = new Set(idsToDelete);
      setFiles((prev) => prev.filter((f) => !deletedSet.has(f.id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        idsToDelete.forEach((id) => next.delete(id));
        return next;
      });
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        idsToDelete.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  // Filtered and sorted files
  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = files.filter((file) => {
      if (selectedCategory !== 'all' && file.category !== selectedCategory) {
        return false;
      }
      if (q && !file.name.toLowerCase().includes(q) && !file.contentType.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });

    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'uploadedAt') {
        cmp = new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime();
      } else if (sortField === 'size') {
        cmp = a.size - b.size;
      } else if (sortField === 'name') {
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [files, searchQuery, selectedCategory, sortField, sortOrder]);

  const totalStorageBytes = useMemo(
    () => files.reduce((sum, f) => sum + f.size, 0),
    [files]
  );

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredFiles.length && filteredFiles.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredFiles.map((f) => f.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleBatchDownload = () => {
    const selectedList = files.filter((f) => selectedIds.has(f.id));
    selectedList.forEach((file, idx) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = `/api/files/download?id=${encodeURIComponent(file.id)}`;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, idx * 220);
    });
  };

  return (
    <div className="app-shell">
      {/* Top Navigation Bar */}
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              VD
            </div>
            <div className="brand-text">
              <span className="brand-title">VaultDrop</span>
              <span className="brand-subtitle">Online File Vault</span>
            </div>
          </div>

          <div className="topbar-actions">
            <div
              className="storage-badge"
              title={
                storageMode === 'vercel-blob'
                  ? 'Connected to Vercel Blob cloud storage'
                  : 'Using Local Disk storage (set BLOB_READ_WRITE_TOKEN in Vercel for Vercel Blob)'
              }
            >
              <span
                className={`storage-dot ${storageMode === 'local-disk' ? 'local' : ''}`}
              />
              <span>
                {storageMode === 'vercel-blob' ? 'Vercel Blob' : 'Local Vault'}
              </span>
            </div>

            <button
              type="button"
              id="theme-toggle-btn"
              className="btn btn-secondary btn-icon"
              onClick={toggleTheme}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              aria-label="Toggle color theme"
            >
              {theme === 'light' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              )}
            </button>

            {authenticated && (
              <button
                type="button"
                id="logout-btn"
                className="btn btn-secondary"
                onClick={handleLogout}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                Lock Vault
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content: Either Password Gate OR Authenticated Vault */}
      {!authenticated ? (
        <main className="auth-wrapper">
          <section className="auth-card" aria-labelledby="auth-heading">
            <div className="auth-card-header">
              <span className="auth-index-label">Protected Access // 01</span>
              <h1 className="auth-heading" id="auth-heading">
                Enter Vault Password
              </h1>
              <p className="auth-description">
                Anyone with the shared password can unlock this vault to upload new files
                or download existing files from online storage.
              </p>
            </div>

            <form className="auth-card-body" onSubmit={handleLogin}>
              {authError && (
                <div className="alert-banner alert-error" role="alert" id="auth-error-banner">
                  <span>{authError}</span>
                </div>
              )}

              <div className="field-group">
                <label className="field-label" htmlFor="password-input">
                  <span>Shared Access Password</span>
                  <span className="mono" style={{ fontSize: '0.72rem', fontWeight: 400 }}>
                    HMAC-SHA256 Session
                  </span>
                </label>
                <div className="password-input-wrap">
                  <input
                    id="password-input"
                    type={showPassword ? 'text' : 'password'}
                    className="text-input"
                    placeholder="Enter password to unlock..."
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    id="toggle-password-visibility-btn"
                    className="password-toggle-btn"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {isDefaultPassword && (
                <div className="auth-hint-box" id="default-password-hint">
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.15rem' }}>
                      Default Password Active
                    </div>
                    <div>
                      Use <span className="auth-hint-code">vault2026</span> or set{' '}
                      <span className="mono">APP_PASSWORD</span> in Vercel environment variables.
                    </div>
                  </div>
                  <button
                    type="button"
                    id="fill-default-password-btn"
                    className="btn btn-secondary"
                    style={{ padding: '0.32rem 0.6rem', fontSize: '0.75rem' }}
                    onClick={() => setPassword('vault2026')}
                  >
                    Auto-fill
                  </button>
                </div>
              )}

              <button
                type="submit"
                id="login-submit-btn"
                className="btn btn-primary"
                style={{ width: '100%', padding: '0.72rem 1rem', fontSize: '0.92rem' }}
                disabled={authLoading}
              >
                {authLoading ? 'Verifying Access...' : 'Unlock File Vault'}
              </button>
            </form>

            <div className="auth-card-footer">
              <span>Encrypted Cookie Session</span>
              <span className="mono">7-Day Persistence</span>
            </div>
          </section>
        </main>
      ) : (
        <main className="vault-main">
          {/* Full-window drag overlay */}
          {isDraggingOverWindow && (
            <div className="window-drop-overlay" aria-hidden="true">
              <div className="window-drop-frame">
                <div className="dropzone-icon-box" style={{ width: '56px', height: '56px' }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <h2 style={{ fontSize: '1.3rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
                  Drop files anywhere to upload
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  Release your mouse to immediately upload files to the online vault.
                </p>
              </div>
            </div>
          )}

          {/* Hidden multi-file input */}
          <input
            ref={fileInputRef}
            id="file-upload-input"
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleFilesUpload(e.target.files);
                e.target.value = '';
              }
            }}
          />

          {/* Dropzone Panel */}
          <section
            id="dropzone-panel"
            className={`dropzone-panel ${isDraggingOverZone ? 'active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingOverZone(true);
            }}
            onDragLeave={() => setIsDraggingOverZone(false)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dragCounterRef.current = 0;
              setIsDraggingOverWindow(false);
              setIsDraggingOverZone(false);
              if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
                handleFilesUpload(e.dataTransfer.files);
              }
            }}
          >
            <div className="dropzone-content">
              <div className="dropzone-left">
                <div className="dropzone-icon-box">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <div>
                  <h1 className="dropzone-title">
                    Drop files here, paste from clipboard, or browse to upload
                  </h1>
                  <p className="dropzone-subtitle">
                    Supports any file format (images, PDFs, archives, documents, audio, video, code).
                    Multi-file upload enabled.
                  </p>
                </div>
              </div>

              <div className="dropzone-right" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  id="browse-files-btn"
                  className="btn btn-primary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Select Files to Upload
                </button>
              </div>
            </div>
          </section>

          {/* Active / Recent Upload Queue Drawer */}
          {uploadQueue.length > 0 && (
            <section className="upload-queue" aria-label="Upload Progress">
              <div className="upload-queue-header">
                <span>
                  Upload Queue ({uploadQueue.filter((i) => i.status === 'done').length}/
                  {uploadQueue.length} completed)
                </span>
                <button
                  type="button"
                  id="clear-upload-queue-btn"
                  className="btn btn-ghost"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() =>
                    setUploadQueue((prev) => prev.filter((item) => item.status === 'uploading'))
                  }
                >
                  Dismiss Completed
                </button>
              </div>
              <div className="upload-queue-list">
                {uploadQueue.map((item) => (
                  <div key={item.uid} className="upload-queue-item">
                    <div className="upload-item-top">
                      <span className="upload-item-name">{item.name}</span>
                      <span className="mono" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                        {item.status === 'uploading' && `${item.progress}% · ${formatBytes(item.size)}`}
                        {item.status === 'done' && `Uploaded · ${formatBytes(item.size)}`}
                        {item.status === 'error' && (
                          <span style={{ color: 'var(--status-danger)' }}>
                            {item.errorMessage || 'Failed'}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="upload-progress-track">
                      <div
                        className={`upload-progress-fill ${
                          item.status === 'done' ? 'done' : item.status === 'error' ? 'error' : ''
                        }`}
                        style={{ width: `${item.status === 'error' ? 100 : item.progress}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {globalError && (
            <div className="alert-banner alert-error" role="alert">
              <span>{globalError}</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setGlobalError(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Vault Controls & Filter Bar */}
          <section className="vault-controls-bar">
            <div className="vault-summary-strip">
              <div className="vault-heading-group">
                <h2 className="vault-section-title">Stored Files</h2>
                <div className="vault-metrics">
                  <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
                  <span>·</span>
                  <span>{formatBytes(totalStorageBytes)} total</span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {selectedIds.size > 0 && (
                  <>
                    <button
                      type="button"
                      id="batch-download-btn"
                      className="btn btn-secondary"
                      onClick={handleBatchDownload}
                    >
                      Download Selected ({selectedIds.size})
                    </button>
                    <button
                      type="button"
                      id="batch-delete-btn"
                      className="btn btn-danger"
                      onClick={() => handleDeleteFiles(Array.from(selectedIds))}
                    >
                      Delete Selected ({selectedIds.size})
                    </button>
                  </>
                )}

                <button
                  type="button"
                  id="refresh-files-btn"
                  className="btn btn-secondary"
                  onClick={fetchFiles}
                  disabled={loadingFiles}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  {loadingFiles ? 'Syncing...' : 'Refresh'}
                </button>
              </div>
            </div>

            <div className="vault-toolbar">
              <div className="toolbar-left">
                <div className="search-box">
                  <svg
                    className="search-icon"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    id="search-files-input"
                    type="text"
                    className="search-input"
                    placeholder="Search by filename or type..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      id="clear-search-btn"
                      className="search-clear-btn"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <div className="category-pills" role="tablist" aria-label="File category filter">
                  {CATEGORY_FILTERS.map((cat) => (
                    <button
                      key={cat.value}
                      type="button"
                      id={`filter-cat-${cat.value}`}
                      className={`category-pill ${selectedCategory === cat.value ? 'active' : ''}`}
                      onClick={() => setSelectedCategory(cat.value)}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="toolbar-right">
                <select
                  id="sort-files-select"
                  className="select-control"
                  value={`${sortField}:${sortOrder}`}
                  onChange={(e) => {
                    const [field, order] = e.target.value.split(':') as [SortField, SortOrder];
                    setSortField(field);
                    setSortOrder(order);
                  }}
                  aria-label="Sort files"
                >
                  <option value="uploadedAt:desc">Newest first</option>
                  <option value="uploadedAt:asc">Oldest first</option>
                  <option value="name:asc">Name (A → Z)</option>
                  <option value="name:desc">Name (Z → A)</option>
                  <option value="size:desc">Size (Largest)</option>
                  <option value="size:asc">Size (Smallest)</option>
                </select>

                <div className="view-Switch" role="group" aria-label="View mode">
                  <button
                    type="button"
                    id="view-table-btn"
                    className={`view-switch-btn ${viewMode === 'table' ? 'active' : ''}`}
                    onClick={() => setViewMode('table')}
                    title="Archival Table View"
                    aria-label="Table view"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="8" y1="6" x2="21" y2="6" />
                      <line x1="8" y1="12" x2="21" y2="12" />
                      <line x1="8" y1="18" x2="21" y2="18" />
                      <line x1="3" y1="6" x2="3.01" y2="6" />
                      <line x1="3" y1="12" x2="3.01" y2="12" />
                      <line x1="3" y1="18" x2="3.01" y2="18" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    id="view-grid-btn"
                    className={`view-switch-btn ${viewMode === 'grid' ? 'active' : ''}`}
                    onClick={() => setViewMode('grid')}
                    title="Visual Grid View"
                    aria-label="Grid view"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="7" height="7" />
                      <rect x="14" y="3" width="7" height="7" />
                      <rect x="14" y="14" width="7" height="7" />
                      <rect x="3" y="14" width="7" height="7" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* File List / Grid Content */}
          {filteredFiles.length === 0 ? (
            <div className="empty-state" id="empty-vault-state">
              <div className="empty-icon-circle">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
              </div>
              <h3 className="empty-title">
                {files.length === 0
                  ? 'No files uploaded to the vault yet'
                  : 'No files match your current filter'}
              </h3>
              <p className="empty-subtitle">
                {files.length === 0
                  ? 'Drag and drop files into the upload zone above or click "Select Files to Upload" to store your first file online.'
                  : 'Try clearing your search query or switching the category filter to "All Files".'}
              </p>
              {files.length === 0 ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Upload First File
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedCategory('all');
                  }}
                >
                  Reset Filters
                </button>
              )}
            </div>
          ) : viewMode === 'table' ? (
            <div className="files-table-container">
              <table className="files-table">
                <thead>
                  <tr>
                    <th style={{ width: '40px' }}>
                      <input
                        type="checkbox"
                        className="vault-checkbox"
                        checked={
                          filteredFiles.length > 0 &&
                          selectedIds.size === filteredFiles.length
                        }
                        onChange={toggleSelectAll}
                        aria-label="Select all visible files"
                      />
                    </th>
                    <th>File Name</th>
                    <th className="hide-mobile">Category / MIME</th>
                    <th>Size</th>
                    <th className="hide-mobile">Uploaded</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFiles.map((file) => {
                    const isSelected = selectedIds.has(file.id);
                    const isDeleting = deletingIds.has(file.id);
                    const downloadUrl = `/api/files/download?id=${encodeURIComponent(file.id)}`;
                    const inlineUrl = `/api/files/download?id=${encodeURIComponent(file.id)}&inline=1`;

                    return (
                      <tr key={file.id} className={isSelected ? 'selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            className="vault-checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectOne(file.id)}
                            aria-label={`Select ${file.name}`}
                          />
                        </td>
                        <td>
                          <div className="file-cell-main">
                            <div
                              className="file-type-badge"
                              onClick={() => setPreviewFile(file)}
                              style={{ cursor: 'pointer' }}
                            >
                              {file.category === 'image' ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={inlineUrl} alt={file.name} loading="lazy" />
                              ) : (
                                getExtensionBadge(file.name, file.category)
                              )}
                            </div>
                            <div className="file-name-wrap">
                              <button
                                type="button"
                                className="file-name-btn"
                                onClick={() => setPreviewFile(file)}
                                title={`Preview ${file.name}`}
                              >
                                {file.name}
                              </button>
                              <span className="file-submeta">{file.category.toUpperCase()}</span>
                            </div>
                          </div>
                        </td>
                        <td className="hide-mobile mono" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                          {file.contentType.split(';')[0]}
                        </td>
                        <td className="mono" style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                          {formatBytes(file.size)}
                        </td>
                        <td className="hide-mobile mono" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {formatDate(file.uploadedAt)}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => setPreviewFile(file)}
                              title="Preview file"
                            >
                              Preview
                            </button>
                            <a
                              href={downloadUrl}
                              download={file.name}
                              className="btn btn-secondary"
                              style={{ padding: '0.38rem 0.72rem', fontSize: '0.8rem' }}
                              title={`Download ${file.name}`}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                              </svg>
                              Download
                            </a>
                            <button
                              type="button"
                              className="btn btn-ghost btn-icon"
                              style={{ color: 'var(--status-danger)' }}
                              disabled={isDeleting}
                              onClick={() => handleDeleteFiles([file.id])}
                              title={`Delete ${file.name}`}
                              aria-label={`Delete ${file.name}`}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="files-grid">
              {filteredFiles.map((file) => {
                const isSelected = selectedIds.has(file.id);
                const isDeleting = deletingIds.has(file.id);
                const downloadUrl = `/api/files/download?id=${encodeURIComponent(file.id)}`;
                const inlineUrl = `/api/files/download?id=${encodeURIComponent(file.id)}&inline=1`;

                return (
                  <div
                    key={file.id}
                    className={`file-grid-card ${isSelected ? 'selected' : ''}`}
                  >
                    <div
                      className="file-grid-preview"
                      onClick={() => setPreviewFile(file)}
                    >
                      <input
                        type="checkbox"
                        className="file-grid-checkbox"
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelectOne(file.id)}
                        aria-label={`Select ${file.name}`}
                      />
                      {file.category === 'image' ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={inlineUrl} alt={file.name} loading="lazy" />
                      ) : (
                        <span className="file-grid-ext-tag">
                          {getExtensionBadge(file.name, file.category)}
                        </span>
                      )}
                    </div>

                    <div className="file-grid-body">
                      <div
                        className="file-grid-title"
                        onClick={() => setPreviewFile(file)}
                        title={file.name}
                      >
                        {file.name}
                      </div>

                      <div className="file-grid-meta">
                        <span>{formatBytes(file.size)}</span>
                        <span>{formatDate(file.uploadedAt).split(',')[0]}</span>
                      </div>

                      <div className="file-grid-actions">
                        <a
                          href={downloadUrl}
                          download={file.name}
                          className="btn btn-primary"
                          style={{ flex: 1, padding: '0.4rem 0.6rem', fontSize: '0.78rem' }}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.4rem 0.6rem', fontSize: '0.78rem' }}
                          onClick={() => setPreviewFile(file)}
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-icon"
                          disabled={isDeleting}
                          onClick={() => handleDeleteFiles([file.id])}
                          title="Delete file"
                          aria-label={`Delete ${file.name}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      )}

      {/* File Preview & Inspection Modal */}
      <FilePreviewModal
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        onDelete={(id) => handleDeleteFiles([id])}
        formatBytes={formatBytes}
        formatDate={formatDate}
      />
    </div>
  );
}
