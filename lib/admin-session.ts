import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { findTeamMember } from "@/lib/whop-team";

const SESSION_SECONDS = 8 * 60 * 60;
const FLOW_SECONDS = 10 * 60;
const TIMEOUT_MS = 10_000;
const WHOP_OAUTH = "https://api.whop.com/oauth";
const SESSION_AUDIENCE = "loudr-admin-session";
const FLOW_AUDIENCE = "loudr-admin-oauth";
const USER_ID = /^user_[A-Za-z0-9]+$/;

export type AuthConfig = {
  siteOrigin: string; businessId: string; clientId: string; clientSecret: string | null; apiKey: string;
  redirectUri: string; authVersion: string; key: Uint8Array; secure: boolean; sessionCookie: string; flowCookie: string;
};
export type AdminSession = { userId: string; name: string | null };

export function getAuthConfig(): AuthConfig {
  const businessId = process.env.WHOP_ACCOUNT_ID;
  const clientId = process.env.WHOP_OAUTH_CLIENT_ID;
  const clientSecret = process.env.WHOP_OAUTH_CLIENT_SECRET || null;
  const apiKey = process.env.WHOP_API_KEY;
  const secret = process.env.ADMIN_SESSION_SECRET;
  const site = new URL(process.env.NEXT_PUBLIC_SITE_URL || "");
  const secure = site.protocol === "https:";
  const local = process.env.NODE_ENV !== "production" && site.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
  if ((!secure && !local) || site.username || site.password || site.pathname !== "/" || site.search || site.hash ||
    !businessId || !/^biz_[a-zA-Z0-9]+$/.test(businessId) || !clientId || !/^app_[a-zA-Z0-9]+$/.test(clientId) ||
    !apiKey || !secret || Buffer.byteLength(secret) < 32) {
    throw new Error("Admin sign-in is not configured.");
  }
  return {
    siteOrigin: site.origin, businessId, clientId, clientSecret, apiKey, secure,
    redirectUri: `${site.origin}/api/auth/whop/callback`,
    key: createHash("sha256").update(secret).digest(),
    // Changing the OAuth app or business invalidates every existing session.
    authVersion: createHash("sha256").update(`whop-oauth-v1\0${clientId}\0${businessId}`).digest("hex"),
    sessionCookie: `${secure ? "__Host-" : ""}loudr-admin-session`,
    flowCookie: `${secure ? "__Host-" : ""}loudr-admin-oauth`,
  };
}

export function authConfigured(): boolean {
  try { getAuthConfig(); return true; } catch { return false; }
}

function cookie(config: AuthConfig, name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${config.secure ? "; Secure" : ""}`;
}

function readCookie(header: string | null, name: string): string | null {
  const matches = (header ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return value && value.length <= 8192 ? value : null;
}

async function encrypt(config: AuthConfig, claims: Record<string, unknown>, audience: string, seconds: number): Promise<string> {
  return new EncryptJWT(claims).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setIssuedAt().setIssuer(config.siteOrigin)
    .setAudience(audience).setExpirationTime(`${seconds}s`).encrypt(config.key);
}

async function decrypt(config: AuthConfig, value: string, audience: string, seconds: number) {
  const { payload } = await jwtDecrypt(value, config.key, {
    issuer: config.siteOrigin, audience, keyManagementAlgorithms: ["dir"],
    contentEncryptionAlgorithms: ["A256GCM"], requiredClaims: ["iat", "exp"], maxTokenAge: seconds,
  });
  return payload;
}

export async function createSessionCookie(session: AdminSession): Promise<string> {
  const config = getAuthConfig();
  const value = await encrypt(config, {
    sub: session.userId, name: session.name, business_id: config.businessId, auth_version: config.authVersion,
  }, SESSION_AUDIENCE, SESSION_SECONDS);
  return cookie(config, config.sessionCookie, value, SESSION_SECONDS);
}

export async function readAdminSession(header: string | null): Promise<AdminSession | null> {
  const config = getAuthConfig();
  const value = readCookie(header, config.sessionCookie);
  if (!value) return null;
  try {
    const payload = await decrypt(config, value, SESSION_AUDIENCE, SESSION_SECONDS);
    if (payload.business_id !== config.businessId || payload.auth_version !== config.authVersion ||
      typeof payload.sub !== "string" || !USER_ID.test(payload.sub)) return null;
    return { userId: payload.sub, name: typeof payload.name === "string" ? payload.name : null };
  } catch { return null; }
}

function redirect(url: string, ...cookies: string[]): Response {
  const response = new Response(null, { status: 303, headers: {
    Location: url, "Cache-Control": "no-store, private", Pragma: "no-cache", "Referrer-Policy": "no-referrer",
  } });
  for (const value of cookies) response.headers.append("Set-Cookie", value);
  return response;
}

function unavailable(): Response {
  return new Response("Admin sign-in is temporarily unavailable.", {
    status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

function forbidden(): Response {
  return Response.json({ error: "Use this site's admin sign-in page." }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

// Next/Vercel can normalize request.url to an internal host. The browser's
// Origin must match our configured public origin; forwarded hosts are ignored.
function sameOrigin(request: Request, config: AuthConfig): boolean {
  return request.headers.get("origin") === config.siteOrigin;
}

function sha256Base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** POST /api/auth/whop/start — begins Whop OAuth 2.1 + PKCE sign-in. */
export async function handleStart(request: Request): Promise<Response> {
  let config: AuthConfig;
  try { config = getAuthConfig(); } catch { return unavailable(); }
  if (!sameOrigin(request, config)) return forbidden();
  try {
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    // Whop rejects an `openid` authorization request that carries no nonce.
    const nonce = randomBytes(24).toString("base64url");
    const flow = await encrypt(config, { state, verifier }, FLOW_AUDIENCE, FLOW_SECONDS);
    const params = new URLSearchParams({
      response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: "openid profile",
      state, nonce, code_challenge: sha256Base64url(verifier), code_challenge_method: "S256",
    });
    return redirect(`${WHOP_OAUTH}/authorize?${params}`, cookie(config, config.flowCookie, flow, FLOW_SECONDS));
  } catch { return unavailable(); }
}

function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

async function exchangeCode(config: AuthConfig, code: string, verifier: string): Promise<{ accessToken: string; refreshToken: string | null }> {
  const response = await fetch(`${WHOP_OAUTH}/token`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      grant_type: "authorization_code", code, redirect_uri: config.redirectUri, client_id: config.clientId,
      code_verifier: verifier, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Whop token exchange failed with HTTP ${response.status}.`);
  const tokens = await response.json() as { access_token?: unknown; refresh_token?: unknown };
  if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("Whop returned no access token.");
  return { accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null };
}

async function fetchUserId(accessToken: string): Promise<string> {
  const response = await fetch(`${WHOP_OAUTH}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Whop userinfo failed with HTTP ${response.status}.`);
  const info = await response.json() as { sub?: unknown };
  if (typeof info.sub !== "string" || !USER_ID.test(info.sub)) throw new Error("Whop returned an invalid user.");
  return info.sub;
}

async function revoke(config: AuthConfig, token: string | null): Promise<void> {
  // The site only needs the user's identity once; it never keeps Whop tokens.
  if (!token) return;
  try {
    await fetch(`${WHOP_OAUTH}/revoke`, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ token, client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) }),
    });
  } catch { /* Best effort: an unrevoked refresh token is never stored by this site. */ }
}

/** GET /api/auth/whop/callback — verifies the OAuth result and Loudr Media team membership. */
export async function handleCallback(request: Request): Promise<Response> {
  let config: AuthConfig;
  try { config = getAuthConfig(); } catch { return unavailable(); }
  const clearFlow = cookie(config, config.flowCookie, "", 0);
  const fail = (error: string) => redirect(`${config.siteOrigin}/admin/login?error=${error}`, clearFlow);
  const params = new URL(request.url).searchParams;
  const flowValue = readCookie(request.headers.get("cookie"), config.flowCookie);
  if (!flowValue) return fail("sign_in_expired");
  let flow: { state: string; verifier: string };
  try {
    const payload = await decrypt(config, flowValue, FLOW_AUDIENCE, FLOW_SECONDS);
    if (typeof payload.state !== "string" || typeof payload.verifier !== "string") return fail("sign_in_expired");
    flow = { state: payload.state, verifier: payload.verifier };
  } catch { return fail("sign_in_expired"); }
  const returnedState = params.get("state");
  if (!returnedState || params.getAll("state").length !== 1 || !sameSecret(returnedState, flow.state)) return fail("sign_in_expired");
  const whopError = params.get("error");
  if (whopError) {
    // Only an explicit refusal is a cancellation; anything else is a request or configuration error.
    console.warn("Whop OAuth returned an error", { error: whopError.slice(0, 64), description: (params.get("error_description") ?? "").slice(0, 300) });
    return fail(whopError === "access_denied" ? "whop_denied" : "sign_in_failed");
  }
  const code = params.get("code");
  if (!code || code.length > 2048 || params.getAll("code").length !== 1) return fail("sign_in_failed");

  let userId: string;
  try {
    const tokens = await exchangeCode(config, code, flow.verifier);
    try { userId = await fetchUserId(tokens.accessToken); }
    finally { await revoke(config, tokens.refreshToken); }
  } catch { return fail("sign_in_failed"); }

  let member;
  try { member = await findTeamMember(config.apiKey, config.businessId, userId); }
  catch { return fail("unavailable"); }
  if (!member) return fail("not_team_member");
  try {
    return redirect(`${config.siteOrigin}/admin`, clearFlow, await createSessionCookie({ userId, name: member.name ?? member.username }));
  } catch { return fail("unavailable"); }
}

/** POST /api/auth/logout */
export async function handleLogout(request: Request): Promise<Response> {
  let config: AuthConfig;
  try { config = getAuthConfig(); } catch { return unavailable(); }
  if (!sameOrigin(request, config)) return forbidden();
  return redirect(`${config.siteOrigin}/admin/login`, cookie(config, config.sessionCookie, "", 0));
}
