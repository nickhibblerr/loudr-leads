import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_LOCAL_CLIENTS = 1024;
const MAX_DOCUMENT_BYTES = 1024;
type Counter = { version: 1; windowStart: number; count: number };
type StoredCounter = { counter: Counter; etag: string };
type LimitResult = { allowed: boolean; retryAfter: number };
const localCounters = new Map<string, Counter>();

function unavailable() {
  return Object.assign(new Error("Sign-in is temporarily unavailable. Please try again shortly."), { status: 503 });
}

function clientAddress(request: Request): string {
  for (const header of ["x-vercel-forwarded-for", "x-forwarded-for"]) {
    const candidate = request.headers.get(header)?.split(",", 1)[0].trim();
    if (!candidate || !isIP(candidate)) continue;
    if (isIP(candidate) === 4) return candidate;
    // Equivalent IPv6 spellings must share a counter.
    try { return new URL(`http://[${candidate}]/`).hostname.toLowerCase(); }
    catch { continue; }
  }
  return "unknown";
}

function denied(windowStart: number, now: number): LimitResult {
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)) };
}

function localLimit(pathname: string, now: number): LimitResult {
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  for (const [key, counter] of localCounters) {
    if (counter.windowStart !== windowStart) localCounters.delete(key);
  }
  const previous = localCounters.get(pathname);
  if (previous && previous.count >= MAX_ATTEMPTS) return denied(windowStart, now);
  // Do not evict active counters and accidentally grant a fresh quota.
  if (!previous && localCounters.size >= MAX_LOCAL_CLIENTS) return denied(windowStart, now);
  localCounters.set(pathname, { version: 1, windowStart, count: (previous?.count ?? 0) + 1 });
  return { allowed: true, retryAfter: 0 };
}

async function readCounter(pathname: string, signal: AbortSignal): Promise<StoredCounter | null> {
  const result = await get(pathname, { access: "private", useCache: false, abortSignal: signal });
  if (!result) return null;
  if (result.statusCode !== 200 || !Number.isFinite(result.blob.size) || result.blob.size > MAX_DOCUMENT_BYTES ||
    !result.blob.etag || result.blob.etag.length > 256 || /[\r\n]/.test(result.blob.etag)) throw unavailable();
  const text = await new Response(result.stream).text();
  if (text.length > MAX_DOCUMENT_BYTES) throw unavailable();
  const counter: unknown = JSON.parse(text);
  if (!counter || typeof counter !== "object" || Array.isArray(counter)) throw unavailable();
  const value = counter as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || value.version !== 1 ||
    typeof value.windowStart !== "number" || !Number.isSafeInteger(value.windowStart) || value.windowStart < 0 ||
    value.windowStart % WINDOW_MS !== 0 || value.windowStart > Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS ||
    typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > MAX_ATTEMPTS) throw unavailable();
  return { counter: value as Counter, etag: result.blob.etag };
}

/** Count every sign-in attempt before checking credentials. Production never falls back to process memory. */
export async function enforceLoginRateLimit(request: Request, key: Uint8Array): Promise<LimitResult> {
  try {
    if (!key.byteLength) throw unavailable();
    const hash = createHmac("sha256", key).update(`admin-login:${clientAddress(request)}`).digest("hex");
    const pathname = `auth/login/${hash}.json`;
    if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
      if (process.env.NODE_ENV === "production" || process.env.VERCEL) throw unavailable();
      return localLimit(pathname, Date.now());
    }

    // One deadline also bounds conflict retries, rather than allowing each retry another five seconds.
    const signal = AbortSignal.timeout(5000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readCounter(pathname, signal);
      const now = Date.now();
      const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      const count = current?.counter.windowStart === windowStart ? current.counter.count : 0;
      if (count >= MAX_ATTEMPTS) return denied(windowStart, now);
      const counter: Counter = { version: 1, windowStart, count: count + 1 };
      try {
        const result = await put(pathname, JSON.stringify(counter), {
          access: "private", addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60,
          ...(current ? { allowOverwrite: true, ifMatch: current.etag } : { allowOverwrite: false }),
          abortSignal: signal,
        });
        if (!result.etag) throw unavailable();
        return { allowed: true, retryAfter: 0 };
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) continue;
        // Blob reports an initial pathname collision as a general error. Only
        // retry it when an uncached read confirms another request created it.
        if (!current && await readCounter(pathname, signal)) continue;
        throw unavailable();
      }
    }
    throw unavailable();
  } catch {
    throw unavailable();
  }
}
