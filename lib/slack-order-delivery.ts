import { get, put } from "@vercel/blob";
import type { slackOrderMessage } from "@/lib/paid-lead-order";

export async function deliverSlackOrder(paymentId: string, message: ReturnType<typeof slackOrderMessage>) {
  if (!/^pay_[a-zA-Z0-9]+$/.test(paymentId)) throw new Error("Invalid payment ID.");
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) throw new Error("Notification storage unavailable.");
  const url = new URL(process.env.SLACK_LEAD_ORDERS_WEBHOOK_URL || "");
  if (url.protocol !== "https:" || !["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) ||
    !url.pathname.startsWith("/services/") || url.username || url.password || url.port || url.search || url.hash) throw new Error("Invalid Slack webhook.");
  const path = `notifications/slack/${paymentId}.json`;
  const existing = await get(path, { access: "private", useCache: false, abortSignal: AbortSignal.timeout(5000) });
  if (existing) {
    if (existing.statusCode !== 200 || existing.blob.size > 2048 || !existing.blob.etag) throw new Error("Invalid receipt.");
    const receipt = JSON.parse(await new Response(existing.stream).text());
    if (receipt.paymentId !== paymentId || !["sending", "sent"].includes(receipt.status) || !Number.isFinite(receipt.updatedAt)) throw new Error("Invalid receipt.");
    if (receipt.status === "sent") return "duplicate";
    if (Date.now() - receipt.updatedAt < 120_000) throw new Error("Delivery in progress.");
  }
  // CAS prevents concurrent posts. Ambiguous Slack responses can still cause a
  // duplicate on retry: incoming webhooks offer no transactional idempotency.
  const claim = await put(path, JSON.stringify({ paymentId, status: "sending", updatedAt: Date.now() }), {
    access: "private", addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60,
    ...(existing ? { allowOverwrite: true, ifMatch: existing.blob.etag } : { allowOverwrite: false }),
    abortSignal: AbortSignal.timeout(5000),
  });
  if (!claim.etag) throw new Error("Unconfirmed notification claim.");
  const response = await fetch(url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message), signal: AbortSignal.timeout(10_000) });
  if (!response.ok || (await response.text()).trim() !== "ok") throw new Error("Slack did not accept notification.");
  await put(path, JSON.stringify({ paymentId, status: "sent", updatedAt: Date.now() }), {
    access: "private", addRandomSuffix: false, allowOverwrite: true, ifMatch: claim.etag,
    contentType: "application/json", cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(5000),
  });
  return "sent";
}
