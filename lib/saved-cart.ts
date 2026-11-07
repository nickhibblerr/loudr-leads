import { MAX_CART_STATES } from "@/lib/lead-cart";
import { isValidLeadState } from "@/lib/lead-pricing";

/** A buyer's in-progress order, kept only in their own browser for their next visit. */
export type SavedCartLine = { state: string; quantity: string };

const KEY = "loudr-leads-cart-v1";

export function readSavedCart(): SavedCartLine[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.slice(0, MAX_CART_STATES).flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const { state, quantity } = item as Record<string, unknown>;
      if (!isValidLeadState(state) || seen.has(state)) return [];
      seen.add(state);
      return [{ state, quantity: typeof quantity === "string" && /^\d{0,6}$/.test(quantity) ? quantity : "" }];
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
