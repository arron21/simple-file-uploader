import { NextResponse } from 'next/server';
import { ENTITLEMENT_COOKIE_NAME } from '@/lib/monetization';
import {
  verifyEntitlementLicense,
  verifyPromoCode,
  createEntitlementLicense,
  buildEntitlementState,
  getEntitlementCookieOptions,
} from '@/lib/monetization-server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const rawCode = typeof body?.code === 'string' ? body.code.trim() : '';

    if (!rawCode) {
      return NextResponse.json(
        { error: 'Please enter a License Key or Promo Code.' },
        { status: 400 }
      );
    }

    // 1. Check if it's a signed portable License Key ("VD1.<payload>.<sig>")
    const existingLicense = verifyEntitlementLicense(rawCode);
    if (existingLicense) {
      const entitlement = buildEntitlementState(rawCode);
      const response = NextResponse.json({
        ok: true,
        entitlement,
      });
      response.cookies.set({
        ...getEntitlementCookieOptions(existingLicense.exp),
        value: rawCode,
      });
      return response;
    }

    // 2. Check if it matches PRO_PROMO_CODE environment variable
    if (verifyPromoCode(rawCode)) {
      const { licenseKey, payload } = createEntitlementLicense({
        planId: 'pro_monthly',
        source: 'promo',
      });
      const entitlement = buildEntitlementState(licenseKey);
      const response = NextResponse.json({
        ok: true,
        entitlement,
      });
      response.cookies.set({
        ...getEntitlementCookieOptions(payload.exp),
        value: licenseKey,
      });
      return response;
    }

    return NextResponse.json(
      { error: 'Invalid or expired License Key / Promo Code.' },
      { status: 400 }
    );
  } catch {
    return NextResponse.json(
      { error: 'Invalid request payload.' },
      { status: 400 }
    );
  }
}

export async function DELETE() {
  const entitlement = buildEntitlementState(null);
  const response = NextResponse.json({
    ok: true,
    entitlement,
  });
  response.cookies.set({
    name: ENTITLEMENT_COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return response;
}
