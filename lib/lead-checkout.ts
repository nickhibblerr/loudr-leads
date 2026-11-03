import type { Whop, WhopClient } from "@whop/sdk";
import { effectiveForceUsd, paymentConfigurationFor } from "@/lib/payment-methods";
import type { LeadQuote } from "@/lib/lead-pricing";

export const LEAD_PRICING_MODEL = "unit_quantity_v1";
export type LeadCheckoutItem = { plan: string; quantity: number };
type ItemRole = "leads" | "card_fee";
type QuantityPlan = Whop.Plan & { allow_multiple_quantity?: boolean };

export function leadItemMetadata(quote: LeadQuote, forceUsd = false, role: ItemRole = "leads") {
  return {
    source: "loudr-leads-site", pricing_model: LEAD_PRICING_MODEL, item_role: role,
    state: quote.state, state_name: quote.stateName, price_per_lead: String(quote.unitPrice),
    payment_mode: quote.paymentMode, currency: quote.currency,
    pricing_mode: effectiveForceUsd(quote.paymentMode, forceUsd) ? "forced_usd" : "adaptive",
    ...(role === "card_fee" ? { order_quantity: String(quote.leadCount), payment_fee_amount: String(quote.fee), payment_fee_percent: String(quote.feePercent) } : {}),
  };
}

export function isLeadItemPlan(plan: Whop.Plan | Whop.PlanListItem, accountId: string, productId: string, quote: LeadQuote, forceUsd = false, role: ItemRole = "leads") {
  const expected = leadItemMetadata(quote, forceUsd, role);
  const config = paymentConfigurationFor(quote.paymentMode);
  const actual = plan.payment_method_configuration;
  return plan.account?.id === accountId && plan.product?.id === productId &&
    plan.currency === "usd" && plan.plan_type === "one_time" && plan.visibility === "quick_link" &&
    plan.adaptive_pricing_enabled === !effectiveForceUsd(quote.paymentMode, forceUsd) &&
    Math.round(plan.initial_price * 100) === (role === "leads" ? Math.round(quote.unitPrice * 100) : quote.feeCents) &&
    (role !== "leads" || (plan as QuantityPlan).allow_multiple_quantity === true) &&
    Object.entries(expected).every(([key, value]) => plan.metadata?.[key] === value) &&
    actual?.include_platform_defaults === false &&
    ["enabled", "disabled"].every((key) => {
      const values = actual?.[key];
      const wanted = config[key as "enabled" | "disabled"];
      return Array.isArray(values) && values.length === wanted.length && wanted.every((method) => values.includes(method));
    });
}

async function resolveItemPlan(whop: WhopClient, accountId: string, productId: string, quote: LeadQuote, forceUsd: boolean, role: ItemRole) {
  const plans = await whop.plans.list({ account_id: accountId, product_ids: [productId], plan_types: ["one_time"], visibilities: ["quick_link"], first: 100 });
  for await (const plan of plans) {
    if (isLeadItemPlan(plan, accountId, productId, quote, forceUsd, role)) return plan;
  }
  const price = role === "leads" ? quote.unitPrice : quote.fee;
  const plan = await whop.plans.create({
    account_id: accountId, product_id: productId, currency: "usd", initial_price: price,
    plan_type: "one_time", visibility: "quick_link", unlimited_stock: true,
    title: role === "leads" ? `${quote.state} lead (${quote.paymentMode === "card" ? "Card" : "Wire & ACH"})` : `${quote.state} card fee (2.7%)`,
    sku: role === "leads" ? `LOUDR-LEADS-${quote.state}` : `LOUDR-CARD-FEE-${quote.state}`,
    adaptive_pricing_enabled: !effectiveForceUsd(quote.paymentMode, forceUsd),
    payment_method_configuration: paymentConfigurationFor(quote.paymentMode),
    metadata: leadItemMetadata(quote, forceUsd, role),
  }, {
    // The API accepts this field; SDK 2.6 omits it from the generated plan type.
    additionalBodyParameters: { allow_multiple_quantity: role === "leads" },
    idempotencyKey: `loudr-unit-v1-${accountId}-${productId}-${quote.state}-${quote.unitPrice}-${quote.paymentMode}-${effectiveForceUsd(quote.paymentMode, forceUsd) ? "usd" : "adaptive"}-${role}${role === "card_fee" ? `-${quote.leadCount}-${quote.feeCents}` : ""}`,
  });
  if (!isLeadItemPlan(plan, accountId, productId, quote, forceUsd, role)) throw new Error("Whop could not configure the requested lead item.");
  return plan;
}

export async function getLeadCheckout(whop: WhopClient, accountId: string, productId: string, quote: LeadQuote, forceUsd = false) {
  const leadPlan = await resolveItemPlan(whop, accountId, productId, quote, forceUsd, "leads");
  const items: LeadCheckoutItem[] = [{ plan: leadPlan.id, quantity: quote.leadCount }];
  let feePlanId: string | null = null;
  if (quote.feeCents > 0) {
    const feePlan = await resolveItemPlan(whop, accountId, productId, quote, forceUsd, "card_fee");
    feePlanId = feePlan.id;
    items.push({ plan: feePlan.id, quantity: 1 });
  }
  return { planId: leadPlan.id, feePlanId, items };
}
