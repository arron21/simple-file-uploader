import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { getStoredFileContent } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: 'Unauthorized. Password login required.' },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const inline = url.searchParams.get('inline') === '1';

  if (!id) {
    return NextResponse.json(
      { error: 'Missing file identifier.' },
      { status: 400 }
    );
  }

  const fileData = await getStoredFileContent(id);
  if (!fileData) {
    return NextResponse.json(
      { error: 'File not found or no longer available.' },
      { status: 404 }
    );
  }

  const dispositionType = inline ? 'inline' : 'attachment';
  const asciiFallback = fileData.name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const encodedName = encodeURIComponent(fileData.name);

  const headers = new Headers();
  headers.set('Content-Type', fileData.contentType);
  headers.set(
    'Content-Disposition',
    `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`
  );
  headers.set('Cache-Control', 'private, no-cache');
  if (typeof fileData.size === 'number' && !Number.isNaN(fileData.size)) {
    headers.set('Content-Length', String(fileData.size));
  }

  const responseBody: BodyInit = Buffer.isBuffer(fileData.body)
    ? new Uint8Array(fileData.body)
    : fileData.body;

  return new NextResponse(responseBody, {
    status: 200,
    headers,
  });
}
