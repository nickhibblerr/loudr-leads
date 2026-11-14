import { checkMutationOrigin, getAdminAccess, requireAdmin } from "@/lib/admin-auth";
import { calculateCartQuote, requestedCartItems, type CartQuote } from "@/lib/lead-cart";
import type { PaymentMode } from "@/lib/payment-methods";
import { readRateCard } from "@/lib/pricing-store";
import type { RateCard } from "@/lib/rate-card";
import { TeamRequestError } from "@/lib/team-proposal";

const MAX_BODY_LENGTH = 16_384;
export const noStore = { "Cache-Control": "no-store" };

export function failure(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status, headers: noStore });
}

type Accepted = { body: Record<string, unknown>; user: { userId: string; name: string | null } };

/** Signed-in team member, same-origin JSON request, size-limited body. */
export async function acceptTeamRequest(request: Request): Promise<Accepted | Response> {
  const denied = await requireAdmin(request, "team tools");
  if (denied) return denied;
  const wrongOrigin = checkMutationOrigin(request, "Use this site's Team page to make payment links and proposals.");
  if (wrongOrigin) return wrongOrigin;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_LENGTH) return failure("That request is too large.", 413);
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_LENGTH) return failure("That request is too large.", 413);
    body = JSON.parse(text);
  } catch { return failure("Send a valid JSON request.", 400); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return failure("Send a valid JSON request.", 400);
  const access = await getAdminAccess(request.headers.get("cookie"));
  if (access.status !== "authorized") return failure("Sign in to access team tools.", 401);
  return { body: body as Record<string, unknown>, user: { userId: access.userId, name: access.name } };
}

/** Prices the order from the saved rate card. A stale page gets the current card back (409). */
export async function priceTeamOrder(body: Record<string, unknown>, modes: PaymentMode[]): Promise<{ card: RateCard; quotes: CartQuote[] } | Response> {
  let card: RateCard;
  try { card = await readRateCard(); }
  catch { return failure("Pricing is temporarily unavailable. Please try again.", 503); }
  if (body.priceVersion !== undefined && body.priceVersion !== card.version) {
    return failure("Prices have changed. Review the updated totals and try again.", 409, { rateCard: card });
  }
  try {
    const items = requestedCartItems({ items: body.items });
    return { card, quotes: modes.map((mode) => calculateCartQuote(items, card.states, mode)) };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Invalid lead order.", 400);
  }
}

export function teamErrorResponse(error: unknown, fallback: string, status = 502): Response {
  if (error instanceof TeamRequestError) return failure(error.message, error.status);
  return failure(fallback, status);
}
