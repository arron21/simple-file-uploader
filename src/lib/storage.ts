import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { put, list, del } from '@vercel/blob';

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
  storageMode: StorageMode;
}

interface LocalMetaRecord {
  key: string;
  name: string;
  size: number;
  contentType: string;
  uploadedAt: string;
}

interface EncodedFileId {
  m: 'blob' | 'local';
  k: string; // blob URL or local key
  n: string; // original file name
  t?: string; // contentType
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
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
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

  const archiveExts = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz']);
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
  // Remove control characters and path separators while preserving spaces, unicode, dots, dashes
  const cleaned = base
    .replace(/[\x00-\x1f\x80-\x9f/?<>\\:*|"]/g, '_')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'unnamed-file';
}

function encodeFileId(payload: EncodedFileId): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeFileId(id: string): EncodedFileId | null {
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

async function getLocalVaultDir(): Promise<string> {
  const preferredDir = path.join(process.cwd(), '.local-vault');
  try {
    await fs.mkdir(preferredDir, { recursive: true });
    return preferredDir;
  } catch {
    // Fallback to /tmp/local-vault when running in a read-only serverless container without BLOB_READ_WRITE_TOKEN
    const tmpDir = path.join('/tmp', 'local-vault');
    await fs.mkdir(tmpDir, { recursive: true });
    return tmpDir;
  }
}

/**
 * Lists all uploaded files sorted from newest to oldest.
 */
export async function listStoredFiles(): Promise<StoredFileItem[]> {
  const mode = getStorageMode();

  if (mode === 'vercel-blob') {
    const { blobs } = await list({ prefix: 'vault/' });
    const items: StoredFileItem[] = blobs.map((blob) => {
      const segments = blob.pathname.split('/');
      const rawFilename = segments[segments.length - 1] || blob.pathname;
      const name = sanitizeFilename(rawFilename);
      const contentType = inferContentType(name);
      const category = categorizeFile(name, contentType);
      const id = encodeFileId({
        m: 'blob',
        k: blob.url,
        n: name,
        t: contentType,
      });

      return {
        id,
        name,
        size: blob.size,
        contentType,
        category,
        uploadedAt: new Date(blob.uploadedAt).toISOString(),
        storageMode: 'vercel-blob',
      };
    });

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
      const raw = await fs.readFile(path.join(vaultDir, metaFile), 'utf8');
      const meta = JSON.parse(raw) as LocalMetaRecord;
      const contentType = inferContentType(meta.name, meta.contentType);
      const category = categorizeFile(meta.name, contentType);
      const id = encodeFileId({
        m: 'local',
        k: meta.key,
        n: meta.name,
        t: contentType,
      });

      items.push({
        id,
        name: meta.name,
        size: meta.size,
        contentType,
        category,
        uploadedAt: meta.uploadedAt,
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
 * Stores a single file in either Vercel Blob or Local Disk fallback.
 */
export async function saveUploadedFile(file: File): Promise<StoredFileItem> {
  const mode = getStorageMode();
  const cleanName = sanitizeFilename(file.name || 'untitled');
  const contentType = inferContentType(cleanName, file.type);
  const category = categorizeFile(cleanName, contentType);
  const uploadedAt = new Date().toISOString();
  const uniquePrefix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

  if (mode === 'vercel-blob') {
    const pathname = `vault/${uniquePrefix}/${cleanName}`;
    const blob = await put(pathname, file, {
      access: 'public',
      addRandomSuffix: false,
      contentType,
    });

    const id = encodeFileId({
      m: 'blob',
      k: blob.url,
      n: cleanName,
      t: contentType,
    });

    return {
      id,
      name: cleanName,
      size: file.size,
      contentType,
      category,
      uploadedAt,
      storageMode: 'vercel-blob',
    };
  }

  // Local disk fallback
  const vaultDir = await getLocalVaultDir();
  const key = uniquePrefix;
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const binPath = path.join(vaultDir, `${key}.bin`);
  const metaPath = path.join(vaultDir, `${key}.meta.json`);

  const metaRecord: LocalMetaRecord = {
    key,
    name: cleanName,
    size: buffer.byteLength,
    contentType,
    uploadedAt,
  };

  await fs.writeFile(binPath, buffer);
  await fs.writeFile(metaPath, JSON.stringify(metaRecord, null, 2), 'utf8');

  const id = encodeFileId({
    m: 'local',
    k: key,
    n: cleanName,
    t: contentType,
  });

  return {
    id,
    name: cleanName,
    size: buffer.byteLength,
    contentType,
    category,
    uploadedAt,
    storageMode: 'local-disk',
  };
}

/**
 * Retrieves a file's binary stream/buffer and metadata for authenticated download or preview.
 */
export async function getStoredFileContent(id: string): Promise<{
  body: ReadableStream<Uint8Array> | Buffer;
  name: string;
  contentType: string;
  size?: number;
} | null> {
  const decoded = decodeFileId(id);
  if (!decoded) return null;

  const cleanName = sanitizeFilename(decoded.n);
  const contentType = inferContentType(cleanName, decoded.t);

  if (decoded.m === 'blob') {
    // Validate that the URL is an HTTPS Vercel Blob URL to prevent SSRF
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

  // Local disk mode: prevent path traversal by ensuring key only contains alphanumeric & hyphen
  if (!/^[a-zA-Z0-9-]+$/.test(decoded.k)) {
    return null;
  }

  const vaultDir = await getLocalVaultDir();
  const binPath = path.join(vaultDir, `${decoded.k}.bin`);
  try {
    const buffer = await fs.readFile(binPath);
    return {
      body: buffer,
      name: cleanName,
      contentType,
      size: buffer.byteLength,
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
