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

Public variables are embedded at build time; rebuild after changing them. Existing Vercel production settings are retained. The unused ad-spend helper remains for compatibility tests but is not used to price lead orders.

`/api/checkout` and the lower-level `/api/pay` accept `state`, `quantity` (or `leadCount`), `paymentMode` (`bank` or `card`, defaulting to `bank` when omitted), and optional boolean `forceUsd`. If both quantity aliases are present, they must match. Amounts, unit prices, fee percentages and totals supplied by clients cannot alter the server price. Invalid payment modes, unknown or sold-out states, missing/fractional quantities, quantities above 1,000 and non-USD nominal prices are rejected before calling Whop.

Server-created plan metadata preserves `state`, `state_name`, `quantity`, `price_per_lead`, `pricing_mode`, `source: loudr-leads-site`, `currency` and `total_amount`, and records payment mode, subtotal and fee. Plan lookup verifies merchant, product, order, pricing mode and payment-method restrictions. Cache keys and idempotency distinguish bank from card, state, quantity and unit price, including orders that share a total. A plan for a different payment mode cannot be reused or repaired as the selected mode.

The Wire & ACH checkout enables only `bank_wire` and `us_bank_account`, and uses USD because those methods require it. The Card checkout enables only `card`; Whop can display eligible local currencies, and Make USD selects a separate non-adaptive card plan. Both configurations disable platform defaults and exclude the other checkout's methods. Whop still applies account and buyer eligibility rules.

## Deployment and fulfillment

Production: `https://loudr-leads.vercel.app`, project `prj_laSEpueJ84xcCcFItcwPSWCFTnc1`, team `team_nJJFw2mdvFrhMqsbZGUEOqsc` (Tommy Chryst's projects). Deploy only to this project for this repository. The older repository README's Unlimited Scaling project is unrelated to this release.

The signed `payment.succeeded` webhook logs payment metadata only. It does **not** deliver leads or credit balances. Fulfillment must retrieve and verify the payment and server-authored plan, map the buyer, and deduplicate durable work on `payment.id`. Checkout-provided metadata and return-page query parameters are not fulfillment authority.

Unit tests validate pricing, unavailable states, quantity boundaries, card-fee rounding, bank/card restrictions, cache separation and plan verification. A production build is required before deployment. Payment verification must not create a real buyer charge merely to test a release.

## Branding

Black, white and LOUDR yellow are used throughout. The header uses LOUDR's published logo with a text fallback if the image fails. Quantity guidance becomes more encouraging across 1, 5, 10, 15, 25 and 50+ leads.

## State pricing admin

`/admin` edits the shared rate card in the private Blob object `pricing/state-prices.json`. The Vercel project is connected to the `loudr-lead-pricing` store; its server-only `BLOB_READ_WRITE_TOKEN` is managed by Vercel. No price edits are stored in the browser or bundled into a deployment. Missing objects use the initial rate card; unreadable storage fails with an error rather than silently charging an old price.

Each save sends changed states and the last-read ETag. Conditional writes reject concurrent changes with HTTP 409 so one editor cannot silently overwrite another. Prices support cents, must be $0.01–$10,000 per lead, and can be marked sold out. Reset discards unsaved edits. Saved values apply to new checkouts; payment sessions already opened keep their quoted price.

`/api/prices` returns current public prices without caching. The checkout refreshes its displayed rate card on focus and periodically, and every new plan request rechecks server-side prices. An outdated `priceVersion` returns 409 and asks the buyer to review the new total. Plan-cache keys include the computed price; the guarded legacy payment route also validates against the current rate card.

The owner explicitly requested open admin for this first release. `ADMIN_ACCESS_MODE=open` enables its API. `lib/admin-auth.ts` centralizes this temporary policy and same-origin write checks; replace it with verified Whop OAuth sessions and business team-membership checks before restricting access to staff. The flag is not authentication: while open, any visitor can edit prices.
