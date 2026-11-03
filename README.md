# LOUDR Leads

Next.js 15 / React 19 / TypeScript lead ordering for LOUDR Media, with Whop Elements 1.9.0 and Whop SDK 2.6.0 checkout.

## Local development

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
```

Open `http://localhost:3000`. Without payment environment variables, state selection, quantities, prices and guidance work; the payment step displays a setup message.

## Lead pricing and guidance

`lib/lead-pricing.ts` contains the initial rate card for all 50 states; saved admin prices and availability override it. California starts sold out. Presets are 1, 5, 10, 15 and 25 leads; custom whole-number quantities from 1 through 1,000 are supported. Guidance starts after a quantity is entered and progresses to green at 50 leads. It describes opportunity, not a promised conversion rate.

The lead subtotal is the selected state's per-lead price multiplied by quantity. **Wire & ACH adds no fee. Card adds 2.7% of the subtotal**, rounded once to the nearest cent. For example, 5 Texas leads at $500 each cost $2,500 by bank or $2,567.50 by card, including a $67.50 card fee. The fee and both totals appear before selecting a checkout, and the selected fee is repeated in the payment summary. All calculations use integer cents and are repeated on the server.

## Payment configuration

Configure these variables in `.env.local` for local development and in the intended Vercel project for deployment:

| Variable | Purpose |
| --- | --- |
| `WHOP_API_KEY` | Server-only Whop credential with payment and plan permissions. |
| `WHOP_ACCOUNT_ID` | Intended merchant account (`biz_…`). |
| `WHOP_LEADS_PRODUCT_ID` | Dedicated LOUDR lead product (`prod_…`), matching production. |
| `NEXT_PUBLIC_WHOP_ACCOUNT_ID` | Same merchant account, used by payment elements. |
| `WHOP_WEBHOOK_SECRET` | Server-only signing secret for the payment webhook. |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` locally; `https://loudr-leads.vercel.app` in production. |
| `ADMIN_USERNAME` | Server-side username for the temporary shared admin login. |
| `ADMIN_PASSWORD_HASH` | Salted scrypt password hash; never a plaintext password or public variable. |
| `ADMIN_SESSION_SECRET` | Independent random server-only secret for encrypted admin sessions. |

Public variables are embedded at build time; rebuild after changing them. Existing Vercel production settings are retained. The unused ad-spend helper remains for compatibility tests but is not used to price lead orders.

The payment business is Loudr Media (`biz_HqBscEcuZxTgaf`), using its dedicated hidden LOUDR Leads product (`prod_4ka5HAkOPLwBO`). The server and public account IDs must match this business. Its API key and webhook signing secret are stored only in Vercel production secrets. Both the merchant and product are part of plan matching and cache identity.

`/api/checkout` and the lower-level `/api/pay` accept `state`, `quantity` (or `leadCount`), `paymentMode` (`bank` or `card`, defaulting to `bank` when omitted), and optional boolean `forceUsd`. If both quantity aliases are present, they must match. Amounts, unit prices, fee percentages and totals supplied by clients cannot alter the server price. Invalid payment modes, unknown or sold-out states, missing/fractional quantities, quantities above 1,000 and non-USD nominal prices are rejected before calling Whop.

Each state has price-specific per-lead Whop plans with native multiple quantities enabled. `/api/checkout` returns `items: [{ plan, quantity }]`; both Whop Elements and `/api/pay` send native quantities. A five-lead order at $500 uses a $500 plan with quantity 5. A card order adds a separate fee item with quantity 1, priced at 2.7% of the whole lead subtotal, rounded once to cents. This preserves totals such as Alabama $325 × 5 + $43.88, without accumulating per-unit rounding differences. Zero rounded fees omit the fee item.

Unit plans carry `pricing_model: unit_quantity_v1`, `item_role: leads`, state, historical price per lead and payment/pricing mode; quantity belongs to the receipt, not the reusable unit plan. Fee plans carry `item_role: card_fee` and the quantity/fee they cover. The lead SKU is `LOUDR-LEADS-<state>`. Admin changes select new price-specific plans without rewriting old plans. Quantity changes reuse the same lead plan at the same state/rate/mode. Legacy whole-order plans remain readable for earlier payments but are never selected for new checkouts.

The Wire & ACH checkout enables only `bank_wire` and `us_bank_account`, and uses USD because those methods require it. The Card checkout enables only `card`; Whop can display eligible local currencies, and Make USD selects a separate non-adaptive card plan. Both configurations disable platform defaults and exclude the other checkout's methods. Whop still applies account and buyer eligibility rules.

## Deployment and fulfillment

Production: `https://loudr-leads.vercel.app`, project `prj_laSEpueJ84xcCcFItcwPSWCFTnc1`, team `team_nJJFw2mdvFrhMqsbZGUEOqsc` (Tommy Chryst's projects). Deploy only to this project for this repository. The older repository README's Unlimited Scaling project is unrelated to this release.

The signed `payment.succeeded` webhook retrieves the payment and all purchased plans from Whop, verifies a paid order for the configured business/product, and sends a Slack alert containing state, quantity, quoted USD order total, payment choice and payment ID. Checkout-provided metadata and return-page query parameters are not authority. Notifications do **not** deliver leads or credit balances.

Unit tests validate pricing, unavailable states, quantity boundaries, card-fee rounding, bank/card restrictions, cache separation and plan verification. A production build is required before deployment. Payment verification must not create a real buyer charge merely to test a release.

## Branding

Black, white and LOUDR yellow are used throughout. The header uses LOUDR's published logo with a text fallback if the image fails. Quantity guidance becomes more encouraging across 1, 5, 10, 15, 25 and 50+ leads.

## State pricing admin

`/admin` edits the shared rate card in the private Blob object `pricing/state-prices.json`. The Vercel project is connected to the `loudr-lead-pricing` store; its server-only `BLOB_READ_WRITE_TOKEN` is managed by Vercel. No price edits are stored in the browser or bundled into a deployment. Missing objects use the initial rate card; unreadable storage fails with an error rather than silently charging an old price.

Each save sends changed states and the last-read ETag. Conditional writes reject concurrent changes with HTTP 409 so one editor cannot silently overwrite another. Prices support cents, must be $0.01–$10,000 per lead, and can be marked sold out. Reset discards unsaved edits. Saved values apply to new checkouts; payment sessions already opened keep their quoted price.

`/api/prices` returns current public prices without caching. The checkout refreshes its displayed rate card on focus and periodically, and every new plan request rechecks server-side prices. An outdated `priceVersion` returns 409 and asks the buyer to review the new total. Plan-cache keys include the computed price; the guarded legacy payment route also validates against the current rate card.

The admin now requires a server-verified username and password at `/admin/login`. Both the page and `/api/admin/prices` reject unauthenticated access; the former open-access flag is no longer honored. Authentication uses a salted scrypt hash and an encrypted, HttpOnly session cookie with an eight-hour lifetime, Secure on HTTPS and SameSite=Lax. Sessions are bound to the current business, site origin, username and credential version, so changing the password invalidates existing sessions. Saves and login/logout submissions also enforce same-origin requests.

`ADMIN_PASSWORD_HASH` has the format `scrypt$<salt-base64url>$<hash-base64url>`: 16 random salt bytes and a 64-byte scrypt result using N=16384, r=8, p=1 and maxmem=64 MiB. Generate a separate random `ADMIN_SESSION_SECRET` of at least 32 characters. Never commit either value or the plaintext password.

Login allows up to 10 attempts per client IP in each five-minute window. Production counters use conditional writes in the existing private Blob store, under HMAC-derived names that do not expose raw IP addresses. If that store is unavailable, sign-in fails closed; local development without storage uses a bounded in-memory counter.

Whop OAuth and live team-membership authorization are deferred in favor of the requested temporary shared login. The current merchant key can read joined team members, but creating an OAuth app requires `developer:create_app`; webhook configuration inspection requires `developer:manage_webhook`. A future Whop login must verify the authenticated user against joined team members of `biz_HqBscEcuZxTgaf`, not paid customer memberships.


## Paid-order Slack alerts

The webhook derives lead count from the paid receipt's lead line item, verifies its state against the merchant-created unit plan and validates the separate card-fee item without counting it as a lead. It supports cart receipts whose top-level `plan_id`/`product_id` are null. Historical whole-order payments use their original plan metadata. Buyer-supplied metadata is never fulfillment authority. USD item amounts are checked against the original price; adaptive currency receipts retain their authoritative native quantity and currency.

Every verified payment is saved as an immutable private Blob record at `orders/paid/<payment-id>.json` before Slack delivery. If Slack is not configured, the webhook acknowledges the saved order with `delivery: not_configured`; Slack is not claimed as delivered. Once configured, replay the earlier `payment.succeeded` events in Whop to send those saved orders. There is no automatic backlog drain.

To enable Slack delivery:

1. Create a Slack Incoming Webhook for the intended channel and set its URL as the Vercel production secret `SLACK_LEAD_ORDERS_WEBHOOK_URL`.
2. Configure the Loudr Media Whop webhook for `payment.succeeded` at `https://loudr-leads.vercel.app/api/webhooks/whop`. Its signing secret must match `WHOP_WEBHOOK_SECRET`. The API key must be able to retrieve payments and plans.
3. Redeploy after adding the secret, then verify delivery using a real paid order/replayed paid-order event. No synthetic event with an invented payment ID can pass payment verification. The current API key lacks webhook-management permission, so dashboard configuration must be confirmed separately.

When Slack is configured, the handler waits for delivery before returning success. Missing payment-verification configuration, storage/provider failures or an in-progress delivery return 503 for Whop to retry. Pending bank transfers are not announced as paid. Unrelated businesses/products are ignored.

Delivery receipts live privately under `notifications/slack/<payment-id>.json`. Conditional writes serialize concurrent attempts; completed receipts suppress normal duplicates. Incoming webhooks cannot guarantee exactly-once delivery across a Slack timeout or a failure recording success after Slack accepted the message. Such a retry may duplicate the alert; the stable payment ID identifies the same order. Receipt retry leases expire after two minutes. Monitor failed Whop deliveries and replay them after resolving configuration or provider failures; there is no independent background retry queue.
