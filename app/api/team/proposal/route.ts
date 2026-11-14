import { randomBytes } from "node:crypto";
import { WhopClient } from "@whop/sdk";
import { getAuthConfig } from "@/lib/admin-session";
import { proposalPayload, readProposalResult, retirePlanIds, TEAM_LINK_SOURCE, teamRepNames, validateClient, validateRep } from "@/lib/team-proposal";
import { acceptTeamRequest, failure, noStore, priceTeamOrder, teamErrorResponse } from "@/lib/team-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The workflow creates two Whop links, updates GHL and sends the document before it answers.
export const maxDuration = 120;
const AUTOMATION_TIMEOUT_MS = 100_000;

function webhookUrl(): URL | null {
  try {
    const url = new URL(process.env.N8N_PROPOSAL_WEBHOOK_URL || "");
    const local = process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    return (url.protocol === "https:" || local) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** Only links this site generated for the team, on this Whop account, are passed on to be retired. */
async function verifiedRetireIds(ids: string[], token: string | undefined, accountId: string | undefined): Promise<string[]> {
  if (!ids.length || !token || !accountId) return [];
  const whop = new WhopClient({ token });
  const checked = await Promise.all(ids.map(async (id) => {
    try {
      const plan = await whop.plans.retrieve({ id }) as { id?: string; account?: { id?: string } | null; company?: { id?: string } | null; metadata?: Record<string, unknown> | null };
      const owner = plan.account?.id ?? plan.company?.id;
      return plan.id === id && owner === accountId && plan.metadata?.source === TEAM_LINK_SOURCE ? id : null;
    } catch { return null; }
  }));
  return checked.filter((id): id is string => Boolean(id));
}

/**
 * POST /api/team/proposal — sends a proposal through the n8n → GoHighLevel automation:
 * `{ items: [{ state, quantity }], priceVersion, rep, client: { firstName, lastName, email, phone, firm }, retirePlanIds? }`.
 * The site prices the order; the workflow creates the card and wire links, saves them on
 * the GHL contact, sends the proposal document and answers with the links.
 */
export async function POST(request: Request) {
  const accepted = await acceptTeamRequest(request);
  if (accepted instanceof Response) return accepted;
  const { body, user } = accepted;
  let rep, client, retire;
  try {
    rep = validateRep(body.rep, teamRepNames());
    client = validateClient(body.client);
    retire = retirePlanIds(body.retirePlanIds);
  } catch (error) { return teamErrorResponse(error, "Check the proposal details and try again.", 400); }

  const url = webhookUrl();
  const secret = process.env.N8N_PROPOSAL_WEBHOOK_SECRET;
  if (!url || !secret || secret.length < 16) {
    return failure("Proposal sending isn’t connected yet. Ask an admin to add the n8n proposal webhook to the site settings.", 503);
  }

  const priced = await priceTeamOrder(body, ["bank", "card"]);
  if (priced instanceof Response) return priced;
  const [bank, card] = priced.quotes;
  let siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  try { siteOrigin = getAuthConfig().siteOrigin; } catch { /* Sign-in already succeeded; keep the configured URL. */ }

  const proposalId = `prop_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
  const payload = proposalPayload({
    proposalId, createdAt: new Date().toISOString(), rep, signedIn: user, client, bank, card, priceVersion: priced.card.version,
    retirePlanIds: await verifiedRetireIds(retire, process.env.WHOP_API_KEY, process.env.WHOP_ACCOUNT_ID), siteOrigin,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(AUTOMATION_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Loudr-Secret": secret, "Idempotency-Key": proposalId },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error("Proposal automation request failed", { proposalId, timedOut });
    return failure(timedOut
      ? "The automation didn’t answer in time. Check the contact in GHL before sending again — the proposal may already have gone out."
      : "We couldn’t reach the proposal automation. Please try again.", 504, { proposalId });
  }
  let reply: unknown = null;
  try { reply = JSON.parse((await response.text()).slice(0, 20_000)); } catch { /* Not JSON: handled below. */ }
  const result = readProposalResult(reply, client.email);
  if (!response.ok || !result.sent) {
    const error = !result.sent ? result.error : "The automation didn’t confirm the proposal was sent.";
    console.error("Proposal automation did not confirm sending", { proposalId, status: response.status });
    return failure(`${error} Check n8n and GHL before trying again.`, 502, { proposalId });
  }
  return Response.json({ ...result, proposalId, retiredPlanIds: payload.retire_plan_ids }, { headers: noStore });
}
