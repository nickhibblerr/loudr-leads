import { createHash, scrypt, timingSafeEqual } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { enforceLoginRateLimit } from "@/lib/admin-login-throttle";

const SESSION_SECONDS = 8 * 60 * 60;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const BODY_LIMIT = 4096;

export type AuthConfig = {
  siteOrigin: string; username: string; businessId: string; passwordSalt: Uint8Array; passwordHash: Uint8Array;
  credentialVersion: string; key: Uint8Array; secure: boolean; sessionCookie: string;
};
export type AdminSession = { username: string };

export function getAuthConfig(): AuthConfig {
  const username = process.env.ADMIN_USERNAME;
  const encodedHash = process.env.ADMIN_PASSWORD_HASH;
  const businessId = process.env.WHOP_ACCOUNT_ID;
  const secret = process.env.ADMIN_SESSION_SECRET;
  const site = new URL(process.env.NEXT_PUBLIC_SITE_URL || "");
  const secure = site.protocol === "https:";
  const local = process.env.NODE_ENV !== "production" && site.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
  const hashParts = encodedHash?.match(/^scrypt\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/);
  if ((!secure && !local) || site.username || site.password || site.pathname !== "/" || site.search || site.hash ||
    !username || username.trim() !== username || username.length > 128 || !hashParts ||
    !businessId || !/^biz_[a-zA-Z0-9]+$/.test(businessId) || !secret || Buffer.byteLength(secret) < 32) {
    throw new Error("Admin sign-in is not configured.");
  }
  const passwordSalt = Buffer.from(hashParts[1], "base64url");
  const passwordHash = Buffer.from(hashParts[2], "base64url");
  if (passwordSalt.length !== 16 || passwordHash.length !== 64 || passwordSalt.toString("base64url") !== hashParts[1] ||
    passwordHash.toString("base64url") !== hashParts[2]) throw new Error("Invalid admin credential configuration.");
  return {
    siteOrigin: site.origin, username, businessId, passwordSalt, passwordHash, secure,
    key: createHash("sha256").update(secret).digest(),
    credentialVersion: createHash("sha256").update(`${username}\0${encodedHash}`).digest("hex"),
    sessionCookie: `${secure ? "__Host-" : ""}loudr-admin-session`,
  };
}

export function authConfigured(): boolean {
  try { getAuthConfig(); return true; } catch { return false; }
}

function cookie(config: AuthConfig, value: string, maxAge: number): string {
  return `${config.sessionCookie}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${config.secure ? "; Secure" : ""}`;
}

export async function createSessionCookie(): Promise<string> {
  const config = getAuthConfig();
  const value = await new EncryptJWT({ username: config.username, business_id: config.businessId, credential_version: config.credentialVersion })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setIssuedAt().setIssuer(config.siteOrigin)
    .setAudience("loudr-admin-session").setExpirationTime(`${SESSION_SECONDS}s`).encrypt(config.key);
  return cookie(config, value, SESSION_SECONDS);
}

export async function readAdminSession(header: string | null): Promise<AdminSession | null> {
  const config = getAuthConfig();
  const cookies = (header ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${config.sessionCookie}=`));
  if (cookies.length !== 1) return null;
  const value = cookies[0].slice(config.sessionCookie.length + 1);
  if (!value || value.length > 8192) return null;
  try {
    const { payload } = await jwtDecrypt(value, config.key, {
      issuer: config.siteOrigin, audience: "loudr-admin-session", keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"], requiredClaims: ["iat", "exp"], maxTokenAge: SESSION_SECONDS,
    });
    if (payload.username !== config.username || payload.business_id !== config.businessId || payload.credential_version !== config.credentialVersion) return null;
    return { username: config.username };
  } catch { return null; }
}

function redirect(url: string): Response {
  return new Response(null, { status: 303, headers: {
    Location: url, "Cache-Control": "no-store, private", Pragma: "no-cache", "Referrer-Policy": "no-referrer",
  } });
}

function unavailable(): Response {
  return new Response("Admin sign-in is temporarily unavailable.", {
    status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

function sameOrigin(request: Request, config: AuthConfig): boolean {
  // Next/Vercel can normalize request.url to an internal host. The browser's
  // Origin must match our configured public origin; forwarded hosts are ignored.
  return request.headers.get("origin") === config.siteOrigin;
}

function forbidden(): Response {
  return Response.json({ error: "Use this site's admin sign-in page." }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

async function readForm(request: Request): Promise<URLSearchParams> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded" ||
    Number(request.headers.get("content-length") || 0) > BODY_LIMIT || !request.body) throw new Error("Invalid login form.");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) { await reader.cancel(); throw new Error("Login form is too large."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return new URLSearchParams(Buffer.concat(parts).toString("utf8"));
}

async function verifyCredentials(config: AuthConfig, username: string, password: string): Promise<boolean> {
  const suppliedHash = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, config.passwordSalt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
  // Always derive the password hash, even for a wrong username. Fixed-size hashes
  // keep both comparisons constant-time and never expose which field was wrong.
  const suppliedUser = createHash("sha256").update(username).digest();
  const expectedUser = createHash("sha256").update(config.username).digest();
  const userMatches = timingSafeEqual(suppliedUser, expectedUser);
  const passwordMatches = timingSafeEqual(suppliedHash, config.passwordHash);
  return userMatches && passwordMatches;
}

export async function handleLogin(request: Request): Promise<Response> {
  let config: AuthConfig;
  try { config = getAuthConfig(); } catch { return unavailable(); }
  if (!sameOrigin(request, config)) return forbidden();
  let username: string, password: string;
  try {
    const form = await readForm(request);
    const suppliedUsername = form.get("username")?.trim();
    const suppliedPassword = form.get("password");
    if (!suppliedUsername || suppliedUsername.length > 128 || !suppliedPassword || suppliedPassword.length > 1024 ||
      form.getAll("username").length !== 1 || form.getAll("password").length !== 1) throw new Error("Invalid credentials.");
    username = suppliedUsername;
    password = suppliedPassword;
  } catch { return redirect(`${config.siteOrigin}/admin/login?error=invalid_credentials`); }
  try {
    const limit = await enforceLoginRateLimit(request, config.key);
    if (!limit.allowed) return new Response("Too many sign-in attempts. Try again in a few minutes.", {
      status: 429, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfter))) },
    });
  } catch { return unavailable(); }
  try {
    if (!await verifyCredentials(config, username, password)) return redirect(`${config.siteOrigin}/admin/login?error=invalid_credentials`);
    const response = redirect(`${config.siteOrigin}/admin`);
    response.headers.append("Set-Cookie", await createSessionCookie());
    return response;
  } catch { return unavailable(); }
}

export async function handleLogout(request: Request): Promise<Response> {
  let config: AuthConfig;
  try { config = getAuthConfig(); } catch { return unavailable(); }
  if (!sameOrigin(request, config)) return forbidden();
  const response = redirect(`${config.siteOrigin}/admin/login`);
  response.headers.append("Set-Cookie", cookie(config, "", 0));
  return response;
}
