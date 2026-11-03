const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./load-ts.cjs');
const pricing = loadTypeScript('lib/top-up.ts');
const preferences = loadTypeScript('lib/payment-methods.ts');
const leads = loadTypeScript('lib/lead-pricing.ts', { '@/lib/top-up': pricing, '@/lib/payment-methods': preferences });
const plans = loadTypeScript('lib/whop-plans.ts', { '@/lib/payment-methods': preferences, '@/lib/top-up': pricing, '@/lib/lead-pricing': leads });
const nativePlans = loadTypeScript('lib/lead-checkout.ts', { '@/lib/payment-methods': preferences });
const env = { WHOP_API_KEY: 'test-key', WHOP_ACCOUNT_ID: 'biz_test', WHOP_LEADS_PRODUCT_ID: 'prod_test', NEXT_PUBLIC_SITE_URL: 'https://example.com' };
const pricingStore = { readRateCard: async () => ({ version: 'initial', updatedAt: null, states: leads.LEAD_STATES }) };
const request = (body) => new Request('https://example.com/api/test', { method: 'POST', body: JSON.stringify(body) });
function checkoutRoute() {
  const calls = [];
  const { POST } = loadTypeScript('app/api/checkout/route.ts', {
    '@/lib/top-up': pricing, '@/lib/lead-pricing': leads, '@/lib/payment-methods': preferences, '@/lib/pricing-store': pricingStore,
    '@/lib/lead-checkout': { getLeadCheckout: async (_, account, product, quote, forceUsd) => { calls.push({ account, product, quote, forceUsd }); return { planId: 'plan_test', feePlanId: quote.feeCents ? 'plan_fee' : null, items: [{plan: 'plan_test', quantity: quote.leadCount}, ...(quote.feeCents ? [{plan: 'plan_fee', quantity: 1}] : [])] }; } },
    '@whop/sdk': { WhopClient: class {} }, 'next/cache': { unstable_cache: (fn) => fn },
  }, { process: { env } });
  return { POST, calls };
}
function payRoute(planChange = {}, paymentMode = 'bank', confirmationType = paymentMode === 'card' ? 'card' : 'bank_wire') {
  const quote = leads.calculateLeadQuote('TX', 2, undefined, paymentMode);
  const plan = { id: 'plan_test', account: { id: 'biz_test' }, product: { id: 'prod_test' }, currency: 'usd', initial_price: quote.unitPrice, allow_multiple_quantity: true,
    plan_type: 'one_time', visibility: 'quick_link', adaptive_pricing_enabled: paymentMode !== 'bank', metadata: nativePlans.leadItemMetadata(quote), payment_method_configuration: preferences.paymentConfigurationFor(paymentMode), ...planChange };
  const charges = [];
  const client = { confirmationTokens: { retrieve: async () => ({ status: 'pending', payment_method_preview: { type: confirmationType } }) }, plans: { retrieve: async () => plan },
    payments: { create: async (input) => { charges.push(input); return { id: 'pay_test', status: 'pending' }; } } };
  const { POST } = loadTypeScript('app/api/pay/route.ts', {
    '@/lib/top-up': pricing, '@/lib/lead-pricing': leads, '@/lib/payment-methods': preferences, '@/lib/whop-plans': plans, '@/lib/lead-checkout': { ...nativePlans, getLeadCheckout: async () => ({planId: 'plan_test', items: [{plan: 'plan_test', quantity: 2}, ...(paymentMode === 'card' ? [{plan: 'plan_fee', quantity: 1}] : [])]}) }, '@/lib/pricing-store': pricingStore,
    '@whop/sdk': { WhopClient: class { constructor() { return client; } } },
  }, { process: { env } });
  return { POST, charges };
}
const validPayment = { state: 'TX', leadCount: 2, feePercent: 2.5, currency: 'usd', confirmationToken: 'ctok_test', orderId: 'leads_test', planId: 'plan_test' };
test('checkout calculates total on the server and ignores a supplied fake total', async () => {
  const { POST, calls } = checkoutRoute();
  const response = await POST(request({ state: 'TX', leadCount: 2, feePercent: 2.5, amount: 1, unitPrice: 1, total: 1 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.quote.total, 1000);
  assert.equal(calls[0].quote.currency, 'usd');
  assert.equal(calls[0].forceUsd, true);
  assert.equal(calls[0].account, 'biz_test');
});
test('both endpoints reject nominal currency and malformed USD override before calling Whop', async () => {
  for (const extra of [{ currency: 'gbp' }, { currency: 'eur' }, { forceUsd: 'true' }]) {
    const checkout = checkoutRoute();
    const pay = payRoute();
    assert.equal((await checkout.POST(request({ ...validPayment, ...extra }))).status, 400);
    assert.equal((await pay.POST(request({ ...validPayment, ...extra }))).status, 400);
    assert.equal(checkout.calls.length, 0);
    assert.equal(pay.charges.length, 0);
  }
});
test('charge uses the no-fee lead plan and live-compatible order metadata', async () => {
  const { POST, charges } = payRoute();
  assert.equal((await POST(request({ ...validPayment, total: 1 }))).status, 200);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].plan_id, undefined);
  assert.equal(charges[0].line_items[0].plan_id, 'plan_test');
  assert.equal(charges[0].line_items[0].quantity, 2);
  assert.equal(charges[0].metadata.topup_amount, undefined);
  assert.equal(charges[0].metadata.state, 'TX');
  assert.equal(charges[0].metadata.quantity, '2');
  assert.equal(charges[0].metadata.price_per_lead, '500');
  assert.equal(charges[0].metadata.ad_spend_fee_percent, undefined);
  assert.equal(charges[0].metadata.ad_spend_fee_amount, undefined);
  assert.equal(charges[0].metadata.total_amount, '1000');
});
test('charge rejects a wrong price or another business', async () => {
  for (const change of [{ initial_price: 1025 }, { account: { id: 'biz_old' } }, { metadata: { topup_amount: '1000', ad_spend_fee_percent: '5' } }]) {
    const { POST, charges } = payRoute(change);
    assert.equal((await POST(request(validPayment))).status, 400);
    assert.equal(charges.length, 0);
  }
});

test('checkout accepts the USD override without adding fees', async () => {
  const { POST, calls } = checkoutRoute();
  const response = await POST(request({ state: 'TX', leadCount: 200, feePercent: 5, forceUsd: true }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.forceUsd, true);
  assert.equal(body.quote.total, 100000);
  assert.equal(calls[0].quote.currency, 'usd');
  assert.equal(calls[0].forceUsd, true);
});

test('both endpoints reject sold-out states, invalid counts and old amount-only requests before Whop', async () => {
  for (const extra of [{ state: 'CA' }, { state: 'DC' }, { state: null }, { state: 'tx' }, { leadCount: 0 }, { leadCount: 1.5 }, { leadCount: '2' }, { leadCount: 1001 }, { state: undefined, leadCount: undefined, amount: 1000 }]) {
    const checkout = checkoutRoute();
    const pay = payRoute();
    assert.equal((await checkout.POST(request({ ...validPayment, ...extra }))).status, 400);
    assert.equal((await pay.POST(request({ ...validPayment, ...extra }))).status, 400);
    assert.equal(checkout.calls.length, 0);
    assert.equal(pay.charges.length, 0);
  }
});
test('charge rejects another lead order even when its monetary total matches', async () => {
  for (const replacement of [leads.calculateLeadQuote('HI', 10), leads.calculateLeadQuote('VT', 10)]) {
    const { POST, charges } = payRoute({ metadata: leads.leadMetadata(replacement) });
    assert.equal((await POST(request(validPayment))).status, 400);
    assert.equal(charges.length, 0);
  }
});


test('live quantity field is accepted, aliases agree and conflicting quantities are rejected', async () => {
  const checkout = checkoutRoute();
  const result = await checkout.POST(request({ state: 'FL', quantity: 10, feePercent: 99, total: 1 }));
  assert.equal(result.status, 200);
  const { quote } = await result.json();
  assert.equal(quote.total, 3750);
  assert.equal(quote.fee, 0);
  assert.equal(quote.quantity, 10);
  assert.equal(quote.leadCount, 10);
  assert.equal(quote.pricePerLead, 375);
  const payment = payRoute();
  assert.equal((await payment.POST(request({ ...validPayment, leadCount: undefined, quantity: 2 }))).status, 200);
  for (const route of [checkoutRoute(), payRoute()]) {
    assert.equal((await route.POST(request({ ...validPayment, quantity: 3 }))).status, 400);
  }
});

test('both endpoints reject malformed payment modes without a plan or charge', async () => {
  for (const paymentMode of [null, '', 'CARD', 'wire', 'ach', 'crypto', 0, false, {}, ['card']]) {
    const checkout = checkoutRoute();
    const pay = payRoute();
    assert.equal((await checkout.POST(request({ ...validPayment, paymentMode }))).status, 400);
    assert.equal((await pay.POST(request({ ...validPayment, paymentMode }))).status, 400);
    assert.equal(checkout.calls.length, 0);
    assert.equal(pay.charges.length, 0);
  }
});

test('card checkout and charge use the server surcharge despite client fee or total tampering', async () => {
  for (const forceUsd of [false, true]) {
    const checkout = checkoutRoute();
    const response = await checkout.POST(request({ state: 'TX', quantity: 2, paymentMode: 'card', forceUsd, fee: 0, feePercent: 0, feeCents: 0, total: 1 }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.quote.paymentMode, 'card');
    assert.equal(body.quote.amountCents, 100000);
    assert.equal(body.quote.feeCents, 2700);
    assert.equal(body.quote.totalCents, 102700);
    assert.equal(checkout.calls[0].forceUsd, forceUsd);
    const quote = leads.calculateLeadQuote('TX', 2, undefined, 'card');
    const pay = payRoute({ adaptive_pricing_enabled: !forceUsd, metadata: nativePlans.leadItemMetadata(quote, forceUsd) }, 'card');
    const paid = await pay.POST(request({ ...validPayment, paymentMode: 'card', forceUsd, fee: 0, feePercent: 0, total: 1 }));
    assert.equal(paid.status, 200);
    assert.equal(pay.charges.length, 1);
    assert.equal(pay.charges[0].metadata.payment_mode, 'card');
    assert.equal(pay.charges[0].metadata.subtotal_amount, '1000');
    assert.equal(pay.charges[0].metadata.payment_fee_amount, '27');
    assert.equal(pay.charges[0].metadata.total_amount, '1027');
  }
});

test('confirmation token method must belong to the selected payment path', async () => {
  for (const [paymentMode, type] of [['bank', 'card'], ['bank', 'sepa_debit'], ['card', 'bank_wire'], ['card', 'us_bank_account'], ['card', null]]) {
    const pay = payRoute({}, paymentMode, type);
    assert.equal((await pay.POST(request({ ...validPayment, paymentMode }))).status, 400);
    assert.equal(pay.charges.length, 0);
  }
  for (const type of ['bank_wire', 'us_bank_account']) {
    const pay = payRoute({}, 'bank', type);
    assert.equal((await pay.POST(request({ ...validPayment, paymentMode: 'bank' }))).status, 200);
  }
});

test('Wire and ACH always prepare USD plans even when adaptive pricing is requested', async () => {
  for (const forceUsd of [undefined, false, true]) {
    const checkout = checkoutRoute();
    const response = await checkout.POST(request({ state: 'TX', quantity: 2, paymentMode: 'bank', forceUsd }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.forceUsd, true);
    assert.equal(body.quote.paymentMode, 'bank');
    assert.equal(body.quote.feeCents, 0);
    assert.equal(body.quote.total, 1000);
    assert.equal(checkout.calls[0].forceUsd, true);
    const pay = payRoute();
    assert.equal((await pay.POST(request({ ...validPayment, paymentMode: 'bank', forceUsd }))).status, 200);
    assert.equal(pay.charges[0].metadata.pricing_mode, 'forced_usd');
  }
});
