import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { isAuthenticated } from '@/lib/auth';

export const maxDuration = 60;

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
          // Allow up to 5 TB (Vercel Blob maximum object size)
          maximumSizeInBytes: 5 * 1024 * 1024 * 1024 * 1024,
          // Keep client upload token valid for 6 hours to support multi-GB uploads on slower connections
          validUntil: Date.now() + 6 * 60 * 60 * 1000,
          tokenPayload: JSON.stringify({ uploadedVia: 'client-multipart' }),
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
