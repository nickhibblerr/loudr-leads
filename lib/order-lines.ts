import { leadsForBudget } from "@/lib/lead-cart";
import { MAX_LEAD_QUANTITY, MIN_LEAD_QUANTITY } from "@/lib/lead-pricing";
import { isValidLeadCount, type OrderMode } from "@/lib/leads";
import type { RateState } from "@/lib/rate-card";
import { formatAmount } from "@/lib/top-up";

/**
 * One state in an order being built, on the client order page or the team proposal page.
 * `value` is a lead count, or whole dollars of lead spend in budget mode.
 */
export type OrderLine = { id: string; state: string; value: string; mode: OrderMode };

let lineSequence = 0;
export const newOrderLine = (state = "", value = "", mode: OrderMode = "budget"): OrderLine =>
  ({ id: `line-${++lineSequence}`, state, value, mode });

/** The lead count a line orders, or null when it can't be worked out yet. */
export function leadCountFor(line: OrderLine, rate: RateState | undefined): number | null {
  const entered = Number(line.value);
  if (!line.value.trim() || !Number.isSafeInteger(entered) || entered < 1) return null;
  if (line.mode === "leads") return entered;
  return rate?.price ? leadsForBudget(entered, rate.price)?.leadCount ?? null : null;
}

export function amountError(line: OrderLine, rate: RateState | undefined): string | null {
  const entered = Number(line.value);
  if (line.mode === "leads") {
    if (!line.value.trim()) return "Choose how many leads you’d like.";
    if (!isValidLeadCount(entered)) return "Enter a whole number of leads.";
    if (entered < MIN_LEAD_QUANTITY) return `The minimum order is ${MIN_LEAD_QUANTITY} leads per state.`;
    if (entered > MAX_LEAD_QUANTITY) return `Choose up to ${MAX_LEAD_QUANTITY.toLocaleString("en-US")} leads for this state.`;
    return null;
  }
  if (!line.value.trim()) return "Enter your lead budget.";
  if (!Number.isSafeInteger(entered) || entered < 1) return "Enter your budget in whole dollars.";
  if (!rate?.price) return null; // The state error explains what's missing.
  const count = leadCountFor(line, rate) ?? 0;
  if (count < MIN_LEAD_QUANTITY) return `The minimum is ${MIN_LEAD_QUANTITY} leads — ${formatAmount(MIN_LEAD_QUANTITY * rate.price)} for ${rate.name}.`;
  if (count > MAX_LEAD_QUANTITY) return `That budget covers more than ${MAX_LEAD_QUANTITY.toLocaleString("en-US")} leads. The most for ${rate.name} is ${formatAmount(MAX_LEAD_QUANTITY * rate.price)}.`;
  return null;
}

export function stateErrorFor(line: OrderLine, rate: RateState | undefined): string | null {
  if (!line.state || !rate) return "Choose a state to see your price.";
  if (rate.price === null) return `${rate.name} is sold out. Please choose another state or remove it.`;
  return null;
}

/** The value to show after switching a line between leads and budget, keeping the same order where it can. */
export function convertedValue(line: OrderLine, rate: RateState | undefined, mode: OrderMode): string {
  const count = leadCountFor(line, rate);
  if (mode === "budget" && count && rate?.price) return String(Math.ceil(count * rate.price));
  if (mode === "leads" && count) return String(count);
  return "";
}

export const leadsLabel = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "lead" : "leads"}`;
