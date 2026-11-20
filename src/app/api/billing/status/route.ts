import { NextResponse } from 'next/server';
import { ORDERED_PLANS } from '@/lib/monetization';
import { getActiveEntitlement } from '@/lib/monetization-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const entitlement = await getActiveEntitlement();
  return NextResponse.json({
    entitlement,
    plans: ORDERED_PLANS,
  });
}
