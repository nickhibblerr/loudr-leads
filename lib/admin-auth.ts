import { authConfigured, getAuthConfig, readAdminSession } from "@/lib/admin-session";
import { findTeamMember } from "@/lib/whop-team";

export { authConfigured } from "@/lib/admin-session";
export type AdminAccess =
  | { status: "authorized"; userId: string; name: string | null }
  | { status: "unauthenticated" | "forbidden" | "unavailable" };

// Team membership is re-verified with Whop at most this often per user, so
// removing someone from the Loudr Media team revokes access within a minute.
const MEMBERSHIP_CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 200;
const membershipCache = new Map<string, { member: boolean; checkedAt: number }>();

async function isTeamMember(apiKey: string, businessId: string, userId: string): Promise<boolean> {
  const cacheKey = `${businessId}\0${userId}`;
  const cached = membershipCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < MEMBERSHIP_CACHE_MS) return cached.member;
  const member = (await findTeamMember(apiKey, businessId, userId)) !== null;
  if (membershipCache.size >= MAX_CACHE_ENTRIES) membershipCache.clear();
  membershipCache.set(cacheKey, { member, checkedAt: Date.now() });
  return member;
}

export async function getAdminAccess(cookieHeader: string | null): Promise<AdminAccess> {
  if (!authConfigured()) return { status: "unavailable" };
  const session = await readAdminSession(cookieHeader);
  if (!session) return { status: "unauthenticated" };
  const { apiKey, businessId } = getAuthConfig();
  try {
    if (!await isTeamMember(apiKey, businessId, session.userId)) return { status: "forbidden" };
  } catch { return { status: "unavailable" }; }
  return { status: "authorized", userId: session.userId, name: session.name };
}

export async function requireAdmin(request: Request): Promise<Response | null> {
  const access = await getAdminAccess(request.headers.get("cookie"));
  if (access.status === "authorized") return null;
  const status = access.status === "unauthenticated" ? 401 : access.status === "forbidden" ? 403 : 503;
  const error = access.status === "unauthenticated" ? "Sign in to access admin." : access.status === "forbidden" ?
    "Only Loudr Media team members can access admin." : "Admin access is temporarily unavailable. Please try again.";
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function checkMutationOrigin(request: Request): Response | null {
  let siteOrigin: string;
  try { siteOrigin = getAuthConfig().siteOrigin; }
  catch { return Response.json({ error: "Admin access is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (origin !== siteOrigin || contentType !== "application/json") {
    return Response.json({ error: "Save prices from this site's admin page." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}
