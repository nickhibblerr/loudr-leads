#!/usr/bin/env node
// Local stand-in for the n8n "Loudr website" webhook, for trying Send Proposal on localhost.
// Prints each proposal the site sends and answers like the real workflow. Nothing is sent
// to GHL, Whop or the client.
//
//   node integrations/n8n/mock-webhook.mjs            # listens on http://localhost:5679
//   MOCK_FAIL=1 node integrations/n8n/mock-webhook.mjs  # answer "not sent" to test the error path
import { createServer } from "node:http";

const port = Number(process.env.PORT || 5679);
const secret = process.env.N8N_PROPOSAL_WEBHOOK_SECRET || "local-test-secret-0123456789";
const money = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const reply = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method !== "POST" || request.url !== "/webhook/loudr-website-proposal") return reply(404, { message: "Not found" });
    if (request.headers["x-loudr-secret"] !== secret) return reply(403, { message: "Authorization data is wrong!" });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { message: "Invalid JSON" }); }
    console.log("\n── Proposal received ──────────────────────────");
    console.log(JSON.stringify(body, null, 2));
    if (process.env.MOCK_FAIL) return reply(502, { sent: false, error: "Proposal NOT sent: (mock) GHL returned 401.", proposal_id: body.proposal_id });
    // A real run takes a few seconds while Whop and GHL are called.
    setTimeout(() => reply(200, {
      sent: true, proposal_id: body.proposal_id, email: body.client?.email,
      signing_url: "https://sendlink.co/documents/v1/MOCK-REFERENCE?locale=en-US",
      card_url: "https://whop.com/checkout/plan_MOCKCARD", wire_url: "https://whop.com/checkout/plan_MOCKWIRE",
      card_total: money(body.order?.card_total ?? 0), wire_total: money(body.order?.wire_total ?? 0), plan_ids: "plan_MOCKCARD,plan_MOCKWIRE",
    }), 1500);
  });
}).listen(port, () => {
  console.log(`Mock n8n listening on http://localhost:${port}/webhook/loudr-website-proposal`);
  console.log(`Expecting header X-Loudr-Secret: ${secret}`);
});
