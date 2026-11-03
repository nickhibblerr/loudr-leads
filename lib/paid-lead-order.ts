import type { Whop } from "@whop/sdk";
import { calculateLeadQuote, LEAD_STATES } from "@/lib/lead-pricing";
import { requestedPaymentMode } from "@/lib/payment-methods";
import { isLeadItemPlan, LEAD_PRICING_MODEL } from "@/lib/lead-checkout";
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
  return { paymentId: payment.id, state: quote.state, stateName: quote.stateName, quantity: quote.leadCount,
    orderTotalUsd: quote.total, paymentMode: quote.paymentMode };
}

export function paidLeadOrder(payment: Whop.Payment, purchasedPlans: Whop.Plan | Whop.Plan[], accountId: string, productId: string) {
  const plans = Array.isArray(purchasedPlans) ? purchasedPlans : [purchasedPlans];
  if (plans.length === 1 && !plans[0].metadata?.pricing_model) return legacyPaidLeadOrder(payment, plans[0], accountId, productId);
  if (payment.status !== "paid" || !payment.paid_at || !/^pay_[a-zA-Z0-9]+$/.test(payment.id) || payment.account_id !== accountId) throw new Error("Not a paid lead order.");
  const lines = payment.line_items;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 2 || lines.length !== plans.length ||
    new Set(lines.map((line) => line.plan_id)).size !== lines.length) throw new Error("Invalid purchased items.");
  const leadPlans = plans.filter((plan) => plan.metadata?.pricing_model === LEAD_PRICING_MODEL && plan.metadata?.item_role === "leads");
  if (leadPlans.length !== 1) throw new Error("Expected one state lead item.");
  const plan = leadPlans[0];
  const line = lines.find((item) => item.plan_id === plan.id);
  const m = plan.metadata!;
  const state = LEAD_STATES.find((item) => item.code === m.state);
  if (!line || !state || typeof m.price_per_lead !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(m.price_per_lead) ||
    (m.payment_mode !== "bank" && m.payment_mode !== "card") ||
    (m.pricing_mode !== "forced_usd" && m.pricing_mode !== "adaptive")) throw new Error("Invalid lead item.");
  const quote = calculateLeadQuote(state.code, line.quantity, [{ ...state, price: Number(m.price_per_lead) }], m.payment_mode);
  const forceUsd = m.pricing_mode === "forced_usd";
  if (!isLeadItemPlan(plan, accountId, productId, quote, forceUsd) || lines.length !== (quote.feeCents > 0 ? 2 : 1)) throw new Error("Lead item does not match receipt.");
  for (const item of lines) {
    const itemPlan = plans.find((candidate) => candidate.id === item.plan_id);
    const isLead = item.plan_id === plan.id;
    const cents = isLead ? quote.amountCents : quote.feeCents;
    if (!itemPlan || item.product_id !== productId || (!isLead && (item.quantity !== 1 || !isLeadItemPlan(itemPlan, accountId, productId, quote, forceUsd, "card_fee"))) ||
      !item.subtotal || !/^\d+(?:\.\d+)?$/.test(item.subtotal.amount) || !Number.isFinite(Number(item.subtotal.amount)) || Number(item.subtotal.amount) < 0 ||
      (item.subtotal.currency === "usd" ? Math.round(Number(item.subtotal.amount) * 100) !== cents :
        forceUsd || item.subtotal.currency !== payment.currency)) throw new Error("Purchased item amount does not match order.");
  }
  return { paymentId: payment.id, state: quote.state, stateName: quote.stateName, quantity: quote.leadCount,
    orderTotalUsd: quote.total, paymentMode: quote.paymentMode };
}

export function slackOrderMessage(order: ReturnType<typeof paidLeadOrder>) {
  return { text: `Paid LOUDR lead order\nState: ${order.stateName} (${order.state})\nLeads: ${order.quantity}\nOrder total (USD): $${order.orderTotalUsd.toFixed(2)}\nCheckout: ${order.paymentMode === "card" ? "Card" : "Wire & ACH"}\nPayment ID: ${order.paymentId}`,
    unfurl_links: false, unfurl_media: false };
}
