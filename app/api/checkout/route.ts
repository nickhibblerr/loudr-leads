import { WhopClient } from "@whop/sdk";
import { unstable_cache } from "next/cache";
import { calculateLeadQuote, requestedLeadCount, type LeadQuote } from "@/lib/lead-pricing";
import { getLeadCheckout } from "@/lib/lead-checkout";

import { effectiveForceUsd, requestedPaymentMode } from "@/lib/payment-methods";
import { readRateCard } from "@/lib/pricing-store";

export const runtime = "nodejs";

// Share successful plan lookups across requests and function cold starts. Credentials
// stay inside the resolver; the cache contains only the public plan ID for this price.
const resolveCheckout = unstable_cache(async (accountId: string, productId: string, quote: LeadQuote, forceUsd: boolean) => {
  const whop = new WhopClient({ token: process.env.WHOP_API_KEY! });
  return getLeadCheckout(whop, accountId, productId, quote, forceUsd);
}, ["loudr-lead-checkout-native-quantity-v1"], { revalidate: 300 });

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Enter a valid JSON request body." }, { status: 400 });
  }
  const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const { state } = input;
  const currency = input.currency ?? "usd";
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
    return Response.json({ error: "Prices have changed. Review the updated total and continue again.", rateCard: card }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  let quote;
  try {
    quote = calculateLeadQuote(state, requestedLeadCount(input), card.states, paymentMode);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid lead order." }, { status: 400 });
  }

  const token = process.env.WHOP_API_KEY;
  const accountId = process.env.WHOP_ACCOUNT_ID;
  const productId = process.env.WHOP_LEADS_PRODUCT_ID;
  if (!token || !accountId || !productId) {
    return Response.json({ error: "Payments are temporarily unavailable. Please try again later." }, { status: 503 });
  }
  try {
    const checkout = await resolveCheckout(accountId, productId, quote, forceUsd);
    return Response.json({ ...checkout, quote, forceUsd, paymentMode, priceVersion: card.version }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const err = error as { error?: { message?: string }; message?: string };
    return Response.json({ error: err?.error?.message ?? err?.message ?? "Unable to load payment options." }, { status: 502 });
  }
}
