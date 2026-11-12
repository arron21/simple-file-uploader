import { NextResponse } from 'next/server';
import { isAuthenticated, isUsingDefaultPassword } from '@/lib/auth';
import { getStorageMode } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const authenticated = await isAuthenticated();
  return NextResponse.json({
    authenticated,
    storageMode: getStorageMode(),
    isDefaultPassword: isUsingDefaultPassword(),
  });
}
