import { NextResponse } from 'next/server';

export async function GET() {
  const customAdsTxt = process.env.ADS_TXT_CONTENT?.trim();
  if (customAdsTxt) {
    return new NextResponse(`${customAdsTxt}\n`, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const clientId = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID?.trim();
  if (clientId) {
    const pubId = clientId.startsWith('ca-pub-')
      ? clientId.replace(/^ca-/, '')
      : clientId;
    return new NextResponse(
      `google.com, ${pubId}, DIRECT, f08c47fec0942fa0\n`,
      {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      }
    );
  }

  return new NextResponse(
    '# Configure NEXT_PUBLIC_ADSENSE_CLIENT_ID or ADS_TXT_CONTENT in Vercel Environment Variables to populate ads.txt\n',
    {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    }
  );
}
