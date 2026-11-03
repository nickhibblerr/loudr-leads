import { WhopClient } from "@whop/sdk";
import { calculateLeadQuote, leadMetadata, requestedLeadCount } from "@/lib/lead-pricing";
import { isTopUpPlanForAmount } from "@/lib/whop-plans";

import { effectiveForceUsd, requestedPaymentMode, paymentMethodsFor } from "@/lib/payment-methods";
import { readRateCard } from "@/lib/pricing-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Enter a valid JSON request body." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Enter a valid payment request." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const { state, confirmationToken, orderId, planId, currency = "usd" } = input;
  const requestedForceUsd = input.forceUsd === undefined ? false : input.forceUsd;
  if (currency !== "usd" || typeof requestedForceUsd !== "boolean") {
    return Response.json({ error: "Leads are priced in USD. Whop handles local-currency conversion at checkout." }, { status: 400 });
  }
  let paymentMode;
  try { paymentMode = requestedPaymentMode(input.paymentMode); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid payment option." }, { status: 400 }); }
  const forceUsd = effectiveForceUsd(paymentMode, requestedForceUsd);
  let card;
  try { card = await readRateCard(); }
  catch { return Response.json({ error: "Pricing is temporarily unavailable. Please try again." }, { status: 503 }); }
  if (input.priceVersion !== undefined && input.priceVersion !== card.version) {
    return Response.json({ error: "Prices have changed. Please reload payment options." }, { status: 409 });
  }
  let quote;
  try {
    quote = calculateLeadQuote(state, requestedLeadCount(input), card.states, paymentMode);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid lead order." }, { status: 400 });
  }
  if (typeof confirmationToken !== "string" || !confirmationToken.startsWith("ctok_") || confirmationToken.length > 4096) {
    return Response.json({ error: "A confirmation token is required." }, { status: 400 });
  }
  if (typeof orderId !== "string" || !/^(?:topup|leads?)_[a-z0-9]{1,32}$/.test(orderId)) {
    return Response.json({ error: "A valid order reference is required." }, { status: 400 });
  }
  if (typeof planId !== "string" || !/^plan_[a-zA-Z0-9]+$/.test(planId)) {
    return Response.json({ error: "Reload payment options and try again." }, { status: 400 });
  }

  try {
    const token = process.env.WHOP_API_KEY;
    const accountId = process.env.WHOP_ACCOUNT_ID;
    const productId = process.env.WHOP_LEADS_PRODUCT_ID;
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    if (!token || !accountId || !productId || !siteUrl) {
      return Response.json({ error: "Payments are temporarily unavailable. Please try again later." }, { status: 503 });
    }
    const origin = new URL(siteUrl).origin;
    const returnUrl = `${origin}/checkout/return?${new URLSearchParams({ order: orderId })}`;
    const whop = new WhopClient({ token });
    // Verify the token and the exact plan displayed to the buyer before charging.
    const confirmation = await whop.confirmationTokens.retrieve({ id: confirmationToken, account_id: accountId });
    if (confirmation.status !== "pending") {
      return Response.json({ error: "Your payment details expired or were already used. Please try again." }, { status: 400 });
    }
    if (!paymentMethodsFor(paymentMode).some((method) => method === confirmation.payment_method_preview?.type)) {
      return Response.json({ error: "Your payment details do not match the selected payment option. Please choose them again." }, { status: 400 });
    }
    const plan = await whop.plans.retrieve({ id: planId });
    if (!isTopUpPlanForAmount(plan, accountId, productId, quote, forceUsd)) {
      return Response.json({ error: "Your payment options do not match the lead order. Please choose them again." }, { status: 400 });
    }
    const payment = await whop.payments.create({
      account_id: accountId,
      confirmation_token: confirmationToken,
      plan_id: plan.id,
      return_url: returnUrl,
      metadata: { ...leadMetadata(quote, forceUsd), order_id: orderId },
    });

    return Response.json({ id: payment.id, status: payment.status, client_secret: payment.client_secret }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const err = error as { error?: { message?: string }; message?: string };
    return Response.json({ error: err?.error?.message ?? err?.message ?? "Unable to process your payment." }, { status: 502 });
  }
}
