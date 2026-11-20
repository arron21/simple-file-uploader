import { NextResponse } from 'next/server';
import { PRICING_PLANS, type PlanId } from '@/lib/monetization';
import {
  isStripeConfigured,
  createEntitlementLicense,
  getEntitlementCookieOptions,
} from '@/lib/monetization-server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const origin = url.origin;

  if (!sessionId || !isStripeConfigured()) {
    return NextResponse.redirect(`${origin}/?checkout=invalid`);
  }

  try {
    const secretKey = process.env.STRIPE_SECRET_KEY!.trim();
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        cache: 'no-store',
      }
    );

    const session = await stripeRes.json();
    if (
      !stripeRes.ok ||
      (session.payment_status !== 'paid' && session.status !== 'complete')
    ) {
      return NextResponse.redirect(`${origin}/?checkout=unpaid`);
    }

    const rawPlanId = session?.metadata?.planId as PlanId | undefined;
    const planId: PlanId =
      rawPlanId && PRICING_PLANS[rawPlanId] ? rawPlanId : 'pro_monthly';

    const { licenseKey, payload } = createEntitlementLicense({
      planId,
      source: 'stripe',
      ref: session.id,
    });

    const redirectResponse = NextResponse.redirect(`${origin}/?upgraded=1`);
    redirectResponse.cookies.set({
      ...getEntitlementCookieOptions(payload.exp),
      value: licenseKey,
    });

    return redirectResponse;
  } catch {
    return NextResponse.redirect(`${origin}/?checkout=error`);
  }
}
