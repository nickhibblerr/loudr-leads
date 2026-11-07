import type { Whop } from "@whop/sdk";
import { calculateLeadQuote, LEAD_STATES } from "@/lib/lead-pricing";
import { requestedPaymentMode } from "@/lib/payment-methods";
import { isCardFeePlan, isPurchasedLeadPlan, LEAD_PRICING_MODEL } from "@/lib/lead-checkout";
import { calculateCartQuote, MAX_CART_STATES } from "@/lib/lead-cart";
import { isTopUpPlanForAmount } from "@/lib/whop-plans";

// Use merchant-created plan metadata and historical prices, never buyer metadata.
function legacyPaidLeadOrder(payment: Whop.Payment, plan: Whop.Plan, accountId: string, productId: string) {
  if (payment.status !== "paid" || !payment.paid_at || !/^pay_[a-zA-Z0-9]+$/.test(payment.id) ||
    payment.account_id !== accountId || payment.product_id !== productId || payment.plan_id !== plan.id) throw new Error("Not a paid lead order.");
  const m = plan.metadata;
  const state = LEAD_STATES.find((item) => item.code === m?.state);
  if (!state || !m || typeof m.quantity !== "string" || !/^\d+$/.test(m.quantity) ||
    typeof m.price_per_lead !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(m.price_per_lead) ||
    (m.payment_mode !== "bank" && m.payment_mode !== "card") ||
    (m.pricing_mode !== "forced_usd" && m.pricing_mode !== "adaptive")) throw new Error("Invalid lead metadata.");
  const quote = calculateLeadQuote(state.code, Number(m.quantity), [{ ...state, price: Number(m.price_per_lead) }], requestedPaymentMode(m.payment_mode));
  if (!isTopUpPlanForAmount(plan, accountId, productId, quote, m.pricing_mode === "forced_usd")) throw new Error("Plan does not match order.");
  return paidOrder(payment.id, [{ state: quote.state, stateName: quote.stateName, quantity: quote.leadCount }], quote.total, quote.paymentMode);
}

export type PaidOrderItem = { state: string; stateName: string; quantity: number };
export type PaidLeadOrder = { paymentId: string; items: PaidOrderItem[]; quantity: number; orderTotalUsd: number; paymentMode: "bank" | "card" };

function paidOrder(paymentId: string, items: PaidOrderItem[], orderTotalUsd: number, paymentMode: "bank" | "card"): PaidLeadOrder {
  return { paymentId, items, quantity: items.reduce((sum, item) => sum + item.quantity, 0), orderTotalUsd, paymentMode };
}

const MONEY = /^\d+(?:\.\d+)?$/;

export function paidLeadOrder(payment: Whop.Payment, purchasedPlans: Whop.Plan | Whop.Plan[], accountId: string, productId: string): PaidLeadOrder {
  const plans = Array.isArray(purchasedPlans) ? purchasedPlans : [purchasedPlans];
  if (plans.length === 1 && !plans[0].metadata?.pricing_model) return legacyPaidLeadOrder(payment, plans[0], accountId, productId);
  if (payment.status !== "paid" || !payment.paid_at || !/^pay_[a-zA-Z0-9]+$/.test(payment.id) || payment.account_id !== accountId) throw new Error("Not a paid lead order.");
  const lines = payment.line_items;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_CART_STATES + 1 || lines.length !== plans.length ||
    new Set(lines.map((line) => line.plan_id)).size !== lines.length) throw new Error("Invalid purchased items.");
  const planFor = (id: string | null) => plans.find((plan) => plan.id === id);
  const leadLines = lines.filter((line) => planFor(line.plan_id)?.metadata?.item_role === "leads");
  const feeLines = lines.filter((line) => planFor(line.plan_id)?.metadata?.item_role === "card_fee");
  if (leadLines.length < 1 || feeLines.length > 1 || leadLines.length + feeLines.length !== lines.length) throw new Error("Unexpected purchased items.");

  const first = planFor(leadLines[0].plan_id)!.metadata!;
  const mode = first.payment_mode;
  const pricingMode = first.pricing_mode;
  if ((mode !== "bank" && mode !== "card") || (pricingMode !== "forced_usd" && pricingMode !== "adaptive")) throw new Error("Invalid lead item.");
  const forceUsd = pricingMode === "forced_usd";
  const feeLine = feeLines[0];
  const feePlan = feeLine ? planFor(feeLine.plan_id)! : null;

  // Lead plans are repriced in place when the admin changes a price, so the price paid
  // comes from this receipt: the USD amount Whop charged for each state's line. For a
  // local-currency card payment, a state-specific fee item from an earlier single-state
  // order records its price; otherwise the plan's own price is used.
  const items = leadLines.map((line) => {
    const plan = planFor(line.plan_id)!;
    const m = plan.metadata!;
    const state = LEAD_STATES.find((item) => item.code === m.state);
    if (!state || m.pricing_model !== LEAD_PRICING_MODEL || m.payment_mode !== mode || m.pricing_mode !== pricingMode ||
      line.product_id !== productId || !Number.isInteger(line.quantity) || line.quantity < 1) throw new Error("Invalid lead item.");
    const amount = line.subtotal?.amount;
    let unitPrice: number;
    if (line.subtotal?.currency === "usd" && typeof amount === "string" && MONEY.test(amount)) {
      const cents = Math.round(Number(amount) * 100);
      if (cents % line.quantity !== 0) throw new Error("Lead item amount does not match quantity.");
      unitPrice = cents / line.quantity / 100;
    } else {
      if (forceUsd || !line.subtotal || line.subtotal.currency !== payment.currency || typeof amount !== "string" || !MONEY.test(amount)) throw new Error("Lead item amount unavailable.");
      const recorded = feePlan?.metadata?.state === state.code ? feePlan.metadata?.price_per_lead : m.price_per_lead;
      if (typeof recorded !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(recorded)) throw new Error("Lead item price unavailable.");
      unitPrice = Number(recorded);
    }
    const quote = calculateLeadQuote(state.code, line.quantity, [{ ...state, price: unitPrice }], mode);
    if (!isPurchasedLeadPlan(plan, accountId, productId, quote, forceUsd)) throw new Error("Lead item does not match receipt.");
    return { state: state.code, name: state.name, quantity: line.quantity, price: unitPrice };
  });
  const cart = calculateCartQuote(items.map((item) => ({ state: item.state, quantity: item.quantity })),
    items.map((item) => ({ code: item.state, name: item.name, price: item.price })), mode);

  if ((cart.feeCents > 0) !== Boolean(feeLine)) throw new Error("Card fee item does not match order.");
  if (feeLine && feePlan) {
    const amount = feeLine.subtotal?.amount;
    const usd = feeLine.subtotal?.currency === "usd";
    if (feeLine.quantity !== 1 || feeLine.product_id !== productId || typeof amount !== "string" || !MONEY.test(amount) ||
      !isCardFeePlan(feePlan, accountId, productId, forceUsd, usd ? cart.feeCents : null, leadLines.length === 1) ||
      (usd ? Math.round(Number(amount) * 100) !== cart.feeCents : forceUsd || feeLine.subtotal?.currency !== payment.currency)) throw new Error("Card fee item does not match order.");
  }
  // A local-currency card payment reports its USD value on the payment itself; use it
  // rather than recomputing from plan prices, which may have changed since checkout.
  const localCurrency = lines.some((line) => line.subtotal?.currency !== "usd");
  const usdTotal = (payment as { usd_total?: { currency?: string; amount?: string } | null }).usd_total;
  const orderTotalUsd = localCurrency && usdTotal?.currency === "usd" && typeof usdTotal.amount === "string" && MONEY.test(usdTotal.amount)
    ? Math.round(Number(usdTotal.amount) * 100) / 100 : cart.total;
  return paidOrder(payment.id, cart.lines.map((line) => ({ state: line.state, stateName: line.stateName, quantity: line.leadCount })), orderTotalUsd, cart.paymentMode);
}

export function slackOrderMessage(order: PaidLeadOrder) {
  const states = order.items.length === 1
    ? `State: ${order.items[0].stateName} (${order.items[0].state})\nLeads: ${order.items[0].quantity}`
    : `States:\n${order.items.map((item) => `• ${item.stateName} (${item.state}): ${item.quantity} ${item.quantity === 1 ? "lead" : "leads"}`).join("\n")}\nTotal leads: ${order.quantity}`;
  return { text: `Paid LOUDR lead order\n${states}\nOrder total (USD): $${order.orderTotalUsd.toFixed(2)}\nCheckout: ${order.paymentMode === "card" ? "Card" : "Wire"}\nPayment ID: ${order.paymentId}`,
    unfurl_links: false, unfurl_media: false };
}
