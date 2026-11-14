import type { CartQuote } from "@/lib/lead-cart";
import { paymentConfigurationFor, type PaymentMode } from "@/lib/payment-methods";

/**
 * Team (closer) tools: shareable Whop payment links and proposals sent through the
 * n8n → GoHighLevel automation. Prices always come from the saved rate card on the server.
 */

/** Metadata `source` on links made with "Generate link". The n8n payment flow alerts on these for review. */
export const TEAM_LINK_SOURCE = "loudr-team-link";
/** Version of the JSON body POSTed to the n8n proposal webhook. Bump on breaking changes. */
export const PROPOSAL_PAYLOAD_VERSION = 1;
export const PROPOSAL_EVENT = "loudr.proposal.send";
/** Generated links a closer can ask the automation to retire once a proposal is sent. */
export const MAX_RETIRE_PLAN_IDS = 20;
export const PLAN_ID = /^plan_[A-Za-z0-9]+$/;
export const WHOP_CHECKOUT_URL = /^https:\/\/whop\.com\/checkout\/[A-Za-z0-9_-]+\/?(?:\?[^\s#]*)?$/;

/** Rep names must match the rep dropdown / `reps` map in the n8n Proposal settings node. */
export const DEFAULT_TEAM_REPS = ["Mason Church", "Jeremiah Iroff", "Bernardo Morales"] as const;

/** Rep names from `TEAM_REP_NAMES` (comma-separated), or the automation's three reps. */
export function teamRepNames(value: string | undefined = typeof process === "undefined" ? undefined : process.env.TEAM_REP_NAMES): string[] {
  const names = (value ?? "").split(",").map((name) => name.trim()).filter((name) => name && name.length <= 80);
  return names.length ? [...new Set(names)] : [...DEFAULT_TEAM_REPS];
}

export class TeamRequestError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "TeamRequestError";
  }
}

export type ProposalClient = { firstName: string; lastName: string; email: string; phone: string; firm: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/** The client details a proposal needs. The same fields the n8n proposal form collected. */
export function validateClient(input: unknown): ProposalClient {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const client = {
    firstName: text(value.firstName, 80), lastName: text(value.lastName, 80),
    email: text(value.email, 200).toLowerCase(), phone: text(value.phone, 40), firm: text(value.firm, 160),
  };
  if (!client.firstName) throw new TeamRequestError("Enter the client’s first name.");
  if (!EMAIL.test(client.email)) throw new TeamRequestError("Enter a valid client email.");
  if (!client.firm) throw new TeamRequestError("Enter the law firm name.");
  if (client.phone && !/^[+()\d\s.-]{7,40}$/.test(client.phone)) throw new TeamRequestError("Enter a valid phone number, or leave it blank.");
  return client;
}

export function validateRep(value: unknown, reps: readonly string[]): string {
  if (typeof value !== "string" || !reps.includes(value)) throw new TeamRequestError("Choose your name from the rep list.");
  return value;
}

/** Optional client details for a payment link: kept on the Whop payment so a payer can be matched. */
export function optionalClient(input: unknown): Partial<ProposalClient> {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const email = text(value.email, 200).toLowerCase();
  return { firstName: text(value.firstName, 80), lastName: text(value.lastName, 80), firm: text(value.firm, 160),
    email: EMAIL.test(email) ? email : "" };
}

export function retirePlanIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RETIRE_PLAN_IDS || value.some((id) => typeof id !== "string" || !PLAN_ID.test(id))) {
    throw new TeamRequestError("Send earlier payment link IDs as a list of plan IDs.");
  }
  return [...new Set(value as string[])];
}

/** `$25,000` or `$25,750.50`: the same money format the n8n workflow writes into GHL. */
export function money(amount: number): string {
  return "$" + amount.toLocaleString("en-US", { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/** One-line descriptions of an order, matching the text the n8n workflow stores on Whop payments. */
export function orderText(cart: CartQuote) {
  const multi = cart.lines.length > 1;
  return {
    state: cart.lines.map((line) => line.stateName).join(", "),
    leads: multi ? `${cart.leadCount} (${cart.lines.map((line) => `${line.stateName} ${line.leadCount}`).join(", ")})` : String(cart.leadCount),
    cpl: multi ? cart.lines.map((line) => `${line.stateName} ${money(line.unitPrice)}`).join(", ") : money(cart.lines[0].unitPrice),
  };
}

export function paymentLinkTitle(cart: CartQuote): string {
  return `${cart.leadCount} MVA Leads ${cart.paymentMode === "card" ? "Card" : "Wire"}`.slice(0, 30);
}

type LinkContext = { accountId: string; linkId: string; rep: string | null; createdBy: string; client: Partial<ProposalClient> };

/**
 * A Whop checkout configuration with its own hidden one-time plan priced at the order total,
 * the same kind of link the n8n proposal flow creates, so the automation can retire it later.
 * Card links can be paid once; wire links stay open until retired, as in the automation.
 */
export function paymentLinkRequest(cart: CartQuote, context: LinkContext) {
  const summary = orderText(cart);
  const items = cart.lines.map((line) => `${line.state}:${line.leadCount}@${line.unitPrice}`).join(",");
  const metadata: Record<string, string> = {
    source: TEAM_LINK_SOURCE, link_id: context.linkId, pay_method: cart.paymentMode === "card" ? "card" : "wire",
    rep: context.rep ?? "", created_by: context.createdBy.slice(0, 120),
    firm: context.client.firm ?? "", email: context.client.email ?? "",
    client: [context.client.firstName, context.client.lastName].filter(Boolean).join(" ").slice(0, 160),
    leads: summary.leads.slice(0, 480), cpl: summary.cpl.slice(0, 480), total: money(cart.total), state: summary.state.slice(0, 480),
    quantity: String(cart.leadCount), subtotal_amount: String(cart.amount), payment_fee_percent: String(cart.feePercent),
    payment_fee_amount: String(cart.fee), total_amount: String(cart.total), currency: "usd",
    ...(items.length <= 480 ? { items } : {}),
  };
  for (const key of Object.keys(metadata)) if (!metadata[key]) delete metadata[key];
  return {
    account_id: context.accountId, mode: "payment" as const, metadata,
    plan: {
      account_id: context.accountId, title: paymentLinkTitle(cart), plan_type: "one_time" as const, initial_price: cart.total,
      // Adaptive (local-currency) pricing is never enabled: every link charges USD.
      currency: "usd", adaptive_pricing_enabled: false, visibility: "hidden" as const, force_create_new_plan: true,
      ...(cart.paymentMode === "card" ? { stock: 1, unlimited_stock: false } : { unlimited_stock: true }),
      payment_method_configuration: paymentConfigurationFor(cart.paymentMode), metadata,
    },
  };
}

type CheckoutConfigurationResult = { purchase_url?: unknown; plan?: { id?: unknown; initial_price?: unknown; currency?: unknown; plan_type?: unknown } | null };

/** Confirms Whop returned a usable link for exactly this total before it is shown to a closer. */
export function checkPaymentLink(result: CheckoutConfigurationResult, cart: CartQuote): { url: string; planId: string } {
  const url = typeof result?.purchase_url === "string" ? result.purchase_url : "";
  const plan = result?.plan;
  if (!WHOP_CHECKOUT_URL.test(url)) throw new Error("Whop did not return a usable payment link.");
  if (!plan || typeof plan.id !== "string" || !PLAN_ID.test(plan.id)) throw new Error("Whop did not return the link’s plan.");
  if (Math.round(Number(plan.initial_price) * 100) !== cart.totalCents || plan.currency !== "usd" || plan.plan_type !== "one_time") {
    throw new Error("Whop returned a payment link that doesn’t match this order total.");
  }
  return { url, planId: plan.id };
}

type ProposalContext = {
  proposalId: string; createdAt: string; rep: string; signedIn: { userId: string; name: string | null };
  client: ProposalClient; bank: CartQuote; card: CartQuote; priceVersion: string; retirePlanIds: string[]; siteOrigin: string;
};

/**
 * The JSON body POSTed to the n8n proposal webhook. Amounts are USD numbers worked out from
 * the saved rate card; the workflow formats them for GHL exactly as its proposal form did.
 */
export function proposalPayload(context: ProposalContext) {
  const { bank, card } = context;
  if (bank.paymentMode !== "bank" || card.paymentMode !== "card" || bank.lines.length !== card.lines.length ||
    bank.lines.some((line, index) => card.lines[index].state !== line.state || card.lines[index].leadCount !== line.leadCount || card.lines[index].unitPrice !== line.unitPrice)) {
    throw new Error("Wire and card quotes must describe the same order.");
  }
  return {
    event: PROPOSAL_EVENT, version: PROPOSAL_PAYLOAD_VERSION, proposal_id: context.proposalId, created_at: context.createdAt,
    source: "loudr-leads-site", site: context.siteOrigin,
    rep: { name: context.rep, whop_user_id: context.signedIn.userId, whop_name: context.signedIn.name },
    client: { first_name: context.client.firstName, last_name: context.client.lastName, email: context.client.email,
      phone: context.client.phone, firm: context.client.firm },
    order: {
      states: bank.lines.map((line) => ({ code: line.state, name: line.stateName, leads: line.leadCount,
        wire_price_per_lead: line.unitPrice, subtotal: line.amount })),
      lead_count: bank.leadCount, wire_total: bank.total, card_subtotal: card.amount, card_fee: card.fee,
      card_fee_percent: card.feePercent, card_total: card.total, currency: "usd", price_version: context.priceVersion,
    },
    retire_plan_ids: context.retirePlanIds,
  };
}
export type ProposalPayload = ReturnType<typeof proposalPayload>;

export type ProposalResult = {
  sent: true; email: string; signingUrl: string | null; cardUrl: string | null; wireUrl: string | null;
  cardTotal: string | null; wireTotal: string | null;
};

/** Reads the workflow's reply. Anything but an explicit `sent: true` counts as not sent. */
export function readProposalResult(body: unknown, email: string): ProposalResult | { sent: false; error: string } {
  const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const url = (item: unknown) => typeof item === "string" && /^https:\/\/[^\s"<>]+$/.test(item) && item.length <= 500 ? item : null;
  const amount = (item: unknown) => typeof item === "string" && item.length <= 40 ? item : typeof item === "number" ? money(item) : null;
  if (value.sent !== true) {
    const error = typeof value.error === "string" && value.error.trim() ? value.error.trim().slice(0, 300) : "The automation didn’t confirm the proposal was sent.";
    return { sent: false, error };
  }
  return { sent: true, email: typeof value.email === "string" && EMAIL.test(value.email) ? value.email : email,
    signingUrl: url(value.signing_url), cardUrl: url(value.card_url), wireUrl: url(value.wire_url),
    cardTotal: amount(value.card_total), wireTotal: amount(value.wire_total) };
}
