import { MAX_CART_STATES } from "@/lib/lead-cart";
import { isValidLeadState } from "@/lib/lead-pricing";
import type { OrderMode } from "@/lib/leads";

/**
 * A buyer's in-progress order, kept only in their own browser for their next visit.
 * `value` is a lead count, or whole dollars of lead spend when `mode` is "budget".
 */
export type SavedCartLine = { state: string; value: string; mode: OrderMode };

const KEY = "loudr-leads-cart-v1";

export function readSavedCart(): SavedCartLine[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.slice(0, MAX_CART_STATES).flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      // Orders saved before budgets existed stored `quantity` (a lead count).
      const { state, quantity, value: saved, mode } = item as Record<string, unknown>;
      if (!isValidLeadState(state) || seen.has(state)) return [];
      seen.add(state);
      const value = saved ?? quantity;
      return [{ state, mode: mode === "budget" ? "budget" : "leads", value: typeof value === "string" && /^\d{0,8}$/.test(value) ? value : "" }];
    });
  } catch {
    return [];
  }
}

export function writeSavedCart(lines: SavedCartLine[]) {
  try {
    const kept = lines.filter((line) => line.state);
    if (kept.length) window.localStorage.setItem(KEY, JSON.stringify(kept));
    else window.localStorage.removeItem(KEY);
  } catch { /* Storage can be unavailable (private mode); the order still works. */ }
}

export function clearSavedCart() {
  try { window.localStorage.removeItem(KEY); } catch { /* Nothing to clear. */ }
}
