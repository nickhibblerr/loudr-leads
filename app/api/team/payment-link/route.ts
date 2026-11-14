import { randomBytes } from "node:crypto";
import { WhopClient } from "@whop/sdk";
import { requestedPaymentMode } from "@/lib/payment-methods";
import { checkPaymentLink, optionalClient, orderText, paymentLinkRequest, teamRepNames, TeamRequestError, money } from "@/lib/team-proposal";
import { acceptTeamRequest, failure, noStore, priceTeamOrder, teamErrorResponse } from "@/lib/team-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/team/payment-link — a shareable Whop checkout link for exactly this order:
 * `{ items: [{ state, quantity }], paymentMode: "bank" | "card", priceVersion, rep?, client? }`.
 */
export async function POST(request: Request) {
  const accepted = await acceptTeamRequest(request);
  if (accepted instanceof Response) return accepted;
  const { body, user } = accepted;
  let paymentMode;
  try { paymentMode = requestedPaymentMode(body.paymentMode); }
  catch (error) { return failure(error instanceof Error ? error.message : "Choose Wire or Card.", 400); }
  const reps = teamRepNames();
  const rep = typeof body.rep === "string" && reps.includes(body.rep) ? body.rep : null;
  if (body.rep !== undefined && body.rep !== "" && !rep) return teamErrorResponse(new TeamRequestError("Choose your name from the rep list."), "");

  const priced = await priceTeamOrder(body, [paymentMode]);
  if (priced instanceof Response) return priced;
  const [cart] = priced.quotes;

  const token = process.env.WHOP_API_KEY;
  const accountId = process.env.WHOP_ACCOUNT_ID;
  const linkId = `link_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  if (!token || !accountId) {
    // Local testing without a Whop key (see LOCAL_DEV_SIGN_IN): return an obviously fake link.
    if (process.env.NODE_ENV !== "production" && !process.env.VERCEL && process.env.LOCAL_DEV_SIGN_IN === "1") {
      const planId = `plan_LOCALMOCK${randomBytes(4).toString("hex")}`;
      return Response.json({ linkId, url: `https://whop.com/checkout/${planId}`, planId, paymentMode: cart.paymentMode, cart, priceVersion: priced.card.version,
        summary: { ...orderText(cart), total: money(cart.total) }, createdAt: new Date().toISOString(), mock: true }, { headers: noStore });
    }
    return failure("Payment links are temporarily unavailable. Please try again later.", 503);
  }
  try {
    const whop = new WhopClient({ token });
    const result = await whop.checkoutConfigurations.create(
      paymentLinkRequest(cart, { accountId, linkId, rep, createdBy: user.name ?? user.userId, client: optionalClient(body.client) }) as never,
      { idempotencyKey: `loudr-team-${linkId}` },
    );
    const link = checkPaymentLink(result as never, cart);
    const summary = orderText(cart);
    return Response.json({
      linkId, url: link.url, planId: link.planId, paymentMode: cart.paymentMode, cart, priceVersion: priced.card.version,
      summary: { ...summary, total: money(cart.total) }, createdAt: new Date().toISOString(),
    }, { headers: noStore });
  } catch (error) {
    console.error("Team payment link could not be created", { message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return teamErrorResponse(error, "Whop couldn’t create the payment link. Please try again.");
  }
}
