import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { isAuthenticated } from '@/lib/auth';

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        const authed = await isAuthenticated();
        if (!authed) {
          throw new Error('Unauthorized: Password authentication required.');
        }
        return {
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ uploadedVia: 'client' }),
        };
      },
      onUploadCompleted: async () => {
        // Optional post-upload hook
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 }
    );
  }
}
