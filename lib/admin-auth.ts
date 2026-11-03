import { authConfigured, getAuthConfig, readAdminSession } from "@/lib/admin-session";

export { authConfigured } from "@/lib/admin-session";
export type AdminAccess = { status: "authorized"; username: string } | { status: "unauthenticated" | "forbidden" | "unavailable" };

export async function getAdminAccess(cookieHeader: string | null): Promise<AdminAccess> {
  if (!authConfigured()) return { status: "unavailable" };
  const session = await readAdminSession(cookieHeader);
  if (!session) return { status: "unauthenticated" };
  return { status: "authorized", username: session.username };
}

export async function requireAdmin(request: Request): Promise<Response | null> {
  const access = await getAdminAccess(request.headers.get("cookie"));
  if (access.status === "authorized") return null;
  const status = access.status === "unauthenticated" ? 401 : access.status === "forbidden" ? 403 : 503;
  const error = access.status === "unauthenticated" ? "Sign in to access admin." : access.status === "forbidden" ?
    "Admin access is not allowed." : "Admin access is temporarily unavailable. Please try again.";
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
