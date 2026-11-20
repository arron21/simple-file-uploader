import { NextResponse } from 'next/server';
import { isAuthenticated, isUsingDefaultPassword } from '@/lib/auth';
import { getStorageMode } from '@/lib/storage';
import { getActiveEntitlement } from '@/lib/monetization-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [authenticated, entitlement] = await Promise.all([
    isAuthenticated(),
    getActiveEntitlement(),
  ]);
  return NextResponse.json({
    authenticated,
    storageMode: getStorageMode(),
    isDefaultPassword: isUsingDefaultPassword(),
    entitlement,
  });
}
