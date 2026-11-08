import { calculateLeadQuote, LEAD_STATES, requestedLeadCount, type LeadQuote, type LeadRate, type LeadState } from "@/lib/lead-pricing";
import { CARD_FEE_BASIS_POINTS, effectiveForceUsd, requestedPaymentMode, type PaymentMode } from "@/lib/payment-methods";

/** Whop checkouts take up to 50 items; one is reserved for the card fee. */
export const MAX_CART_STATES = 49;

export type CartLine = { state: LeadState; stateName: string; leadCount: number; unitPrice: number; amountCents: number; amount: number };
export type CartQuote = {
  paymentMode: PaymentMode; currency: "usd"; lines: CartLine[]; leadCount: number;
  amountCents: number; feeBasisPoints: number; feeCents: number; totalCents: number;
  amount: number; fee: number; total: number; feePercent: number;
};
export type CartItemInput = { state: unknown; quantity: unknown };

/** Prices every state separately; the card fee is a percentage of the whole cart, rounded once. */
export function calculateCartQuote(items: unknown, rates: readonly LeadRate[] = LEAD_STATES, paymentMode: PaymentMode = "bank", cardFeeBasisPoints: number = CARD_FEE_BASIS_POINTS): CartQuote {
  const mode = requestedPaymentMode(paymentMode);
  if (!Array.isArray(items) || items.length === 0) throw new Error("Add at least one state to your order.");
  if (items.length > MAX_CART_STATES) throw new Error(`An order can include up to ${MAX_CART_STATES} states.`);
  const seen = new Set<string>();
  const lines = items.map((item): CartLine => {
    if (typeof item !== "object" || item === null) throw new Error("Choose a valid state.");
    const { state, quantity } = item as CartItemInput;
    const quote = calculateLeadQuote(state, quantity, rates, "bank");
    if (seen.has(quote.state)) throw new Error(`${quote.stateName} is already in your order. Change its lead count instead.`);
    seen.add(quote.state);
    return { state: quote.state, stateName: quote.stateName, leadCount: quote.leadCount, unitPrice: quote.unitPrice,
      amountCents: quote.amountCents, amount: quote.amount };
  });
  const amountCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const feeBasisPoints = mode === "card" ? cardFeeBasisPoints : 0;
  const feeCents = Math.round(amountCents * feeBasisPoints / 10_000);
  const totalCents = amountCents + feeCents;
  return { paymentMode: mode, currency: "usd", lines, leadCount: lines.reduce((sum, line) => sum + line.leadCount, 0),
    amountCents, feeBasisPoints, feeCents, totalCents, amount: amountCents / 100, fee: feeCents / 100,
    total: totalCents / 100, feePercent: feeBasisPoints / 100 };
}

/** The single-state quote used to find or create one state's per-lead plan. */
export function lineQuote(cart: CartQuote, line: CartLine): LeadQuote {
  return calculateLeadQuote(line.state, line.leadCount, [{ code: line.state, name: line.stateName, price: line.unitPrice }], cart.paymentMode);
}

/** Accepts `{ items: [{ state, quantity }] }`, or the original single-state `{ state, quantity }`. */
export function requestedCartItems(input: Record<string, unknown>): unknown {
  if (input.items !== undefined) {
    if (input.state !== undefined || input.quantity !== undefined || input.leadCount !== undefined) throw new Error("Send either items or a single state, not both.");
    return input.items;
  }
  return [{ state: input.state, quantity: requestedLeadCount(input) }];
}

export function cartKey(cart: CartQuote): string {
  return `${cart.paymentMode}:${cart.lines.map((line) => `${line.state}x${line.leadCount}@${line.unitPrice}`).join(",")}:${cart.totalCents}`;
}

/** Descriptive checkout metadata. It is never used to verify or fulfill an order. */
export function cartMetadata(cart: CartQuote, forceUsd = false): Record<string, string> {
  const items = cart.lines.map((line) => `${line.state}:${line.leadCount}`).join(",");
  return { source: "loudr-leads-site", currency: cart.currency, payment_mode: cart.paymentMode,
    pricing_mode: effectiveForceUsd(cart.paymentMode, forceUsd) ? "forced_usd" : "adaptive",
    state_count: String(cart.lines.length), quantity: String(cart.leadCount),
    ...(items.length <= 400 ? { items } : {}),
    ...(cart.lines.length === 1 ? { state: cart.lines[0].state, state_name: cart.lines[0].stateName, price_per_lead: String(cart.lines[0].unitPrice) } : {}),
    subtotal_amount: String(cart.amount), payment_fee_percent: String(cart.feePercent), payment_fee_amount: String(cart.fee),
    total_amount: String(cart.total) };
}
