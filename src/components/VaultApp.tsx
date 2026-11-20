'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { upload as vercelClientUpload } from '@vercel/blob/client';
import type { StoredFileItem, StorageMode, FileCategory } from '@/lib/storage';
import {
  ORDERED_LIFETIMES,
  LIFETIME_OPTIONS,
  canUseLifetime,
  type ActiveEntitlement,
  type LifetimeId,
} from '@/lib/monetization';
import FilePreviewModal from './FilePreviewModal';
import AdBanner from './AdBanner';
import DownloadInterstitialModal from './DownloadInterstitialModal';
import UpgradeModal from './UpgradeModal';
import FileLifetimeModal from './FileLifetimeModal';

interface VaultAppProps {
  initialAuthenticated: boolean;
  initialStorageMode: StorageMode;
  initialIsDefaultPassword: boolean;
  initialFiles: StoredFileItem[];
  initialEntitlement: ActiveEntitlement;
}

interface UploadQueueItem {
  uid: string;
  name: string;
  size: number;
  loadedBytes: number;
  progress: number;
  isMultipart: boolean;
  lifetimeLabel: string;
  status: 'uploading' | 'done' | 'error' | 'cancelled';
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

export function formatExpiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'Permanent';
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return 'Expired';

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (days >= 30) {
    const months = Math.floor(days / 30);
    return months >= 12 ? 'Expires in ~1 yr' : `Expires in ${days}d`;
  }
  if (days >= 1) {
    const remHours = hours % 24;
    return remHours > 0 ? `Expires in ${days}d ${remHours}h` : `Expires in ${days}d`;
  }
  const minutes = Math.max(1, Math.floor(diffMs / (1000 * 60)));
  return hours >= 1 ? `Expires in ${hours}h` : `Expires in ${minutes}m`;
}

function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  return diffMs > 0 && diffMs <= 48 * 60 * 60 * 1000;
}

function getExtensionBadge(filename: string, category: FileCategory): string {
  const parts = filename.split('.');
  if (parts.length > 1) {
    const ext = parts.pop()?.toUpperCase() || '';
    if (ext.length >= 1 && ext.length <= 5) return ext;
  }
  return category.slice(0, 4).toUpperCase();
}

function buildClientVaultPathname(rawName: string, lifetime: LifetimeId): string {
  const safeName =
    rawName.replace(/[\x00-\x1f\x80-\x9f/?<>\\:*|"]/g, '_').trim().slice(0, 200) ||
    'unnamed-file';
  const nowMs = Date.now();
  const durationMs = LIFETIME_OPTIONS[lifetime].durationMs;
  const expiresAtMs = durationMs === null ? 0 : nowMs + durationMs;
  const uniqueId = `${nowMs}-${Math.random().toString(16).slice(2, 12)}`;
  return `vault/exp_${expiresAtMs}_${lifetime}_${uniqueId}/${safeName}`;
}

export default function VaultApp({
  initialAuthenticated,
  initialStorageMode,
  initialIsDefaultPassword,
  initialFiles,
  initialEntitlement,
}: VaultAppProps) {
  // Auth & Entitlement state
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [storageMode, setStorageMode] = useState<StorageMode>(initialStorageMode);
  const [isDefaultPassword, setIsDefaultPassword] = useState(initialIsDefaultPassword);
  const [entitlement, setEntitlement] = useState<ActiveEntitlement>(initialEntitlement);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Theme state (lazy client initializer)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = localStorage.getItem('vaultdrop-theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  // Vault files state
  const [files, setFiles] = useState<StoredFileItem[]>(initialFiles);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [upgradeSuccessBanner, setUpgradeSuccessBanner] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('upgraded') === '1'
      ? 'Pass activated! You now have up to 5 TB large-file uploads, extended lifetimes, and ad-free instant downloads.'
      : null;
  });

  // Selected upload lifetime (defaults to '7d' — 1 Week Auto-Delete!)
  const [uploadLifetime, setUploadLifetime] = useState<LifetimeId>('7d');
  const effectiveLifetime: LifetimeId = canUseLifetime(entitlement, uploadLifetime).allowed
    ? uploadLifetime
    : '7d';

  // Upload state
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const abortControllersRef = useRef<Map<string, () => void>>(new Map());
  const pendingLargeFilesRef = useRef<File[] | null>(null);
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

  // Modals: Preview, Upgrade/Pricing, Download Interstitial, Edit File Lifetime
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewFile, setPreviewFile] = useState<StoredFileItem | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [upgradeModalOpen, setUpgradeModalOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('upgraded') === '1';
  });
  const [upgradeReason, setUpgradeReason] = useState<string | null>(null);
  const [interstitialFiles, setInterstitialFiles] = useState<StoredFileItem[] | null>(null);
  const [lifetimeEditFile, setLifetimeEditFile] = useState<StoredFileItem | null>(null);

  // Synchronize external DOM data-theme attribute & clean URL query string
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('upgraded') || params.has('checkout')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('vaultdrop-theme', next);
  };

  const openUpgradeWithReason = useCallback(
    (reason: string | null = null) => {
      setUpgradeReason(reason);
      setUpgradeModalOpen(true);
    },
    [setUpgradeReason, setUpgradeModalOpen]
  );

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
      if (data.entitlement) setEntitlement(data.entitlement);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Error loading files');
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  const triggerDirectDownloads = useCallback((targetFiles: StoredFileItem[]) => {
    targetFiles.forEach((file, idx) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = `/api/files/download?id=${encodeURIComponent(file.id)}`;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, idx * 240);
    });
  }, []);

  const handleRequestDownload = (targetFiles: StoredFileItem[]) => {
    if (targetFiles.length === 0) return;
    if (entitlement.adFree) {
      triggerDirectDownloads(targetFiles);
    } else {
      setInterstitialFiles(targetFiles);
    }
  };

  const handleCancelUpload = (uid: string) => {
    const abortFn = abortControllersRef.current.get(uid);
    if (abortFn) {
      abortFn();
      abortControllersRef.current.delete(uid);
    }
    setUploadQueue((prev) =>
      prev.map((item) =>
        item.uid === uid
          ? { ...item, status: 'cancelled', errorMessage: 'Cancelled by user' }
          : item
      )
    );
  };

  // Upload handler enforcing Free (250 MB) vs Paid (5 TB) limits & selected lifetime
  const handleFilesUpload = useCallback(
    async (
      incomingFiles: FileList | File[],
      overrideEntitlement?: ActiveEntitlement,
      overrideLifetime?: LifetimeId
    ) => {
      const fileArray = Array.from(incomingFiles);
      if (fileArray.length === 0) return;

      const activeEnt = overrideEntitlement || entitlement;
      const activeLifetime = overrideLifetime || effectiveLifetime;

      // 1. Check lifetime entitlement
      const lifetimePerm = canUseLifetime(activeEnt, activeLifetime);
      if (!lifetimePerm.allowed) {
        pendingLargeFilesRef.current = fileArray;
        openUpgradeWithReason(
          lifetimePerm.reason ||
            'Extended file retention requires a Paid Pass or Pro Unlimited.'
        );
        return;
      }

      // 2. Check file size limits (250 MB Free vs 5 TB Paid)
      const oversized = fileArray.find((f) => f.size > activeEnt.maxFileBytes);
      if (oversized) {
        pendingLargeFilesRef.current = fileArray;
        openUpgradeWithReason(
          `"${oversized.name}" (${formatBytes(
            oversized.size
          )}) exceeds the ${formatBytes(
            activeEnt.maxFileBytes
          )} Free Tier limit. Unlock a Large File Pass ($2.99) or Pro Unlimited ($9/mo) to upload files up to 5 TB.`
        );
        return;
      }

      pendingLargeFilesRef.current = null;
      setGlobalError(null);

      const MULTIPART_THRESHOLD = 4 * 1024 * 1024;
      const lifetimeShortLabel = LIFETIME_OPTIONS[activeLifetime].shortLabel;

      const newQueueItems: UploadQueueItem[] = fileArray.map((f, idx) => ({
        uid: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name,
        size: f.size,
        loadedBytes: 0,
        progress: 0,
        isMultipart: f.size > MULTIPART_THRESHOLD,
        lifetimeLabel: lifetimeShortLabel,
        status: 'uploading',
      }));

      setUploadQueue((prev) => [...newQueueItems, ...prev]);

      for (let i = 0; i < fileArray.length; i++) {
        const file = fileArray[i];
        const queueItem = newQueueItems[i];
        const useMultipart = file.size > MULTIPART_THRESHOLD;

        try {
          if (storageMode === 'vercel-blob') {
            const abortController = new AbortController();
            abortControllersRef.current.set(queueItem.uid, () =>
              abortController.abort()
            );

            const pathname = buildClientVaultPathname(file.name, activeLifetime);

            await vercelClientUpload(pathname, file, {
              access: 'public',
              handleUploadUrl: '/api/files/client-upload',
              multipart: useMultipart,
              contentType: file.type || undefined,
              clientPayload: JSON.stringify({
                lifetime: activeLifetime,
                size: file.size,
              }),
              abortSignal: abortController.signal,
              onUploadProgress: (progressEvent) => {
                setUploadQueue((prev) =>
                  prev.map((item) =>
                    item.uid === queueItem.uid
                      ? {
                          ...item,
                          loadedBytes: progressEvent.loaded,
                          progress: Math.min(99, Math.round(progressEvent.percentage)),
                        }
                      : item
                  )
                );
              },
            });

            abortControllersRef.current.delete(queueItem.uid);

            setUploadQueue((prev) =>
              prev.map((item) =>
                item.uid === queueItem.uid
                  ? {
                      ...item,
                      loadedBytes: file.size,
                      progress: 100,
                      status: 'done',
                    }
                  : item
              )
            );
            await fetchFiles();
          } else {
            // Local Disk mode: stream raw binary file via PUT /api/files with lifetime & size params
            const uploadedItem = await new Promise<StoredFileItem>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              abortControllersRef.current.set(queueItem.uid, () => xhr.abort());

              xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable) {
                  const pct = Math.min(99, Math.round((event.loaded / event.total) * 100));
                  setUploadQueue((prev) =>
                    prev.map((item) =>
                      item.uid === queueItem.uid
                        ? { ...item, loadedBytes: event.loaded, progress: pct }
                        : item
                    )
                  );
                }
              });

              xhr.addEventListener('load', () => {
                try {
                  const response = JSON.parse(xhr.responseText || '{}');
                  if (xhr.status === 402) {
                    openUpgradeWithReason(response.error || 'Upgrade required.');
                    reject(new Error(response.error || 'Upgrade required'));
                    return;
                  }
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

              xhr.addEventListener('abort', () => {
                reject(new Error('ABORTED'));
              });

              const putUrl = `/api/files?name=${encodeURIComponent(
                file.name
              )}&type=${encodeURIComponent(
                file.type || 'application/octet-stream'
              )}&lifetime=${encodeURIComponent(activeLifetime)}&size=${file.size}`;
              xhr.open('PUT', putUrl);
              xhr.setRequestHeader(
                'Content-Type',
                file.type || 'application/octet-stream'
              );
              xhr.send(file);
            });

            abortControllersRef.current.delete(queueItem.uid);

            setUploadQueue((prev) =>
              prev.map((item) =>
                item.uid === queueItem.uid
                  ? {
                      ...item,
                      loadedBytes: file.size,
                      progress: 100,
                      status: 'done',
                    }
                  : item
              )
            );

            setFiles((prev) => [uploadedItem, ...prev]);
          }
        } catch (err) {
          abortControllersRef.current.delete(queueItem.uid);
          const message = err instanceof Error ? err.message : 'Upload failed';
          if (message === 'ABORTED' || (err instanceof Error && err.name === 'AbortError')) {
            continue;
          }
          if (message.includes('UPGRADE_REQUIRED')) {
            openUpgradeWithReason(message.replace(/^UPGRADE_REQUIRED:\s*/, ''));
          }
          setUploadQueue((prev) =>
            prev.map((item) =>
              item.uid === queueItem.uid && item.status !== 'cancelled'
                ? { ...item, status: 'error', errorMessage: message }
                : item
            )
          );
        }
      }
    },
    [entitlement, effectiveLifetime, storageMode, fetchFiles, openUpgradeWithReason]
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
      if (data.entitlement) setEntitlement(data.entitlement);
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

  const handleSelectLifetimeOption = (optId: LifetimeId) => {
    const check = canUseLifetime(entitlement, optId);
    if (!check.allowed) {
      openUpgradeWithReason(
        check.reason ||
          'Upgrade your pass to keep files online for 30 days, 1 year, or permanently.'
      );
      return;
    }
    setUploadLifetime(optId);
  };

  // Filtered and sorted files
  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = files.filter((file) => {
      if (selectedCategory !== 'all' && file.category !== selectedCategory) {
        return false;
      }
      if (
        q &&
        !file.name.toLowerCase().includes(q) &&
        !file.contentType.toLowerCase().includes(q)
      ) {
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
    handleRequestDownload(selectedList);
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
            {/* Tier / Upgrade Button */}
            {authenticated &&
              (entitlement.tier === 'paid' ? (
                <button
                  type="button"
                  id="topbar-active-pass-btn"
                  className="tier-topbar-btn pro"
                  onClick={() => openUpgradeWithReason(null)}
                  title="View active pass & copy portable License Key"
                >
                  <span className="storage-dot" />
                  <span>Pro Active · 5 TB + Ad-Free</span>
                </button>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                  <span className="storage-badge hide-mobile">
                    Free Tier · 250 MB / 7d Max
                  </span>
                  <button
                    type="button"
                    id="topbar-upgrade-btn"
                    className="btn btn-primary"
                    style={{ padding: '0.42rem 0.85rem', fontSize: '0.8rem' }}
                    onClick={() => openUpgradeWithReason(null)}
                  >
                    Upgrade / Go Pro
                  </button>
                </div>
              ))}

            <div
              className="storage-badge hide-mobile"
              title={
                storageMode === 'vercel-blob'
                  ? 'Connected to Vercel Blob cloud storage'
                  : 'Using Local Disk storage'
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
                Lock
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content: Either Password Gate OR Authenticated Vault */}
      {!authenticated ? (
        <main className="auth-wrapper" style={{ flexDirection: 'column', gap: '1.25rem' }}>
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
              <span>Free: 250 MB · 7-Day Auto-Delete</span>
              <span className="mono">Pro: 5 TB · Permanent</span>
            </div>
          </section>

          {/* Login Gate Sponsor Placement (hidden for Pro users) */}
          <div style={{ width: '100%', maxWidth: '440px' }}>
            <AdBanner
              adFree={entitlement.adFree}
              variant="compact"
              slotIndex={1}
              onUpgradeClick={() =>
                setAuthError('Unlock the vault first to purchase or activate a Pro pass.')
              }
            />
          </div>
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
                  Selected lifetime: <strong>{LIFETIME_OPTIONS[effectiveLifetime].label}</strong> · Max
                  size: <strong>{formatBytes(entitlement.maxFileBytes)}</strong>
                </p>
              </div>
            </div>
          )}

          {upgradeSuccessBanner && (
            <div className="alert-banner alert-success" role="status">
              <span>{upgradeSuccessBanner}</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setUpgradeSuccessBanner(null)}
              >
                Dismiss
              </button>
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

          {/* Dropzone + File Auto-Delete Lifetime Bar */}
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
                    {entitlement.tier === 'paid'
                      ? 'Paid Pass Unlocked: Upload up to 5 TB per file with 8 MB parallel multipart chunking.'
                      : 'Free Tier: Up to 250 MB per file (default 1-week auto-delete). Need 500 MB+ or long-term storage?'}{' '}
                    {entitlement.tier !== 'paid' && (
                      <button
                        type="button"
                        className="inline-upgrade-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          openUpgradeWithReason(null);
                        }}
                      >
                        Unlock 5 TB & Permanent Storage →
                      </button>
                    )}
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

            {/* File Auto-Delete Lifetime Selector */}
            <div
              className="lifetime-selector-bar"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="lifetime-bar-label">
                Auto-Delete Lifetime:
              </span>
              <div className="lifetime-pills" role="radiogroup" aria-label="File auto-delete lifetime">
                {ORDERED_LIFETIMES.map((opt) => {
                  const allowed = canUseLifetime(entitlement, opt.id).allowed;
                  const active = effectiveLifetime === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      id={`lifetime-opt-${opt.id}`}
                      className={`lifetime-pill ${active ? 'active' : ''} ${
                        !allowed ? 'locked' : ''
                      }`}
                      onClick={() => handleSelectLifetimeOption(opt.id)}
                    >
                      <span>{opt.label}</span>
                      {!allowed && (
                        <span className="lock-tag" aria-label="Requires upgrade">
                          PRO
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Ad Placement for Free Tier Users (Automatically Hidden for Paid Users) */}
          <AdBanner
            adFree={entitlement.adFree}
            variant="leaderboard"
            slotIndex={0}
            onUpgradeClick={() => openUpgradeWithReason(null)}
          />

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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                        <span className="upload-item-name">{item.name}</span>
                        <span className="expiry-pill">{item.lifetimeLabel}</span>
                        {item.isMultipart && (
                          <span className="expiry-pill">Multipart 8MB</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexShrink: 0 }}>
                        <span className="mono" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                          {item.status === 'uploading' &&
                            `${formatBytes(item.loadedBytes)} / ${formatBytes(item.size)} (${item.progress}%)`}
                          {item.status === 'done' && `Uploaded · ${formatBytes(item.size)}`}
                          {item.status === 'cancelled' && 'Cancelled'}
                          {item.status === 'error' && (
                            <span style={{ color: 'var(--status-danger)' }}>
                              {item.errorMessage || 'Failed'}
                            </span>
                          )}
                        </span>
                        {item.status === 'uploading' && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ padding: '0.15rem 0.45rem', fontSize: '0.73rem', color: 'var(--status-danger)' }}
                            onClick={() => handleCancelUpload(item.uid)}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="upload-progress-track">
                      <div
                        className={`upload-progress-fill ${
                          item.status === 'done'
                            ? 'done'
                            : item.status === 'error' || item.status === 'cancelled'
                            ? 'error'
                            : ''
                        }`}
                        style={{
                          width: `${
                            item.status === 'error' || item.status === 'cancelled'
                              ? 100
                              : item.progress
                          }%`,
                        }}
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
                    <th>Size</th>
                    <th>Auto-Delete / Lifetime</th>
                    <th className="hide-mobile">Uploaded</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFiles.map((file) => {
                    const isSelected = selectedIds.has(file.id);
                    const isDeleting = deletingIds.has(file.id);
                    const inlineUrl = `/api/files/download?id=${encodeURIComponent(file.id)}&inline=1`;
                    const expiryText = formatExpiryLabel(file.expiresAt);
                    const soon = isExpiringSoon(file.expiresAt);

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
                              <span className="file-submeta">
                                {file.category.toUpperCase()} · {file.contentType.split(';')[0]}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="mono" style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                          {formatBytes(file.size)}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            className={`expiry-pill clickable ${
                              !file.expiresAt
                                ? 'permanent'
                                : soon
                                ? 'warning'
                                : ''
                            }`}
                            onClick={() => setLifetimeEditFile(file)}
                            title="Click to extend or change auto-delete lifetime"
                          >
                            <span>{expiryText}</span>
                            <span style={{ opacity: 0.7 }}>· Extend</span>
                          </button>
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
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ padding: '0.38rem 0.72rem', fontSize: '0.8rem' }}
                              onClick={() => handleRequestDownload([file])}
                              title={`Download ${file.name}`}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                              </svg>
                              Download
                            </button>
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
                const inlineUrl = `/api/files/download?id=${encodeURIComponent(file.id)}&inline=1`;
                const expiryText = formatExpiryLabel(file.expiresAt);
                const soon = isExpiringSoon(file.expiresAt);

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
                        <button
                          type="button"
                          className={`expiry-pill clickable ${
                            !file.expiresAt ? 'permanent' : soon ? 'warning' : ''
                          }`}
                          onClick={() => setLifetimeEditFile(file)}
                        >
                          {expiryText}
                        </button>
                      </div>

                      <div className="file-grid-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ flex: 1, padding: '0.4rem 0.6rem', fontSize: '0.78rem' }}
                          onClick={() => handleRequestDownload([file])}
                        >
                          Download
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.4rem 0.6rem', fontSize: '0.78rem' }}
                          onClick={() => setLifetimeEditFile(file)}
                        >
                          Extend
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
        onRequestDownload={(f) => handleRequestDownload([f])}
        onEditLifetime={(f) => {
          setPreviewFile(null);
          setLifetimeEditFile(f);
        }}
        formatBytes={formatBytes}
        formatDate={formatDate}
        formatExpiryLabel={formatExpiryLabel}
      />

      {/* 5-Second Sponsored Download Interstitial (Free Tier Only) */}
      <DownloadInterstitialModal
        queuedFiles={interstitialFiles}
        onClose={() => setInterstitialFiles(null)}
        onCompleteDownload={(dlFiles) => {
          triggerDirectDownloads(dlFiles);
          setInterstitialFiles(null);
        }}
        onSkipWithUpgrade={() => {
          setInterstitialFiles(null);
          openUpgradeWithReason(
            'Upgrade to skip the 5-second sponsored download wait and remove all ads.'
          );
        }}
        formatBytes={formatBytes}
      />

      {/* Change / Extend File Lifetime Modal */}
      <FileLifetimeModal
        file={lifetimeEditFile}
        entitlement={entitlement}
        onClose={() => setLifetimeEditFile(null)}
        onUpdated={(updatedFile) => {
          setFiles((prev) =>
            prev.map((f) =>
              f.name === updatedFile.name && f.uploadedAt === updatedFile.uploadedAt
                ? updatedFile
                : f.id === lifetimeEditFile?.id
                ? updatedFile
                : f
            )
          );
        }}
        onRequireUpgrade={(reason) => openUpgradeWithReason(reason)}
        formatExpiryLabel={formatExpiryLabel}
      />

      {/* Upgrade / Pricing / License Key Modal */}
      <UpgradeModal
        open={upgradeModalOpen}
        reasonBanner={upgradeReason}
        entitlement={entitlement}
        onClose={() => {
          setUpgradeModalOpen(false);
          setUpgradeReason(null);
        }}
        onEntitlementUpdated={(nextEnt) => {
          setEntitlement(nextEnt);
          // If the user had queued large files waiting on upgrade, start uploading them automatically!
          if (nextEnt.tier === 'paid' && pendingLargeFilesRef.current) {
            const queued = pendingLargeFilesRef.current;
            pendingLargeFilesRef.current = null;
            handleFilesUpload(queued, nextEnt);
          }
        }}
      />
    </div>
  );
}
