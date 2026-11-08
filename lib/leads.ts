/** Named lead packages shown as quick picks. Buyers can still type any quantity (minimum 50). */
export const LEAD_TIERS = [
  { count: 50, name: "Starter", note: "Test batch" },
  { count: 100, name: "Optimal", note: "Recommended" },
  { count: 200, name: "Scale", note: "Best results" },
] as const;
export const LEAD_PRESETS = LEAD_TIERS.map((tier) => tier.count);
/** Order size at which clients typically sign more cases and see better results. */
export const SCALE_THRESHOLD = 200;
/** Quick budgets in whole dollars of lead spend (before any card fee). */
export const BUDGET_PRESETS = [10_000, 25_000, 50_000, 75_000, 100_000] as const;
/** How a buyer sets a state's order: by lead count or by a lead-spend budget. */
export type OrderMode = "leads" | "budget";

export function isValidLeadCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export type LeadGuidance = { tier: "starter" | "optimal" | "scale"; tone: "amber" | "lime" | "green"; title: string; description: string };

/** Guidance for a state's lead count. Orders below the 50-lead minimum get none. */
export function leadGuidance(count: number): LeadGuidance | null {
  if (!isValidLeadCount(count) || count < 50) return null;
  if (count >= SCALE_THRESHOLD) return { tier: "scale", tone: "green", title: "Built to scale",
    description: "Our clients typically sign more cases and see better results at 200+ leads." };
  if (count >= 100) return { tier: "optimal", tone: "lime", title: "Optimal volume",
    description: "Enough leads to run a steady follow-up rhythm and learn what converts. Clients see the strongest results at 200+." };
  return { tier: "starter", tone: "amber", title: "Starter batch",
    description: "A good way to test leads in this state. Clients typically sign more cases once they scale to 200+." };
}
