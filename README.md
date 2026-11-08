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

The lead subtotal is the selected state's per-lead price multiplied by quantity. **Wire adds no fee. Card adds 3% of the subtotal**, rounded once to the nearest cent. For example, 5 Texas leads at $500 each cost $2,500 by wire or $2,575 by card, including a $75 card fee. The rate is `CARD_FEE_BASIS_POINTS` in `lib/payment-methods.ts`; the site reads its label from there. Receipts paid at the earlier 2.7% rate still verify. The fee and both totals appear before selecting a checkout, and the selected fee is repeated in the payment summary. All calculations use integer cents and are repeated on the server.

## Payment configuration

Configure these variables in `.env.local` for local development and in the intended Vercel project for deployment:

| Variable | Purpose |
| --- | --- |
| `WHOP_API_KEY` | Server-only Whop credential with payment and plan permissions. |
| `WHOP_ACCOUNT_ID` | Intended merchant account (`biz_…`). |
| `WHOP_LEADS_PRODUCT_ID` | Dedicated LOUDR lead product (`prod_…`), matching production. |
| `NEXT_PUBLIC_WHOP_ACCOUNT_ID` | Same merchant account, used by payment elements. |
| `WHOP_WEBHOOK_SECRET` | Server-only signing secret for the payment webhook. |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` locally; `https://loudrleadsdashboard.vercel.app` in production. |
| `WHOP_OAUTH_CLIENT_ID` | Whop OAuth app for admin sign-in: `app_RaP619R6n2xjF2` ("LOUDR Leads Admin"). |
| `WHOP_OAUTH_CLIENT_SECRET` | Optional; only if the OAuth app is changed to a confidential client. |
| `ADMIN_SESSION_SECRET` | Independent random server-only secret for encrypted admin sessions. |

Public variables are embedded at build time; rebuild after changing them. Existing Vercel production settings are retained. The unused ad-spend helper remains for compatibility tests but is not used to price lead orders.

The payment business is Loudr Media (`biz_HqBscEcuZxTgaf`), using its dedicated hidden LOUDR Leads product (`prod_4ka5HAkOPLwBO`). The server and public account IDs must match this business. Its API key and webhook signing secret are stored only in Vercel production secrets. Both the merchant and product are part of plan matching and cache identity.

`/api/checkout` and the lower-level `/api/pay` accept `state`, `quantity` (or `leadCount`), `paymentMode` (`bank` or `card`, defaulting to `bank` when omitted), and optional boolean `forceUsd`. If both quantity aliases are present, they must match. Amounts, unit prices, fee percentages and totals supplied by clients cannot alter the server price. Invalid payment modes, unknown or sold-out states, missing/fractional quantities, quantities above 1,000 and non-USD nominal prices are rejected before calling Whop.

### Ordering by leads or by budget

Every state in an order has a **Budget | Leads** toggle above its amount input; **Budget is the default**. In Leads mode the buyer enters a lead count (quick picks 100–250). In Budget mode they enter whole dollars of lead spend (quick picks $10k–$100k); the site orders the most whole leads that budget covers and shows any amount left over, e.g. `= 61 leads · $19,825 ($175 left over)` for $20,000 of Alabama leads. The budget is lead spend only: card payments add the 3% fee on top. Quick budgets below the state's minimum are disabled. Switching modes converts the current value, and the saved order remembers each state's mode.

**Minimum order: 50 leads per state** (`MIN_LEAD_QUANTITY` in `lib/lead-pricing.ts`), in either mode. The form explains the minimum (in budget mode as a dollar amount for that state), and `/api/checkout` and `/api/pay` refuse any state below it. Receipts from earlier smaller orders still verify. Checkout always receives lead counts, so Whop plans, receipts and Slack are unchanged.

### Multi-state orders

A buyer can add up to 49 states to one order, each with its own lead count (Whop checkouts take up to 50 items; one is reserved for the card fee). The order form keeps the single-state editor and adds a compact order list once a second state is added; a state already in the order can't be picked twice. The order is saved in the buyer's browser (`localStorage`, key `loudr-leads-cart-v1`) for their next visit and cleared once checkout completes or the return page loads for a placed order.

`/api/checkout` accepts `{ items: [{ state, quantity }], paymentMode, forceUsd, priceVersion }` (the original single `{ state, quantity }` body still works). It prices every state from the saved rate card and returns `cart` (per-state lines, subtotal, fee, total) plus Whop `items`: one quantity line per state using that state's lead plan, and for card orders one `Card fee (3%)` line (`fee_scope: order`, reused by amount) priced at 3% of the whole order, rounded once. One-state orders also return the original `quote` field.

The webhook verifies every state line on the receipt (state plan identity, quantity, USD amount) and the order-level fee, records each state and quantity, and the Slack alert lists each state with its lead count and the order total. Receipts from single-state orders placed before carts still verify.

Each state has one per-lead Whop plan per checkout type (Wire, Card, Card in USD) with native multiple quantities enabled. `/api/checkout` returns `items: [{ plan, quantity }]`; both Whop Elements and `/api/pay` send native quantities. A five-lead order at $500 uses a $500 plan with quantity 5. A card order adds a separate fee item with quantity 1, priced at 3% of the whole lead subtotal, rounded once to cents. This preserves totals such as Alabama $325 × 5 + $48.75, without accumulating per-unit rounding differences. Zero rounded fees omit the fee item.

Unit plans carry `pricing_model: unit_quantity_v1`, `item_role: leads`, state, historical price per lead and payment/pricing mode; quantity belongs to the receipt, not the reusable unit plan. Fee plans carry `item_role: card_fee` and the quantity/fee they cover. The lead SKU is `LOUDR-LEADS-<state>`. When an admin saves a new price, `/api/admin/prices` reprices that state's existing lead plans in place on Whop (price and `price_per_lead` metadata); sold-out states are left untouched. If Whop is unreachable during the save, checkout reprices the state's plan on its next order. Quantity and price changes reuse the same lead plan per state and mode; card-fee items stay per order and are never repriced. Legacy whole-order plans remain readable for earlier payments but are never selected for new checkouts.

The Wire checkout enables only `bank_wire` and uses USD because wires require it. ACH (`us_bank_account`) is not offered and is disabled in both checkouts; existing state plans created with ACH are switched to wire only (and retitled "Wire") on their next checkout or admin price save, and receipts paid through them still verify. The Card checkout enables only `card`. **Every checkout is in USD for every buyer:** Whop adaptive pricing (local-currency display) is never enabled on any plan the site creates or uses (`effectiveForceUsd` always returns true), and there is no "Make USD" switch. Receipts from earlier adaptive card payments still verify. Both configurations disable platform defaults and exclude the other checkout's methods. Whop still applies account and buyer eligibility rules.

## Deployment and fulfillment

Production: `https://loudrleadsdashboard.vercel.app` (alias `https://loudr-leads-dashboard.vercel.app`), Vercel project `loudrleadsdashboard` (`prj_eabgyaXm6OkqsJNmeb9G7syvAMAs`), team `team_U6deUEDDpSoDfLg76eaWz6LN`. Deploy only to this project for this repository. `NEXT_PUBLIC_SITE_URL` must stay `https://loudrleadsdashboard.vercel.app` because it is the origin registered as the Whop OAuth redirect. The earlier `loudr-leads` project on another team is no longer the deploy target.

The signed `payment.succeeded` webhook retrieves the payment and all purchased plans from Whop, verifies a paid order for the configured business/product, and sends a Slack alert containing state, quantity, quoted USD order total, payment choice and payment ID. Checkout-provided metadata and return-page query parameters are not authority. Notifications do **not** deliver leads or credit balances.

Unit tests validate pricing, unavailable states, quantity boundaries, card-fee rounding, bank/card restrictions, cache separation and plan verification. A production build is required before deployment. Payment verification must not create a real buyer charge merely to test a release.

## Branding

Black, white and LOUDR yellow are used throughout. The header uses LOUDR's published logo with a text fallback if the image fails. Quick picks offer 100, 125, 150, 200 and 250 leads; any custom quantity up to 1,000 per state can be typed. Quantity guidance becomes more encouraging as the count grows.

## State pricing admin

`/admin` edits the shared rate card in the private Blob object `pricing/state-prices.json`. The Vercel project is connected to the `loudr-lead-pricing` store; its server-only `BLOB_READ_WRITE_TOKEN` is managed by Vercel. No price edits are stored in the browser or bundled into a deployment. Missing objects use the initial rate card; unreadable storage fails with an error rather than silently charging an old price.

Each save sends changed states and the last-read ETag. Conditional writes reject concurrent changes with HTTP 409 so one editor cannot silently overwrite another. Prices support cents, must be $0.01–$10,000 per lead, and can be marked sold out. Reset discards unsaved edits. Saved values apply to new checkouts; payment sessions already opened keep their quoted price.

`/api/prices` returns current public prices without caching. The checkout refreshes its displayed rate card on focus and periodically, and every new plan request rechecks server-side prices. An outdated `priceVersion` returns 409 and asks the buyer to review the new total. Plan-cache keys include the computed price; the guarded legacy payment route also validates against the current rate card.

Admin access requires **Sign in with Whop**, and only joined team members of Loudr Media (`biz_HqBscEcuZxTgaf`) are allowed. Paid customers, pending invites, agents and Whop's view-only Partner role are refused. Both `/admin` and `/api/admin/prices` reject everyone else.

Sign-in uses the hidden Whop OAuth app "LOUDR Leads Admin" (`app_RaP619R6n2xjF2`, a public OAuth 2.1 + PKCE client). Its allowed redirect URIs are `https://loudrleadsdashboard.vercel.app/api/auth/whop/callback` and `http://localhost:3000/api/auth/whop/callback`; add any other origin in the Whop developer dashboard before using it.

1. `/admin/login` posts to `/api/auth/whop/start`, which stores the PKCE verifier and state in a ten-minute encrypted, HttpOnly cookie and redirects to Whop.
2. `/api/auth/whop/callback` checks the state, exchanges the code, reads the Whop user ID from `/oauth/userinfo` and revokes the Whop refresh token. The site never stores Whop tokens.
3. The server's `WHOP_API_KEY` looks the user up with `GET /api/v1/team_members?account_id=…&user_id=…&status=joined`. Only then is an encrypted eight-hour session cookie issued.
4. Every admin page load and API call re-verifies membership with Whop, cached for at most 60 seconds per user. Removing someone from the Whop team revokes their access within a minute. If Whop can't be reached, access fails closed.

Sessions are bound to the business, the OAuth app ID and `ADMIN_SESSION_SECRET`. Changing any of them signs everyone out. Logout and price saves enforce same-origin requests. The former `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` shared login has been removed, and those variables are ignored.


## Paid-order Slack alerts

The webhook derives lead count from the paid receipt's lead line item, verifies its state against the merchant-created unit plan and validates the separate card-fee item without counting it as a lead. It supports cart receipts whose top-level `plan_id`/`product_id` are null. Historical whole-order payments use their original plan metadata. Buyer-supplied metadata is never fulfillment authority. Because lead plans are repriced in place, the price paid is taken from the receipt (the USD lead line, or for local-currency card payments the per-order fee item), never from the plan's current price; adaptive currency receipts retain their authoritative native quantity and currency.

Every verified payment is saved as an immutable private Blob record at `orders/paid/<payment-id>.json` before Slack delivery. If Slack is not configured, the webhook acknowledges the saved order with `delivery: not_configured`; Slack is not claimed as delivered. Once configured, replay the earlier `payment.succeeded` events in Whop to send those saved orders. There is no automatic backlog drain.

To enable Slack delivery:

1. Create a Slack Incoming Webhook for the intended channel and set its URL as the Vercel production secret `SLACK_LEAD_ORDERS_WEBHOOK_URL`.
2. Configure the Loudr Media Whop webhook for `payment.succeeded` at `https://loudrleadsdashboard.vercel.app/api/webhooks/whop`. Its signing secret must match `WHOP_WEBHOOK_SECRET`. The API key must be able to retrieve payments and plans.
3. Redeploy after adding the secret, then verify delivery using a real paid order/replayed paid-order event. No synthetic event with an invented payment ID can pass payment verification. The current API key lacks webhook-management permission, so dashboard configuration must be confirmed separately.

When Slack is configured, the handler waits for delivery before returning success. Missing payment-verification configuration, storage/provider failures or an in-progress delivery return 503 for Whop to retry. Pending bank transfers are not announced as paid. Unrelated businesses/products are ignored.

Delivery receipts live privately under `notifications/slack/<payment-id>.json`. Conditional writes serialize concurrent attempts; completed receipts suppress normal duplicates. Incoming webhooks cannot guarantee exactly-once delivery across a Slack timeout or a failure recording success after Slack accepted the message. Such a retry may duplicate the alert; the stable payment ID identifies the same order. Receipt retry leases expire after two minutes. Monitor failed Whop deliveries and replay them after resolving configuration or provider failures; there is no independent background retry queue.
