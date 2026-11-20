import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { PRICING_PLANS, type PlanId } from '@/lib/monetization';
import {
  isStripeConfigured,
  createEntitlementLicense,
  buildEntitlementState,
  getEntitlementCookieOptions,
} from '@/lib/monetization-server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json(
      { error: 'Please unlock the vault before purchasing a pass.' },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const planId = body?.planId as PlanId;
    const sandboxConfirm = Boolean(body?.sandboxConfirm);

    const plan = PRICING_PLANS[planId];
    if (!plan) {
      return NextResponse.json(
        { error: 'Selected plan does not exist.' },
        { status: 400 }
      );
    }

    const origin = new URL(request.url).origin;

    // 1. Live Stripe Checkout when STRIPE_SECRET_KEY is set
    if (isStripeConfigured()) {
      const secretKey = process.env.STRIPE_SECRET_KEY!.trim();
      const params = new URLSearchParams();
      params.set('mode', plan.mode);
      params.set(
        'success_url',
        `${origin}/api/billing/verify?session_id={CHECKOUT_SESSION_ID}`
      );
      params.set('cancel_url', `${origin}/?checkout=cancelled`);
      params.set('line_items[0][quantity]', '1');
      params.set('line_items[0][price_data][currency]', 'usd');
      params.set(
        'line_items[0][price_data][unit_amount]',
        String(plan.priceCents)
      );
      params.set(
        'line_items[0][price_data][product_data][name]',
        `VaultDrop — ${plan.name}`
      );
      params.set(
        'line_items[0][price_data][product_data][description]',
        plan.tagline
      );

      if (plan.mode === 'subscription') {
        params.set(
          'line_items[0][price_data][recurring][interval]',
          'month'
        );
      }

      params.set('metadata[planId]', plan.id);
      params.set('allow_promotion_codes', 'true');

      const stripeRes = await fetch(
        'https://api.stripe.com/v1/checkout/sessions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        }
      );

      const sessionData = await stripeRes.json();
      if (!stripeRes.ok || !sessionData.url) {
        return NextResponse.json(
          {
            error:
              sessionData?.error?.message ||
              'Failed to create Stripe Checkout session.',
          },
          { status: 502 }
        );
      }

      return NextResponse.json({
        mode: 'stripe',
        checkoutUrl: sessionData.url as string,
      });
    }

    // 2. Built-in Sandbox Checkout fallback when STRIPE_SECRET_KEY is not yet configured
    if (!sandboxConfirm) {
      return NextResponse.json({
        mode: 'sandbox_prompt',
        plan,
      });
    }

    const { licenseKey, payload } = createEntitlementLicense({
      planId: plan.id,
      source: 'sandbox',
      ref: `sbx_${Date.now()}`,
    });

    const entitlement = buildEntitlementState(licenseKey);
    const response = NextResponse.json({
      mode: 'sandbox_completed',
      entitlement,
      licenseKey,
    });

    response.cookies.set({
      ...getEntitlementCookieOptions(payload.exp),
      value: licenseKey,
    });

    return response;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Checkout initialization failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
