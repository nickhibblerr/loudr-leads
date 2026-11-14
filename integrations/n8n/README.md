# Connect the Team page to the n8n proposal automation

The **Send Proposal** button on `/team` runs the same proposal automation as before, minus the n8n form. The website prices the deal, and n8n does everything else in the same order as today: GHL contact → Whop card and wire links → save the links on the contact → send the GHL proposal document → retire old links. The payment flow (Whop webhook → "proposal paid" tag, note, Slack) is unchanged.

```
Team page ──POST (X-Loudr-Secret)──▶ n8n "Loudr website" webhook
                                        → Proposal settings → Work out total
                                        → Save on GHL contact → Read old links
                                        → Whop card link → Whop bank link → Check links
                                        → Save pay link → Send proposal → Proposal sent?
                                        → Sent (reply to site)  +  Old plan IDs → Retire old link
```

`loudr-website-proposals.n8n.json` is the workflow to import. It was built from the "Jordan | Proposal form + Whop payments" template by `build-website-workflow.mjs`. If the template changes, rebuild it:

```bash
node integrations/n8n/build-website-workflow.mjs path/to/jordan-whop-automation.n8n.json
```

## Setup (about 10 minutes)

1. **Import** `loudr-website-proposals.n8n.json` into n8n as a new workflow. It imports inactive.
   - It already contains the payment flow. Run only one copy against production: turn off the old form workflow once this copy has passed the test below, or delete the payment nodes from whichever copy you don't keep.
2. **Credentials** (the same three as before):
   - GHL API key and Whop API key: select them on every request node.
   - Slack bot: select it on every Slack node.
3. **Website secret.** On the **Loudr website** node, create a Header Auth credential named `Loudr website secret`:
   - Name: `X-Loudr-Secret`
   - Value: a long random string. Generate one with:

   ```bash
   openssl rand -hex 32
   ```
4. **Settings.** Confirm the IDs in **Proposal settings** and **Payment settings**, just as before. The rep names in the `reps` map must match the site's rep list. The defaults are Mason Church, Jeremiah Iroff and Bernardo Morales. To change them, set `TEAM_REP_NAMES` on the site to the same names, comma-separated.
5. **Whop webhook.** In **Sign**, paste the complete `ws_` signing secret. Register `payment.succeeded` on the **Whop payment** URL, as described in the template guide.
6. **Publish** the workflow. Copy the production URL of the **Loudr website** node (`…/webhook/loudr-website-proposal`).
7. **Vercel** (production environment variables on the site), then redeploy:

   | Variable | Value |
   | --- | --- |
   | `N8N_PROPOSAL_WEBHOOK_URL` | Production URL of the Loudr website node |
   | `N8N_PROPOSAL_WEBHOOK_SECRET` | The same secret as step 3 (at least 16 characters) |
   | `TEAM_REP_NAMES` | Optional. Rep names, comma-separated; must match `reps` in Proposal settings |

Until both webhook variables are set, the Team page shows "Proposal sending isn’t connected yet" and the Send Proposal button stays disabled. **Generate link** works without them.

## Acceptance test

- On `/team`, enter Texas, 50 leads, rep, your internal email, a firm, then click **Send Proposal**. Expected: wire $25,000 and card $25,750. The page shows the signing link and both payment links, and the email arrives with the same links.
- Add a second state, or switch a state to Budget, and send again to the same test contact. The previous links are retired only after GHL confirms the new proposal was sent.
- Click **Generate link** and then **Send Proposal** with "Turn off the link I generated here" ticked. The generated link is retired after sending.
- Complete a sandbox card checkout from the proposal. Expect the GHL "proposal paid" tag, a note and the Slack post, as before.

## What the website sends

`POST` with `Content-Type: application/json`, `X-Loudr-Secret: <secret>` and `Idempotency-Key: <proposal_id>`:

```json
{
  "event": "loudr.proposal.send",
  "version": 1,
  "proposal_id": "prop_…",
  "created_at": "2026-11-14T18:00:00.000Z",
  "source": "loudr-leads-site",
  "site": "https://loudrleadsdashboard.vercel.app",
  "rep": { "name": "Mason Church", "whop_user_id": "user_…", "whop_name": "Mason Church" },
  "client": { "first_name": "Dana", "last_name": "Reyes", "email": "dana@example.com", "phone": "", "firm": "Reyes Law" },
  "order": {
    "states": [
      { "code": "TX", "name": "Texas", "leads": 50, "wire_price_per_lead": 500, "subtotal": 25000 },
      { "code": "AL", "name": "Alabama", "leads": 61, "wire_price_per_lead": 325, "subtotal": 19825 }
    ],
    "lead_count": 111, "wire_total": 44825, "card_subtotal": 44825, "card_fee": 1344.75,
    "card_fee_percent": 3, "card_total": 46169.75, "currency": "usd", "price_version": "…"
  },
  "retire_plan_ids": ["plan_…"]
}
```

- Prices come from the site's rate card (Admin → State pricing), so the old hard-coded price list in n8n is no longer used.
- Budget-mode states arrive as the whole number of leads the budget buys.
- The card total is the wire total plus 3%, rounded once on the whole order, exactly as on the client checkout.
- **Work out total** rejects totals that don't add up, unknown reps and unknown payload versions.
- `retire_plan_ids` lists only links the site generated on the Team page for this Whop account.

### Reply

The site waits up to 100 seconds for the reply.

- **Sent** (200): `{ "sent": true, "proposal_id", "email", "signing_url", "card_url", "wire_url", "card_total", "wire_total", "plan_ids" }`
- **Not sent** (502): `{ "sent": false, "error", "proposal_id" }`. The Team page tells the closer to check n8n and GHL before retrying. If the request times out, the page warns that the proposal may already have gone out.

## Generate link (no n8n involved)

**Generate link** makes one Whop link straight from the site: a hidden, one-time USD plan priced at the order total. Wire links take wire only; card links take card only and can be paid once.

Its metadata uses `source: loudr-team-link`, without a GHL contact. A payment on a generated link therefore reaches the payment flow's review alert in Slack (payer, amount and Whop payment ID) rather than being marked as a paid proposal automatically. The rep, firm, client email, leads and total are on the Whop payment's metadata for matching. Send the proposal when the client should get the GHL document and the tagged follow-up.
