const WHOP_API = "https://api.whop.com/api/v1";
const TIMEOUT_MS = 10_000;
// Whop documents Partner as a view-only role; it must not be able to edit prices.
const EXCLUDED_ROLES = new Set(["partner"]);

export type TeamMember = { userId: string; role: string; name: string | null; username: string | null };

type ApiTeamMember = {
  account_id?: unknown; status?: unknown; role?: unknown; is_agent?: unknown;
  user?: { id?: unknown; name?: unknown; username?: unknown } | null;
};

/**
 * Returns the user's joined team membership on the business, or null when they are
 * not an eligible team member. Throws when Whop cannot answer, so callers fail closed.
 * Pending invites, agents and the view-only Partner role are never eligible.
 */
export async function findTeamMember(apiKey: string, businessId: string, userId: string): Promise<TeamMember | null> {
  const params = new URLSearchParams({ account_id: businessId, user_id: userId, status: "joined", first: "10" });
  const response = await fetch(`${WHOP_API}/team_members?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Whop team lookup failed with HTTP ${response.status}.`);
  const body = await response.json() as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Whop team lookup returned an unexpected response.");
  for (const member of body.data as ApiTeamMember[]) {
    if (member?.account_id !== businessId || member.status !== "joined" || member.is_agent !== false ||
      typeof member.role !== "string" || EXCLUDED_ROLES.has(member.role) || member.user?.id !== userId) continue;
    return {
      userId, role: member.role,
      name: typeof member.user.name === "string" ? member.user.name : null,
      username: typeof member.user.username === "string" ? member.user.username : null,
    };
  }
  return null;
}
