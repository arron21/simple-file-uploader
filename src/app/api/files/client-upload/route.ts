import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { isAuthenticated } from '@/lib/auth';
import {
  canUseLifetime,
  isValidLifetimeId,
  LIFETIME_OPTIONS,
  type LifetimeId,
} from '@/lib/monetization';
import { getActiveEntitlement } from '@/lib/monetization-server';
import { parseVaultPathname, computeExpirationMs } from '@/lib/storage';

export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const authed = await isAuthenticated();
        if (!authed) {
          throw new Error('Unauthorized: Password authentication required.');
        }

        const entitlement = await getActiveEntitlement();

        let requestedLifetime: LifetimeId = '7d';
        let declaredSize = 0;

        if (clientPayload) {
          try {
            const parsed = JSON.parse(clientPayload);
            if (isValidLifetimeId(parsed?.lifetime)) {
              requestedLifetime = parsed.lifetime;
            }
            if (typeof parsed?.size === 'number') {
              declaredSize = parsed.size;
            }
          } catch {
            // Ignore malformed clientPayload and enforce defaults
          }
        }

        // Enforce file size tier limit (250 MB Free vs 5 TB Paid)
        if (declaredSize > entitlement.maxFileBytes) {
          throw new Error(
            'UPGRADE_REQUIRED: Files larger than 250 MB require a Large File Pass ($2.99) or Pro Unlimited ($9/mo).'
          );
        }

        // Enforce file lifetime tier limit
        const lifetimeCheck = canUseLifetime(entitlement, requestedLifetime);
        if (!lifetimeCheck.allowed) {
          throw new Error(`UPGRADE_REQUIRED: ${lifetimeCheck.reason}`);
        }

        // Verify pathname matches the server-approved lifetime & expiration window so Free users cannot spoof exp_0_forever
        const parsedPath = parseVaultPathname(pathname);
        if (parsedPath.lifetime !== requestedLifetime) {
          throw new Error('Pathname lifetime mismatch.');
        }

        const expectedExpMs = computeExpirationMs(requestedLifetime);
        if (expectedExpMs === 0) {
          if (parsedPath.expiresAtMs !== 0) {
            throw new Error('Invalid permanent pathname metadata.');
          }
        } else {
          const driftMs = Math.abs(parsedPath.expiresAtMs - expectedExpMs);
          if (driftMs > 10 * 60 * 1000) {
            throw new Error('Invalid file expiration timestamp in pathname.');
          }
        }

        const ttlDays = LIFETIME_OPTIONS[requestedLifetime].ttlDays;

        return {
          addRandomSuffix: false,
          maximumSizeInBytes: entitlement.maxFileBytes,
          validUntil: Date.now() + 6 * 60 * 60 * 1000,
          ...(ttlDays !== null ? { ttlDays } : {}),
          tokenPayload: JSON.stringify({
            uploadedVia: 'client-multipart',
            lifetime: requestedLifetime,
            tier: entitlement.tier,
          }),
        };
      },
      onUploadCompleted: async () => {
        // Post-upload hook
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = (error as Error).message || 'Upload token denied.';
    const status = message.startsWith('UPGRADE_REQUIRED:') ? 402 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
