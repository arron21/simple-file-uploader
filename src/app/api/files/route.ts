import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import {
  listStoredFiles,
  saveUploadedFile,
  saveUploadedStream,
  updateStoredFileLifetime,
  deleteStoredFiles,
  getStorageMode,
  StoredFileItem,
} from '@/lib/storage';
import {
  canUseLifetime,
  isValidLifetimeId,
  type LifetimeId,
} from '@/lib/monetization';
import { getActiveEntitlement } from '@/lib/monetization-server';

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
    const [files, entitlement] = await Promise.all([
      listStoredFiles(),
      getActiveEntitlement(),
    ]);
    const totalBytes = files.reduce((acc, item) => acc + item.size, 0);
    return NextResponse.json({
      files,
      totalCount: files.length,
      totalBytes,
      storageMode: getStorageMode(),
      entitlement,
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
    const entitlement = await getActiveEntitlement();
    const formData = await request.formData();
    const rawLifetime = formData.get('lifetime');
    const lifetime: LifetimeId = isValidLifetimeId(rawLifetime)
      ? rawLifetime
      : '7d';

    const lifetimeCheck = canUseLifetime(entitlement, lifetime);
    if (!lifetimeCheck.allowed) {
      return NextResponse.json(
        { error: lifetimeCheck.reason, code: 'UPGRADE_REQUIRED' },
        { status: 402 }
      );
    }

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

    for (const file of files) {
      if (file.size > entitlement.maxFileBytes) {
        return NextResponse.json(
          {
            error:
              'Files larger than 250 MB require a Large File Pass ($2.99) or Pro Unlimited ($9/mo).',
            code: 'UPGRADE_REQUIRED',
          },
          { status: 402 }
        );
      }
    }

    const uploaded: StoredFileItem[] = [];
    for (const file of files) {
      const saved = await saveUploadedFile(file, lifetime);
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
 * PUT /api/files?name=...&type=...&lifetime=...&size=...
 * Streams a raw binary file directly to storage without FormData memory buffering.
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

    const entitlement = await getActiveEntitlement();
    const url = new URL(request.url);
    const filename = url.searchParams.get('name') || 'uploaded-file';
    const contentType =
      url.searchParams.get('type') ||
      request.headers.get('content-type') ||
      'application/octet-stream';
    const rawLifetime = url.searchParams.get('lifetime');
    const lifetime: LifetimeId = isValidLifetimeId(rawLifetime)
      ? rawLifetime
      : '7d';

    const contentLengthHeader = Number(
      request.headers.get('content-length') || url.searchParams.get('size') || '0'
    );
    if (contentLengthHeader > entitlement.maxFileBytes) {
      return NextResponse.json(
        {
          error:
            'Files larger than 250 MB require a Large File Pass ($2.99) or Pro Unlimited ($9/mo).',
          code: 'UPGRADE_REQUIRED',
        },
        { status: 402 }
      );
    }

    const lifetimeCheck = canUseLifetime(entitlement, lifetime);
    if (!lifetimeCheck.allowed) {
      return NextResponse.json(
        { error: lifetimeCheck.reason, code: 'UPGRADE_REQUIRED' },
        { status: 402 }
      );
    }

    const saved = await saveUploadedStream({
      body: request.body,
      filename,
      contentType,
      lifetime,
    });

    // Enforce post-stream size check on local disk if Content-Length was omitted
    if (saved.size > entitlement.maxFileBytes) {
      await deleteStoredFiles([saved.id]);
      return NextResponse.json(
        {
          error:
            'Files larger than 250 MB require a Large File Pass ($2.99) or Pro Unlimited ($9/mo).',
          code: 'UPGRADE_REQUIRED',
        },
        { status: 402 }
      );
    }

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

/**
 * PATCH /api/files
 * Updates or extends an existing stored file's auto-delete lifetime in place.
 */
export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: 'Unauthorized. Password login required.' },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const id = typeof body?.id === 'string' ? body.id : '';
    const lifetime = body?.lifetime;

    if (!id || !isValidLifetimeId(lifetime)) {
      return NextResponse.json(
        { error: 'Valid file ID and lifetime option are required.' },
        { status: 400 }
      );
    }

    const entitlement = await getActiveEntitlement();
    const check = canUseLifetime(entitlement, lifetime);
    if (!check.allowed) {
      return NextResponse.json(
        { error: check.reason, code: 'UPGRADE_REQUIRED' },
        { status: 402 }
      );
    }

    const updated = await updateStoredFileLifetime(id, lifetime);
    if (!updated) {
      return NextResponse.json(
        { error: 'File not found or could not update lifetime.' },
        { status: 404 }
      );
    }

    return NextResponse.json({ file: updated });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to update file lifetime.';
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
