import { get, put } from "@vercel/blob";
import type { paidLeadOrder } from "@/lib/paid-lead-order";

export async function recordPaidOrder(order: ReturnType<typeof paidLeadOrder>) {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) throw new Error("Order storage unavailable.");
  const path = `orders/paid/${order.paymentId}.json`;
  const content = JSON.stringify({ version: 1, ...order });
  try {
    await put(path, content, { access: "private", addRandomSuffix: false, allowOverwrite: false,
      contentType: "application/json", cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(5000) });
  } catch {
    // A repeated event must agree with the immutable paid-order snapshot.
    const existing = await get(path, { access: "private", useCache: false, abortSignal: AbortSignal.timeout(5000) });
    if (!existing || existing.statusCode !== 200 || existing.blob.size > 2048 ||
      await new Response(existing.stream).text() !== content) throw new Error("Unable to record paid order.");
  }
}
