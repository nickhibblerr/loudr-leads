import type { Whop, WhopClient } from "@whop/sdk";
import { effectiveForceUsd, paymentConfigurationFor } from "@/lib/payment-methods";
import type { LeadQuote } from "@/lib/lead-pricing";
import { calculateCartQuote, lineQuote, type CartQuote } from "@/lib/lead-cart";

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

// Matches everything that identifies an item except its price. A state's lead plan keeps
// its ID and is repriced in place when the admin changes that state's price per lead.
function isLeadItemFamily(plan: Whop.Plan | Whop.PlanListItem, accountId: string, productId: string, quote: LeadQuote, forceUsd = false, role: ItemRole = "leads", anyMethods = false) {
  const expected: Record<string, string> = leadItemMetadata(quote, forceUsd, role);
  if (role === "leads") delete expected.price_per_lead;
  const config = paymentConfigurationFor(quote.paymentMode);
  const actual = plan.payment_method_configuration;
  return plan.account?.id === accountId && plan.product?.id === productId &&
    plan.currency === "usd" && plan.plan_type === "one_time" && plan.visibility === "quick_link" &&
    plan.adaptive_pricing_enabled === !effectiveForceUsd(quote.paymentMode, forceUsd) &&
    (role !== "leads" || (plan as QuantityPlan).allow_multiple_quantity === true) &&
    Object.entries(expected).every(([key, value]) => plan.metadata?.[key] === value) &&
    (anyMethods || hasMethods(actual, config));
}

function hasMethods(actual: Record<string, unknown> | null | undefined, config: ReturnType<typeof paymentConfigurationFor>) {
  return actual?.include_platform_defaults === false &&
    ["enabled", "disabled"].every((key) => {
      const values = actual?.[key];
      const wanted = config[key as "enabled" | "disabled"];
      return Array.isArray(values) && values.length === wanted.length && wanted.every((method) => values.includes(method));
    });
}

export function isLeadItemPlan(plan: Whop.Plan | Whop.PlanListItem, accountId: string, productId: string, quote: LeadQuote, forceUsd = false, role: ItemRole = "leads") {
  return isLeadItemFamily(plan, accountId, productId, quote, forceUsd, role) &&
    Math.round(plan.initial_price * 100) === (role === "leads" ? Math.round(quote.unitPrice * 100) : quote.feeCents) &&
    plan.metadata?.price_per_lead === String(quote.unitPrice);
}

/**
 * A purchased lead line is checked against the plan's identity; its price comes from the
 * receipt. Payment methods are not compared: earlier Wire orders were placed while the
 * plan also offered ACH, and the plan has been switched to wire only since.
 */
export function isPurchasedLeadPlan(plan: Whop.Plan | Whop.PlanListItem, accountId: string, productId: string, quote: LeadQuote, forceUsd = false) {
  return isLeadItemFamily(plan, accountId, productId, quote, forceUsd, "leads", true);
}

function leadPlanTitle(state: string, mode: LeadQuote["paymentMode"]) {
  return `${state} lead (${mode === "card" ? "Card" : "Wire"})`;
}

type ProductPlan = Whop.Plan | Whop.PlanListItem;

async function listProductPlans(whop: WhopClient, accountId: string, productId: string): Promise<ProductPlan[]> {
  const plans: ProductPlan[] = [];
  const page = await whop.plans.list({ account_id: accountId, product_ids: [productId], plan_types: ["one_time"], visibilities: ["quick_link"], first: 100 });
  for await (const plan of page) plans.push(plan);
  return plans;
}

/** Finds the state's lead plan for this payment mode, repricing it in place if the admin changed the price. */
async function resolveLeadPlan(whop: WhopClient, plans: ProductPlan[], accountId: string, productId: string, quote: LeadQuote, forceUsd: boolean) {
  const exact = plans.find((plan) => isLeadItemPlan(plan, accountId, productId, quote, forceUsd));
  if (exact) return exact;
  // Same state and checkout, but an old price or old payment methods (e.g. Wire & ACH):
  // update that plan in place rather than adding another.
  const samePlanOtherPrice = plans.find((plan) => isLeadItemFamily(plan, accountId, productId, quote, forceUsd, "leads", true));
  if (samePlanOtherPrice) {
    const plan = await repriceLeadPlan(whop, samePlanOtherPrice, quote.unitPrice);
    if (!isLeadItemPlan(plan, accountId, productId, quote, forceUsd)) throw new Error("Whop could not reprice the requested lead item.");
    plans.push(plan);
    return plan;
  }
  const plan = await whop.plans.create({
    account_id: accountId, product_id: productId, currency: "usd", initial_price: quote.unitPrice,
    plan_type: "one_time", visibility: "quick_link", unlimited_stock: true,
    title: leadPlanTitle(quote.state, quote.paymentMode), sku: `LOUDR-LEADS-${quote.state}`,
    adaptive_pricing_enabled: !effectiveForceUsd(quote.paymentMode, forceUsd),
    payment_method_configuration: paymentConfigurationFor(quote.paymentMode),
    metadata: leadItemMetadata(quote, forceUsd),
  }, {
    // The API accepts this field; SDK 2.6 omits it from the generated plan type.
    additionalBodyParameters: { allow_multiple_quantity: true },
    idempotencyKey: `loudr-unit-v1-${accountId}-${productId}-${quote.state}-${quote.unitPrice}-${quote.paymentMode}-${effectiveForceUsd(quote.paymentMode, forceUsd) ? "usd" : "adaptive"}-leads`,
  });
  if (!isLeadItemPlan(plan, accountId, productId, quote, forceUsd)) throw new Error("Whop could not configure the requested lead item.");
  plans.push(plan);
  return plan;
}

export function cardFeeMetadata(fee: number, feePercent: number, forceUsd: boolean) {
  return { source: "loudr-leads-site", pricing_model: LEAD_PRICING_MODEL, item_role: "card_fee", fee_scope: "order",
    payment_mode: "card", currency: "usd", pricing_mode: forceUsd ? "forced_usd" : "adaptive",
    payment_fee_amount: String(fee), payment_fee_percent: String(feePercent) };
}

/**
 * A card fee item. New orders use one fee item for the whole order (`fee_scope: order`);
 * receipts from earlier single-state orders carry a state-specific fee item, which
 * `allowStateFee` accepts. Price is checked only when `feeCents` is given.
 */
export function isCardFeePlan(plan: ProductPlan, accountId: string, productId: string, forceUsd: boolean, feeCents: number | null, allowStateFee = false) {
  const m = plan.metadata;
  const config = paymentConfigurationFor("card");
  const actual = plan.payment_method_configuration;
  return plan.account?.id === accountId && plan.product?.id === productId &&
    plan.currency === "usd" && plan.plan_type === "one_time" && plan.visibility === "quick_link" &&
    plan.adaptive_pricing_enabled === !forceUsd &&
    m?.source === "loudr-leads-site" && m?.pricing_model === LEAD_PRICING_MODEL && m?.item_role === "card_fee" &&
    m?.payment_mode === "card" && m?.pricing_mode === (forceUsd ? "forced_usd" : "adaptive") &&
    (m?.fee_scope === "order" ? m?.state === undefined : allowStateFee && typeof m?.state === "string") &&
    typeof m?.payment_fee_amount === "string" && /^\d+(?:\.\d{1,2})?$/.test(m.payment_fee_amount) &&
    Math.round(Number(m.payment_fee_amount) * 100) === Math.round(plan.initial_price * 100) &&
    (feeCents === null || Math.round(plan.initial_price * 100) === feeCents) &&
    actual?.include_platform_defaults === false &&
    ["enabled", "disabled"].every((key) => {
      const values = actual?.[key];
      const wanted = config[key as "enabled" | "disabled"];
      return Array.isArray(values) && values.length === wanted.length && wanted.every((method) => values.includes(method));
    });
}

async function resolveCardFeePlan(whop: WhopClient, plans: ProductPlan[], accountId: string, productId: string, cart: CartQuote, forceUsd: boolean) {
  const existing = plans.find((plan) => isCardFeePlan(plan, accountId, productId, forceUsd, cart.feeCents));
  if (existing) return existing;
  const plan = await whop.plans.create({
    account_id: accountId, product_id: productId, currency: "usd", initial_price: cart.fee,
    plan_type: "one_time", visibility: "quick_link", unlimited_stock: true,
    title: `Card fee (${cart.feePercent}%)`, sku: "LOUDR-CARD-FEE",
    adaptive_pricing_enabled: !forceUsd, payment_method_configuration: paymentConfigurationFor("card"),
    metadata: cardFeeMetadata(cart.fee, cart.feePercent, forceUsd),
  }, {
    additionalBodyParameters: { allow_multiple_quantity: false },
    idempotencyKey: `loudr-order-fee-v1-${accountId}-${productId}-${cart.feeCents}-${forceUsd ? "usd" : "adaptive"}`,
  });
  if (!isCardFeePlan(plan, accountId, productId, forceUsd, cart.feeCents)) throw new Error("Whop could not configure the card fee.");
  plans.push(plan);
  return plan;
}

async function repriceLeadPlan(whop: WhopClient, plan: Whop.Plan | Whop.PlanListItem, price: number) {
  const mode = plan.metadata?.payment_mode === "card" ? "card" : "bank";
  const state = typeof plan.metadata?.state === "string" ? plan.metadata.state : "";
  return whop.plans.update({
    id: plan.id, initial_price: price, title: leadPlanTitle(state, mode),
    payment_method_configuration: paymentConfigurationFor(mode),
    metadata: { ...plan.metadata, price_per_lead: String(price) },
  });
}

/**
 * Pushes saved admin prices to the state lead plans that already exist on Whop, so the
 * product's plans show the current price per lead. States marked sold out are left alone:
 * checkout refuses them. Returns the number of plans repriced.
 */
export async function syncLeadPlanPrices(whop: WhopClient, accountId: string, productId: string, prices: { code: string; price: number | null }[]) {
  const wanted = new Map(prices.filter((item) => item.price !== null).map((item) => [item.code, item.price as number]));
  if (!wanted.size) return 0;
  const plans = await whop.plans.list({ account_id: accountId, product_ids: [productId], plan_types: ["one_time"], visibilities: ["quick_link"], first: 100 });
  let repriced = 0;
  for await (const plan of plans) {
    const m = plan.metadata;
    const price = typeof m?.state === "string" ? wanted.get(m.state) : undefined;
    if (price === undefined || plan.account?.id !== accountId || plan.product?.id !== productId ||
      m?.pricing_model !== LEAD_PRICING_MODEL || m?.item_role !== "leads") continue;
    const mode = m.payment_mode === "card" ? "card" : "bank";
    if (Math.round(plan.initial_price * 100) === Math.round(price * 100) && m.price_per_lead === String(price) &&
      hasMethods(plan.payment_method_configuration, paymentConfigurationFor(mode)) && plan.title === leadPlanTitle(m.state as string, mode)) continue;
    await repriceLeadPlan(whop, plan, price);
    repriced++;
  }
  return repriced;
}

/** One quantity line per state, plus a single card fee line covering the whole order. */
export async function getCartCheckout(whop: WhopClient, accountId: string, productId: string, cart: CartQuote, forceUsd = false) {
  const usd = effectiveForceUsd(cart.paymentMode, forceUsd);
  const plans = await listProductPlans(whop, accountId, productId);
  const items: LeadCheckoutItem[] = [];
  const lines: { state: string; plan: string; quantity: number }[] = [];
  for (const line of cart.lines) {
    const plan = await resolveLeadPlan(whop, plans, accountId, productId, lineQuote(cart, line), usd);
    items.push({ plan: plan.id, quantity: line.leadCount });
    lines.push({ state: line.state, plan: plan.id, quantity: line.leadCount });
  }
  let feePlanId: string | null = null;
  if (cart.feeCents > 0) {
    feePlanId = (await resolveCardFeePlan(whop, plans, accountId, productId, cart, usd)).id;
    items.push({ plan: feePlanId, quantity: 1 });
  }
  return { planId: items[0].plan, feePlanId, items, lines };
}

/** Single-state checkout, kept for the guarded `/api/pay` route. */
export async function getLeadCheckout(whop: WhopClient, accountId: string, productId: string, quote: LeadQuote, forceUsd = false) {
  const cart = calculateCartQuote([{ state: quote.state, quantity: quote.leadCount }],
    [{ code: quote.state, name: quote.stateName, price: quote.unitPrice }], quote.paymentMode);
  const { planId, feePlanId, items } = await getCartCheckout(whop, accountId, productId, cart, forceUsd);
  return { planId, feePlanId, items };
}
