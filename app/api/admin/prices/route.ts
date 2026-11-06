import { requireAdmin, checkMutationOrigin } from "@/lib/admin-auth";
import { PricingError, readRateCard, saveRateChanges } from "@/lib/pricing-store";
import { MAX_PRICING_BODY_LENGTH, type RateCard } from "@/lib/rate-card";
import { WhopClient } from "@whop/sdk";
import { syncLeadPlanPrices } from "@/lib/lead-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

function failure(error: unknown): Response {
  return Response.json({ error: error instanceof PricingError ? error.message : "Prices are temporarily unavailable." }, {
    status: error instanceof PricingError ? error.status : 503, headers,
  });
}

export async function GET(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return Response.json(await readRateCard(), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const wrongOrigin = checkMutationOrigin(request);
  if (wrongOrigin) return wrongOrigin;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Send prices as JSON." }, { status: 415, headers });
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_PRICING_BODY_LENGTH) return Response.json({ error: "Price changes are too large." }, { status: 413, headers });
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_PRICING_BODY_LENGTH) return Response.json({ error: "Price changes are too large." }, { status: 413, headers });
    input = JSON.parse(text);
  } catch {
    return Response.json({ error: "Send a valid JSON price update." }, { status: 400, headers });
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Response.json({ error: "Send a price version and the state changes." }, { status: 400, headers });
  }
  try {
    const body = input as Record<string, unknown>;
    const card = await saveRateChanges(body.version, body.changes);
    return Response.json({ ...card, whopPlansSynced: await syncWhopPrices(card) }, { headers });
  } catch (error) {
    return failure(error);
  }
}

// Saved prices are the source of truth. Repricing the Whop plans keeps the product's plans
// in step; if Whop is unreachable, checkout reprices each state's plan on its next order.
async function syncWhopPrices(card: RateCard): Promise<boolean> {
  try {
    const token = process.env.WHOP_API_KEY;
    const accountId = process.env.WHOP_ACCOUNT_ID;
    const productId = process.env.WHOP_LEADS_PRODUCT_ID;
    if (!token || !accountId || !productId) return false;
    await syncLeadPlanPrices(new WhopClient({ token }), accountId, productId, card.states);
    return true;
  } catch (error) {
    console.error("Whop lead plan prices could not be synced", { message: error instanceof Error ? error.message : "unknown" });
    return false;
  }
}
