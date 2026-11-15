import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import {
  listStoredFiles,
  saveUploadedFile,
  saveUploadedStream,
  deleteStoredFiles,
  getStorageMode,
  StoredFileItem,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: 'Unauthorized. Password login required.' },
      { status: 401 }
    );
  }

  try {
    const files = await listStoredFiles();
    const totalBytes = files.reduce((acc, item) => acc + item.size, 0);
    return NextResponse.json({
      files,
      totalCount: files.length,
      totalBytes,
      storageMode: getStorageMode(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to list files.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: 'Unauthorized. Password login required.' },
      { status: 401 }
    );
  }

  try {
    const formData = await request.formData();
    const rawEntries = [
      ...formData.getAll('files'),
      ...formData.getAll('file'),
    ];

    const files = rawEntries.filter(
      (entry): entry is File => entry instanceof File && entry.size >= 0
    );

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided in the upload request.' },
        { status: 400 }
      );
    }

    const uploaded: StoredFileItem[] = [];
    for (const file of files) {
      const saved = await saveUploadedFile(file);
      uploaded.push(saved);
    }

    return NextResponse.json({
      uploaded,
      storageMode: getStorageMode(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to upload files.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/files?name=...&type=...
 * Streams a raw binary file directly to storage without FormData memory buffering (supports 500MB+ local files).
 */
export async function PUT(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: 'Unauthorized. Password login required.' },
      { status: 401 }
    );
  }

  try {
    if (!request.body) {
      return NextResponse.json(
        { error: 'Missing file stream body.' },
        { status: 400 }
      );
    }

    const url = new URL(request.url);
    const filename = url.searchParams.get('name') || 'uploaded-file';
    const contentType =
      url.searchParams.get('type') ||
      request.headers.get('content-type') ||
      'application/octet-stream';

    const saved = await saveUploadedStream({
      body: request.body,
      filename,
      contentType,
    });

    return NextResponse.json({
      uploaded: [saved],
      storageMode: getStorageMode(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to stream upload.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: 'Unauthorized. Password login required.' },
      { status: 401 }
    );
  }

  try {
    const url = new URL(request.url);
    const queryId = url.searchParams.get('id');
    let ids: string[] = [];

    if (queryId) {
      ids = [queryId];
    } else {
      const body = await request.json().catch(() => ({}));
      if (Array.isArray(body?.ids)) {
        ids = body.ids.filter((x: unknown): x is string => typeof x === 'string');
      } else if (typeof body?.id === 'string') {
        ids = [body.id];
      }
    }

    if (ids.length === 0) {
      return NextResponse.json(
        { error: 'No file IDs specified for deletion.' },
        { status: 400 }
      );
    }

    const deletedCount = await deleteStoredFiles(ids);
    return NextResponse.json({ deletedCount });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to delete files.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
