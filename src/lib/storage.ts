import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { put, list, del, rename } from '@vercel/blob';
import {
  LIFETIME_OPTIONS,
  isValidLifetimeId,
  type LifetimeId,
} from './monetization';

export type StorageMode = 'vercel-blob' | 'local-disk';

export type FileCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'code'
  | 'text'
  | 'archive'
  | 'document'
  | 'other';

export interface StoredFileItem {
  id: string;
  name: string;
  size: number;
  contentType: string;
  category: FileCategory;
  uploadedAt: string;
  expiresAt: string | null; // ISO timestamp or null if permanent
  lifetime: LifetimeId;
  storageMode: StorageMode;
}

interface LocalMetaRecord {
  key: string;
  name: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  expiresAt?: string | null;
  lifetime?: LifetimeId;
}

export interface EncodedFileId {
  m: 'blob' | 'local';
  k: string; // blob URL or local key
  n: string; // original file name
  t?: string; // contentType
  e?: number; // expiresAt epoch ms (0 or undefined = permanent)
  l?: LifetimeId; // lifetime tier
  s?: number; // size in bytes (useful when renaming)
  u?: string; // uploadedAt ISO
}

const MIME_BY_EXT: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  // Documents & PDFs
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Code & Config
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  // Archives & Disk Images
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.iso': 'application/x-iso9660-image',
  '.dmg': 'application/x-apple-diskimage',
};

export function inferContentType(filename: string, providedType?: string): string {
  if (
    providedType &&
    providedType !== 'application/octet-stream' &&
    providedType.trim() !== ''
  ) {
    return providedType;
  }
  const ext = path.posix.extname(filename.toLowerCase());
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

export function categorizeFile(filename: string, contentType: string): FileCategory {
  const mime = contentType.toLowerCase();
  const ext = path.posix.extname(filename.toLowerCase());

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';

  const codeExts = new Set([
    '.js', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.css',
    '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.sh', '.yml',
    '.yaml', '.toml', '.xml', '.sql',
  ]);
  if (codeExts.has(ext) || mime.includes('json') || mime.includes('javascript') || mime.includes('xml')) {
    return 'code';
  }

  const archiveExts = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz', '.iso', '.dmg']);
  if (archiveExts.has(ext) || mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) {
    return 'archive';
  }

  if (mime.startsWith('text/') || ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.log') {
    return 'text';
  }

  const docExts = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt']);
  if (docExts.has(ext) || mime.includes('word') || mime.includes('excel') || mime.includes('sheet') || mime.includes('presentation')) {
    return 'document';
  }

  return 'other';
}

export function getStorageMode(): StorageMode {
  return process.env.BLOB_READ_WRITE_TOKEN ? 'vercel-blob' : 'local-disk';
}

export function sanitizeFilename(rawName: string): string {
  const base = path.posix.basename(rawName.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\x00-\x1f\x80-\x9f/?<>\\:*|"]/g, '_')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'unnamed-file';
}

export function computeExpirationMs(
  lifetime: LifetimeId,
  fromMs = Date.now()
): number {
  const cfg = LIFETIME_OPTIONS[lifetime];
  if (!cfg || cfg.durationMs === null) return 0;
  return fromMs + cfg.durationMs;
}

/**
 * Builds a structured vault pathname encoding expiration epoch ms and lifetime tier:
 * vault/exp_<expiresAtMs>_<lifetime>_<uniqueId>/<cleanName>
 */
export function buildVaultPathname(
  rawFilename: string,
  lifetime: LifetimeId = '7d',
  nowMs = Date.now()
): { pathname: string; cleanName: string; expiresAtMs: number } {
  const cleanName = sanitizeFilename(rawFilename);
  const expiresAtMs = computeExpirationMs(lifetime, nowMs);
  const uniqueId = `${nowMs}-${crypto.randomBytes(5).toString('hex')}`;
  const pathname = `vault/exp_${expiresAtMs}_${lifetime}_${uniqueId}/${cleanName}`;
  return { pathname, cleanName, expiresAtMs };
}

const VAULT_EXP_REGEX =
  /^vault\/exp_(\d+)_(1d|7d|30d|365d|forever)_([^/]+)\/(.+)$/;

export function parseVaultPathname(pathname: string): {
  name: string;
  expiresAtMs: number;
  expiresAt: string | null;
  lifetime: LifetimeId;
  uniqueId: string | null;
} {
  const match = pathname.match(VAULT_EXP_REGEX);
  if (match) {
    const expiresAtMs = Number(match[1]);
    const lifetime = match[2] as LifetimeId;
    const uniqueId = match[3];
    const name = sanitizeFilename(match[4]);
    return {
      name,
      expiresAtMs,
      expiresAt: expiresAtMs > 0 ? new Date(expiresAtMs).toISOString() : null,
      lifetime,
      uniqueId,
    };
  }

  // Legacy pre-monetization pathnames: vault/<uniquePrefix>/<filename>
  const segments = pathname.split('/');
  const rawFilename = segments[segments.length - 1] || pathname;
  const uniqueId = segments.length >= 3 ? segments[1] : null;
  return {
    name: sanitizeFilename(rawFilename),
    expiresAtMs: 0,
    expiresAt: null,
    lifetime: 'forever',
    uniqueId,
  };
}

export function encodeFileId(payload: EncodedFileId): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeFileId(id: string): EncodedFileId | null {
  try {
    const parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (
      parsed &&
      (parsed.m === 'blob' || parsed.m === 'local') &&
      typeof parsed.k === 'string' &&
      typeof parsed.n === 'string'
    ) {
      return parsed as EncodedFileId;
    }
    return null;
  } catch {
    return null;
  }
}

export function isEncodedFileExpired(id: string): boolean {
  const decoded = decodeFileId(id);
  if (!decoded) return false;
  if (typeof decoded.e === 'number' && decoded.e > 0 && decoded.e <= Date.now()) {
    return true;
  }
  if (decoded.m === 'blob') {
    try {
      const u = new URL(decoded.k);
      const parsed = parseVaultPathname(u.pathname.replace(/^\//, ''));
      if (parsed.expiresAtMs > 0 && parsed.expiresAtMs <= Date.now()) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

async function getLocalVaultDir(): Promise<string> {
  const preferredDir = path.join(process.cwd(), '.local-vault');
  try {
    await fs.mkdir(preferredDir, { recursive: true });
    return preferredDir;
  } catch {
    const tmpDir = path.join('/tmp', 'local-vault');
    await fs.mkdir(tmpDir, { recursive: true });
    return tmpDir;
  }
}

/**
 * Proactively scans and deletes all expired files from Vercel Blob or Local Disk.
 * Used by both `/api/cron/cleanup` and lazy cleanup during file listing.
 */
export async function purgeExpiredFiles(): Promise<{
  scannedCount: number;
  deletedCount: number;
}> {
  const mode = getStorageMode();
  const now = Date.now();

  if (mode === 'vercel-blob') {
    const { blobs } = await list({ prefix: 'vault/' });
    const expiredUrls: string[] = [];

    for (const blob of blobs) {
      const parsed = parseVaultPathname(blob.pathname);
      if (parsed.expiresAtMs > 0 && parsed.expiresAtMs <= now) {
        expiredUrls.push(blob.url);
      }
    }

    if (expiredUrls.length > 0) {
      await del(expiredUrls);
    }

    return {
      scannedCount: blobs.length,
      deletedCount: expiredUrls.length,
    };
  }

  const vaultDir = await getLocalVaultDir();
  const entries = await fs.readdir(vaultDir);
  const metaFiles = entries.filter((f) => f.endsWith('.meta.json'));
  let deletedCount = 0;

  for (const metaFile of metaFiles) {
    try {
      const metaPath = path.join(vaultDir, metaFile);
      const raw = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw) as LocalMetaRecord;
      const expMs = meta.expiresAt ? new Date(meta.expiresAt).getTime() : 0;
      if (expMs > 0 && expMs <= now) {
        const binPath = path.join(vaultDir, `${meta.key}.bin`);
        await Promise.allSettled([fs.unlink(binPath), fs.unlink(metaPath)]);
        deletedCount += 1;
      }
    } catch {
      // ignore
    }
  }

  return {
    scannedCount: metaFiles.length,
    deletedCount,
  };
}

/**
 * Lists all active (unexpired) uploaded files sorted from newest to oldest,
 * while lazily purging any expired files encountered.
 */
export async function listStoredFiles(): Promise<StoredFileItem[]> {
  const mode = getStorageMode();
  const now = Date.now();

  if (mode === 'vercel-blob') {
    const { blobs } = await list({ prefix: 'vault/' });
    const expiredUrls: string[] = [];
    const items: StoredFileItem[] = [];

    for (const blob of blobs) {
      const parsed = parseVaultPathname(blob.pathname);
      if (parsed.expiresAtMs > 0 && parsed.expiresAtMs <= now) {
        expiredUrls.push(blob.url);
        continue;
      }

      const contentType = inferContentType(parsed.name);
      const category = categorizeFile(parsed.name, contentType);
      const uploadedIso = new Date(blob.uploadedAt).toISOString();
      const id = encodeFileId({
        m: 'blob',
        k: blob.url,
        n: parsed.name,
        t: contentType,
        e: parsed.expiresAtMs,
        l: parsed.lifetime,
        s: blob.size,
        u: uploadedIso,
      });

      items.push({
        id,
        name: parsed.name,
        size: blob.size,
        contentType,
        category,
        uploadedAt: uploadedIso,
        expiresAt: parsed.expiresAt,
        lifetime: parsed.lifetime,
        storageMode: 'vercel-blob',
      });
    }

    if (expiredUrls.length > 0) {
      // Fire-and-forget cleanup of expired blobs
      del(expiredUrls).catch(() => {});
    }

    items.sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );
    return items;
  }

  // Local disk fallback
  const vaultDir = await getLocalVaultDir();
  const entries = await fs.readdir(vaultDir);
  const metaFiles = entries.filter((f) => f.endsWith('.meta.json'));

  const items: StoredFileItem[] = [];
  for (const metaFile of metaFiles) {
    try {
      const metaPath = path.join(vaultDir, metaFile);
      const raw = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw) as LocalMetaRecord;
      const expMs = meta.expiresAt ? new Date(meta.expiresAt).getTime() : 0;

      if (expMs > 0 && expMs <= now) {
        const binPath = path.join(vaultDir, `${meta.key}.bin`);
        Promise.allSettled([fs.unlink(binPath), fs.unlink(metaPath)]).catch(() => {});
        continue;
      }

      const lifetime: LifetimeId = isValidLifetimeId(meta.lifetime)
        ? meta.lifetime
        : meta.expiresAt
        ? '7d'
        : 'forever';
      const expiresAt = expMs > 0 ? new Date(expMs).toISOString() : null;
      const contentType = inferContentType(meta.name, meta.contentType);
      const category = categorizeFile(meta.name, contentType);
      const id = encodeFileId({
        m: 'local',
        k: meta.key,
        n: meta.name,
        t: contentType,
        e: expMs,
        l: lifetime,
        s: meta.size,
        u: meta.uploadedAt,
      });

      items.push({
        id,
        name: meta.name,
        size: meta.size,
        contentType,
        category,
        uploadedAt: meta.uploadedAt,
        expiresAt,
        lifetime,
        storageMode: 'local-disk',
      });
    } catch {
      // Ignore malformed or mid-delete metadata files
    }
  }

  items.sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
  return items;
}

/**
 * Stores a single file in either Vercel Blob (with ttlDays + multipart) or Local Disk fallback.
 */
export async function saveUploadedFile(
  file: File,
  lifetime: LifetimeId = '7d'
): Promise<StoredFileItem> {
  const mode = getStorageMode();
  const nowMs = Date.now();
  const { pathname, cleanName, expiresAtMs } = buildVaultPathname(
    file.name || 'untitled',
    lifetime,
    nowMs
  );
  const expiresAt = expiresAtMs > 0 ? new Date(expiresAtMs).toISOString() : null;
  const ttlDays = LIFETIME_OPTIONS[lifetime].ttlDays;
  const contentType = inferContentType(cleanName, file.type);
  const category = categorizeFile(cleanName, contentType);
  const uploadedAt = new Date(nowMs).toISOString();

  if (mode === 'vercel-blob') {
    const blob = await put(pathname, file, {
      access: 'public',
      addRandomSuffix: false,
      contentType,
      multipart: file.size > 4 * 1024 * 1024,
      ...(ttlDays !== null ? { ttlDays } : {}),
    });

    const id = encodeFileId({
      m: 'blob',
      k: blob.url,
      n: cleanName,
      t: contentType,
      e: expiresAtMs,
      l: lifetime,
      s: file.size,
      u: uploadedAt,
    });

    return {
      id,
      name: cleanName,
      size: file.size,
      contentType,
      category,
      uploadedAt,
      expiresAt,
      lifetime,
      storageMode: 'vercel-blob',
    };
  }

  // Local disk fallback
  const vaultDir = await getLocalVaultDir();
  const key = `${nowMs}-${crypto.randomBytes(6).toString('hex')}`;
  const binPath = path.join(vaultDir, `${key}.bin`);
  const metaPath = path.join(vaultDir, `${key}.meta.json`);

  const webStream = file.stream() as unknown as NodeReadableStream;
  await pipeline(Readable.fromWeb(webStream), createWriteStream(binPath));
  const stats = await fs.stat(binPath);

  const metaRecord: LocalMetaRecord = {
    key,
    name: cleanName,
    size: stats.size,
    contentType,
    uploadedAt,
    expiresAt,
    lifetime,
  };

  await fs.writeFile(metaPath, JSON.stringify(metaRecord, null, 2), 'utf8');

  const id = encodeFileId({
    m: 'local',
    k: key,
    n: cleanName,
    t: contentType,
    e: expiresAtMs,
    l: lifetime,
    s: stats.size,
    u: uploadedAt,
  });

  return {
    id,
    name: cleanName,
    size: stats.size,
    contentType,
    category,
    uploadedAt,
    expiresAt,
    lifetime,
    storageMode: 'local-disk',
  };
}

/**
 * Streams a raw request body directly to storage (used for large local-disk uploads without FormData buffering).
 */
export async function saveUploadedStream(params: {
  body: ReadableStream<Uint8Array>;
  filename: string;
  contentType?: string;
  lifetime?: LifetimeId;
}): Promise<StoredFileItem> {
  const mode = getStorageMode();
  const lifetime: LifetimeId = params.lifetime || '7d';
  const nowMs = Date.now();
  const { pathname, cleanName, expiresAtMs } = buildVaultPathname(
    params.filename || 'untitled',
    lifetime,
    nowMs
  );
  const expiresAt = expiresAtMs > 0 ? new Date(expiresAtMs).toISOString() : null;
  const ttlDays = LIFETIME_OPTIONS[lifetime].ttlDays;
  const contentType = inferContentType(cleanName, params.contentType);
  const category = categorizeFile(cleanName, contentType);
  const uploadedAt = new Date(nowMs).toISOString();

  if (mode === 'vercel-blob') {
    const blob = await put(pathname, params.body, {
      access: 'public',
      addRandomSuffix: false,
      contentType,
      multipart: true,
      ...(ttlDays !== null ? { ttlDays } : {}),
    });

    const id = encodeFileId({
      m: 'blob',
      k: blob.url,
      n: cleanName,
      t: contentType,
      e: expiresAtMs,
      l: lifetime,
      u: uploadedAt,
    });

    return {
      id,
      name: cleanName,
      size: 0,
      contentType,
      category,
      uploadedAt,
      expiresAt,
      lifetime,
      storageMode: 'vercel-blob',
    };
  }

  const vaultDir = await getLocalVaultDir();
  const key = `${nowMs}-${crypto.randomBytes(6).toString('hex')}`;
  const binPath = path.join(vaultDir, `${key}.bin`);
  const metaPath = path.join(vaultDir, `${key}.meta.json`);

  const nodeReadable = Readable.fromWeb(params.body as unknown as NodeReadableStream);
  await pipeline(nodeReadable, createWriteStream(binPath));
  const stats = await fs.stat(binPath);

  const metaRecord: LocalMetaRecord = {
    key,
    name: cleanName,
    size: stats.size,
    contentType,
    uploadedAt,
    expiresAt,
    lifetime,
  };

  await fs.writeFile(metaPath, JSON.stringify(metaRecord, null, 2), 'utf8');

  const id = encodeFileId({
    m: 'local',
    k: key,
    n: cleanName,
    t: contentType,
    e: expiresAtMs,
    l: lifetime,
    s: stats.size,
    u: uploadedAt,
  });

  return {
    id,
    name: cleanName,
    size: stats.size,
    contentType,
    category,
    uploadedAt,
    expiresAt,
    lifetime,
    storageMode: 'local-disk',
  };
}

/**
 * Updates / extends an existing stored file's lifetime without re-uploading it!
 */
export async function updateStoredFileLifetime(
  id: string,
  newLifetime: LifetimeId
): Promise<StoredFileItem | null> {
  const decoded = decodeFileId(id);
  if (!decoded) return null;

  const nowMs = Date.now();
  const { pathname: newPathname, cleanName, expiresAtMs } = buildVaultPathname(
    decoded.n,
    newLifetime,
    nowMs
  );
  const expiresAt = expiresAtMs > 0 ? new Date(expiresAtMs).toISOString() : null;
  const ttlDays = LIFETIME_OPTIONS[newLifetime].ttlDays;
  const contentType = inferContentType(cleanName, decoded.t);
  const category = categorizeFile(cleanName, contentType);

  if (decoded.m === 'blob') {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(decoded.k);
    } catch {
      return null;
    }
    if (
      parsedUrl.protocol !== 'https:' ||
      !parsedUrl.hostname.endsWith('.blob.vercel-storage.com')
    ) {
      return null;
    }

    const renamed = await rename(parsedUrl.toString(), newPathname, {
      access: 'public',
      addRandomSuffix: false,
      contentType,
      ...(ttlDays !== null ? { ttlDays } : {}),
    });

    const uploadedAt = decoded.u || new Date(nowMs).toISOString();
    const size = decoded.s ?? 0;

    const updatedId = encodeFileId({
      m: 'blob',
      k: renamed.url,
      n: cleanName,
      t: contentType,
      e: expiresAtMs,
      l: newLifetime,
      s: size,
      u: uploadedAt,
    });

    return {
      id: updatedId,
      name: cleanName,
      size,
      contentType,
      category,
      uploadedAt,
      expiresAt,
      lifetime: newLifetime,
      storageMode: 'vercel-blob',
    };
  }

  // Local disk mode
  if (!/^[a-zA-Z0-9-]+$/.test(decoded.k)) {
    return null;
  }

  const vaultDir = await getLocalVaultDir();
  const metaPath = path.join(vaultDir, `${decoded.k}.meta.json`);
  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw) as LocalMetaRecord;
    meta.expiresAt = expiresAt;
    meta.lifetime = newLifetime;
    await fs.writeFile(metaPath, JSON.stringify(metaRecordSafe(meta), null, 2), 'utf8');

    const updatedId = encodeFileId({
      m: 'local',
      k: meta.key,
      n: meta.name,
      t: contentType,
      e: expiresAtMs,
      l: newLifetime,
      s: meta.size,
      u: meta.uploadedAt,
    });

    return {
      id: updatedId,
      name: meta.name,
      size: meta.size,
      contentType,
      category,
      uploadedAt: meta.uploadedAt,
      expiresAt,
      lifetime: newLifetime,
      storageMode: 'local-disk',
    };
  } catch {
    return null;
  }
}

function metaRecordSafe(meta: LocalMetaRecord): LocalMetaRecord {
  return {
    key: meta.key,
    name: meta.name,
    size: meta.size,
    contentType: meta.contentType,
    uploadedAt: meta.uploadedAt,
    expiresAt: meta.expiresAt ?? null,
    lifetime: meta.lifetime ?? '7d',
  };
}

/**
 * Resolves a validated Vercel Blob CDN URL for direct high-speed edge downloads/streaming of large files.
 * Returns null if invalid or expired.
 */
export function getDirectBlobDownloadUrl(
  id: string,
  inline: boolean
): string | null {
  if (isEncodedFileExpired(id)) return null;
  const decoded = decodeFileId(id);
  if (!decoded || decoded.m !== 'blob') return null;

  try {
    const parsedUrl = new URL(decoded.k);
    if (
      parsedUrl.protocol !== 'https:' ||
      !parsedUrl.hostname.endsWith('.blob.vercel-storage.com')
    ) {
      return null;
    }
    if (!inline) {
      parsedUrl.searchParams.set('download', '1');
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

/**
 * Retrieves a file's binary stream and metadata for authenticated download or preview.
 */
export async function getStoredFileContent(id: string): Promise<{
  body: ReadableStream<Uint8Array>;
  name: string;
  contentType: string;
  size?: number;
} | null> {
  if (isEncodedFileExpired(id)) return null;
  const decoded = decodeFileId(id);
  if (!decoded) return null;

  const cleanName = sanitizeFilename(decoded.n);
  const contentType = inferContentType(cleanName, decoded.t);

  if (decoded.m === 'blob') {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(decoded.k);
    } catch {
      return null;
    }
    if (
      parsedUrl.protocol !== 'https:' ||
      !parsedUrl.hostname.endsWith('.blob.vercel-storage.com')
    ) {
      return null;
    }

    const headers: Record<string, string> = {};
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
    }

    const response = await fetch(parsedUrl.toString(), {
      headers,
      cache: 'no-store',
    });

    if (!response.ok || !response.body) {
      return null;
    }

    const contentLength = response.headers.get('content-length');
    return {
      body: response.body,
      name: cleanName,
      contentType,
      size: contentLength ? Number(contentLength) : undefined,
    };
  }

  if (!/^[a-zA-Z0-9-]+$/.test(decoded.k)) {
    return null;
  }

  const vaultDir = await getLocalVaultDir();
  const binPath = path.join(vaultDir, `${decoded.k}.bin`);
  const metaPath = path.join(vaultDir, `${decoded.k}.meta.json`);
  try {
    // Verify local metadata hasn't expired
    const rawMeta = await fs.readFile(metaPath, 'utf8');
    const meta = JSON.parse(rawMeta) as LocalMetaRecord;
    if (meta.expiresAt && new Date(meta.expiresAt).getTime() <= Date.now()) {
      await Promise.allSettled([fs.unlink(binPath), fs.unlink(metaPath)]);
      return null;
    }

    const stats = await fs.stat(binPath);
    const nodeStream = createReadStream(binPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return {
      body: webStream,
      name: cleanName,
      contentType,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

/**
 * Deletes one or more stored files by their encoded IDs.
 */
export async function deleteStoredFiles(ids: string[]): Promise<number> {
  let deletedCount = 0;
  const blobUrlsToDelete: string[] = [];
  const localKeysToDelete: string[] = [];

  for (const id of ids) {
    const decoded = decodeFileId(id);
    if (!decoded) continue;

    if (decoded.m === 'blob') {
      try {
        const parsedUrl = new URL(decoded.k);
        if (
          parsedUrl.protocol === 'https:' &&
          parsedUrl.hostname.endsWith('.blob.vercel-storage.com')
        ) {
          blobUrlsToDelete.push(parsedUrl.toString());
        }
      } catch {
        // Ignore invalid URL
      }
    } else if (decoded.m === 'local') {
      if (/^[a-zA-Z0-9-]+$/.test(decoded.k)) {
        localKeysToDelete.push(decoded.k);
      }
    }
  }

  if (blobUrlsToDelete.length > 0 && process.env.BLOB_READ_WRITE_TOKEN) {
    await del(blobUrlsToDelete);
    deletedCount += blobUrlsToDelete.length;
  }

  if (localKeysToDelete.length > 0) {
    const vaultDir = await getLocalVaultDir();
    for (const key of localKeysToDelete) {
      const binPath = path.join(vaultDir, `${key}.bin`);
      const metaPath = path.join(vaultDir, `${key}.meta.json`);
      await Promise.allSettled([fs.unlink(binPath), fs.unlink(metaPath)]);
      deletedCount += 1;
    }
  }

  return deletedCount;
}
