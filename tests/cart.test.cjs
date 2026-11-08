const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript: load } = require('./load-ts.cjs');
const plain = (value) => JSON.parse(JSON.stringify(value));
// Pricing-arithmetic tests use small orders; the 50-lead order minimum is tested on its own below.
const quoteOf = (items, rates, mode = 'bank') => cartLib.calculateCartQuote(items, rates, mode, undefined, 1);
const methods = load('lib/payment-methods.ts');
const topup = load('lib/top-up.ts');
const pricing = load('lib/lead-pricing.ts', { '@/lib/payment-methods': methods, '@/lib/top-up': topup });
const cartLib = load('lib/lead-cart.ts', { '@/lib/lead-pricing': pricing, '@/lib/payment-methods': methods });
const native = load('lib/lead-checkout.ts', { '@/lib/payment-methods': methods, '@/lib/lead-cart': cartLib });
const legacy = load('lib/whop-plans.ts', { '@/lib/payment-methods': methods, '@/lib/lead-pricing': pricing, '@/lib/top-up': topup });
const orders = load('lib/paid-lead-order.ts', { '@/lib/payment-methods': methods, '@/lib/lead-pricing': pricing, '@/lib/lead-checkout': native, '@/lib/whop-plans': legacy, '@/lib/lead-cart': cartLib });

function whop() {
  const plans = [], creates = [], updates = [];
  let lists = 0;
  const client = { plans: {
    list: async () => { lists++; return plans; },
    create: async (input, options) => { const plan = { ...input, ...options.additionalBodyParameters, id: `plan_${plans.length + 1}`, account: { id: input.account_id }, product: { id: input.product_id } }; plans.push(plan); creates.push(options); return plan; },
    update: async ({ id, ...changes }) => { updates.push(id); const plan = plans.find((p) => p.id === id); Object.assign(plan, changes); return plan; },
  } };
  return { client, plans, creates, updates, get lists() { return lists; } };
}

const order = [{ state: 'TX', quantity: 10 }, { state: 'AL', quantity: 5 }, { state: 'VT', quantity: 3 }];

test('cart prices each state separately and rounds the card fee once on the whole order', () => {
  const bank = quoteOf(order, undefined, 'bank');
  assert.deepEqual(plain(bank.lines.map((l) => [l.state, l.leadCount, l.amountCents])), [['TX', 10, 500000], ['AL', 5, 162500], ['VT', 3, 30000]]);
  assert.equal(bank.leadCount, 18); assert.equal(bank.amountCents, 692500); assert.equal(bank.feeCents, 0); assert.equal(bank.total, 6925);
  const card = quoteOf(order, undefined, 'card');
  assert.equal(card.feeCents, 20775); assert.equal(card.totalCents, 692500 + card.feeCents);
  // Two $0.50 states: 3% of $1.00 is $0.03, while rounding each state ($0.015) would give $0.04.
  const cheap = pricing.LEAD_STATES.map((s) => s.code === 'AL' || s.code === 'AK' ? { ...s, price: 0.5 } : s);
  const pair = [{ state: 'AL', quantity: 1 }, { state: 'AK', quantity: 1 }];
  const perState = pair.map((item) => quoteOf([item], cheap, 'card').feeCents).reduce((a, b) => a + b, 0);
  assert.equal(quoteOf(pair, cheap, 'card').feeCents, 3); assert.equal(perState, 4);
});

test('cart rejects empty, duplicate, oversized, sold-out and malformed orders', () => {
  assert.throws(() => quoteOf([]), /at least one state/);
  assert.throws(() => quoteOf('TX'), /at least one state/);
  assert.throws(() => quoteOf([{ state: 'TX', quantity: 1 }, { state: 'TX', quantity: 2 }]), /already in your order/);
  assert.throws(() => quoteOf([{ state: 'CA', quantity: 1 }]), /sold out/);
  assert.throws(() => quoteOf([{ state: 'TX', quantity: 0 }]), /whole number/);
  assert.throws(() => quoteOf([{ state: 'TX', quantity: 1001 }]), /maximum/);
  assert.throws(() => quoteOf([null]), /valid state/);
  const fifty = pricing.LEAD_STATES.filter((s) => s.price !== null).map((s) => ({ state: s.code, quantity: 1 }));
  assert.equal(fifty.length, 49);
  assert.equal(quoteOf(fifty).lines.length, 49);
  assert.throws(() => quoteOf([...fifty, { state: 'TX', quantity: 1 }]), /up to 49 states/);
});

test('requests accept a list of items or the original single state, never both', () => {
  assert.deepEqual(plain(cartLib.requestedCartItems({ items: order })), order);
  assert.deepEqual(plain(cartLib.requestedCartItems({ state: 'TX', quantity: 4 })), [{ state: 'TX', quantity: 4 }]);
  assert.throws(() => cartLib.requestedCartItems({ items: order, state: 'TX' }), /not both/);
});

test('checkout uses one quantity line per state and one card fee line for the whole order', async () => {
  const w = whop();
  const cart = quoteOf(order, undefined, 'card');
  const checkout = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', cart);
  assert.equal(w.lists, 1, 'plans are listed once per checkout');
  assert.equal(checkout.items.length, 4);
  assert.deepEqual(plain(checkout.items.slice(0, 3).map((item) => item.quantity)), [10, 5, 3]);
  assert.deepEqual(plain(checkout.items.slice(0, 3).map((item) => w.plans.find((p) => p.id === item.plan).metadata.state)), ['TX', 'AL', 'VT']);
  const fee = w.plans.find((p) => p.id === checkout.feePlanId);
  assert.equal(checkout.items[3].plan, fee.id); assert.equal(checkout.items[3].quantity, 1);
  assert.equal(fee.initial_price, cart.fee); assert.equal(fee.metadata.fee_scope, 'order'); assert.equal(fee.metadata.state, undefined);
  assert.equal(fee.title, 'Card fee (3%)'); assert.equal(fee.metadata.payment_fee_percent, '3');

  // A second order reuses each state's plan; a matching fee amount reuses the fee item.
  const again = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', cart);
  assert.deepEqual(plain(again.items), plain(checkout.items)); assert.equal(w.plans.length, 4);
  const single = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', quoteOf([{ state: 'TX', quantity: 2 }], undefined, 'bank'));
  assert.equal(single.items.length, 1); assert.equal(single.feePlanId, null);
  assert.notEqual(single.items[0].plan, checkout.items[0].plan, 'Wire & ACH and Card keep separate state plans');
});

test('a changed price reprices that state plan inside a cart checkout', async () => {
  const w = whop();
  await native.getCartCheckout(w.client, 'biz_test', 'prod_test', quoteOf(order, undefined, 'bank'));
  const rates = pricing.LEAD_STATES.map((s) => s.code === 'AL' ? { ...s, price: 410 } : s);
  const next = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', quoteOf(order, rates, 'bank'));
  assert.equal(w.updates.length, 1); assert.equal(w.plans.length, 3);
  assert.equal(w.plans.find((p) => p.id === next.items[1].plan).initial_price, 410);
});

async function paidCart(mode = 'card', items = order) {
  const w = whop();
  const cart = quoteOf(items, undefined, mode);
  const checkout = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', cart);
  const payment = { id: 'pay_cart', status: 'paid', paid_at: '2026-11-07T12:00:00Z', account_id: 'biz_test', product_id: null, plan_id: null, currency: 'usd', metadata: { state: 'CA', quantity: '999' },
    line_items: checkout.items.map((item) => { const p = w.plans.find((plan) => plan.id === item.plan); return { plan_id: p.id, product_id: 'prod_test', quantity: item.quantity, subtotal: { amount: (p.initial_price * item.quantity).toFixed(2), currency: 'usd' } }; }) };
  const plans = checkout.items.map((item) => w.plans.find((p) => p.id === item.plan));
  return { w, cart, checkout, payment, plans };
}

test('a paid multi-state receipt records every state and quantity from the receipt', async () => {
  for (const mode of ['card', 'bank']) {
    const f = await paidCart(mode);
    const o = orders.paidLeadOrder(f.payment, f.plans, 'biz_test', 'prod_test');
    assert.deepEqual(plain(o.items), [
      { state: 'TX', stateName: 'Texas', quantity: 10, pricePerLead: 500, subtotalUsd: 5000 },
      { state: 'AL', stateName: 'Alabama', quantity: 5, pricePerLead: 325, subtotalUsd: 1625 },
      { state: 'VT', stateName: 'Vermont', quantity: 3, pricePerLead: 100, subtotalUsd: 300 }]);
    assert.equal(o.leadSubtotalUsd, 6925); assert.equal(o.cardFeeUsd, mode === 'card' ? 207.75 : 0);
    assert.deepEqual(plain(o.product), { id: 'prod_test', name: 'LOUDR Leads' });
    assert.equal(o.quantity, 18); assert.equal(o.orderTotalUsd, f.cart.total); assert.equal(o.paymentMode, mode);
    const text = orders.slackOrderMessage(o).text;
    assert.match(text, /States:\n• Texas \(TX\): 10 leads × \$500\.00 = \$5,000\.00\n• Alabama \(AL\): 5 leads × \$325\.00 = \$1,625\.00\n• Vermont \(VT\): 3 leads × \$100\.00 = \$300\.00\nTotal leads: 18\nLead subtotal: \$6,925\.00/);
  }
  const one = await paidCart('bank', [{ state: 'TX', quantity: 1 }]);
  assert.match(orders.slackOrderMessage(orders.paidLeadOrder(one.payment, one.plans, 'biz_test', 'prod_test')).text, /State:\n• Texas \(TX\): 1 lead × \$500\.00 = \$500\.00\nTotal leads: 1\n/);
});

test('multi-state receipts reject tampered quantities, amounts, fees and items', async () => {
  const f = await paidCart('card');
  const clone = () => JSON.parse(JSON.stringify(f.payment));
  const mutations = [
    (p) => { p.line_items[3].subtotal.amount = '1.00'; },
    (p) => { p.line_items[3].quantity = 2; },
    (p) => { p.line_items.pop(); },
    (p) => { p.line_items[1].subtotal.amount = '1.00'; },
    (p) => { p.line_items[0].quantity = 1.5; },
    (p) => { p.line_items[2].product_id = 'prod_other'; },
    (p) => { p.line_items.push({ ...p.line_items[0] }); },
    (p) => { p.account_id = 'biz_other'; },
    (p) => { p.status = 'open'; },
  ];
  for (const mutate of mutations) { const p = clone(); mutate(p); assert.throws(() => orders.paidLeadOrder(p, p.line_items.map((line) => f.plans.find((plan) => plan.id === line.plan_id) ?? f.plans[0]).slice(0, p.line_items.length), 'biz_test', 'prod_test')); }
  // Mixing a Wire & ACH plan into a card order is refused.
  const bank = await paidCart('bank', [{ state: 'GA', quantity: 2 }]);
  const mixed = clone(); mixed.line_items.splice(1, 0, bank.payment.line_items[0]);
  assert.throws(() => orders.paidLeadOrder(mixed, [f.plans[0], bank.plans[0], ...f.plans.slice(1)], 'biz_test', 'prod_test'));
  // A bank order never carries a card fee line.
  const bankOrder = await paidCart('bank');
  const withFee = JSON.parse(JSON.stringify(bankOrder.payment)); withFee.line_items.push(f.payment.line_items[3]);
  assert.throws(() => orders.paidLeadOrder(withFee, [...bankOrder.plans, f.plans[3]], 'biz_test', 'prod_test'));
});

test('receipts for orders placed before carts (state-specific fee items) still verify', async () => {
  const w = whop();
  const quote = pricing.calculateLeadQuote('AL', 5, undefined, 'card');
  const leadPlan = { ...{ account_id: 'biz_test', product_id: 'prod_test', currency: 'usd', plan_type: 'one_time', visibility: 'quick_link', adaptive_pricing_enabled: true, allow_multiple_quantity: true, initial_price: 325,
    payment_method_configuration: methods.paymentConfigurationFor('card'), metadata: native.leadItemMetadata(quote) }, id: 'plan_lead', account: { id: 'biz_test' }, product: { id: 'prod_test' } };
  const feePlan = { ...leadPlan, id: 'plan_fee', allow_multiple_quantity: false, initial_price: 43.88, metadata: { ...native.leadItemMetadata(quote, false, 'card_fee'), payment_fee_amount: '43.88', payment_fee_percent: '2.7' } };
  const payment = { id: 'pay_old', status: 'paid', paid_at: '2026-11-04T00:00:00Z', account_id: 'biz_test', currency: 'usd',
    line_items: [{ plan_id: 'plan_lead', product_id: 'prod_test', quantity: 5, subtotal: { amount: '1625.00', currency: 'usd' } }, { plan_id: 'plan_fee', product_id: 'prod_test', quantity: 1, subtotal: { amount: '43.88', currency: 'usd' } }] };
  const o = orders.paidLeadOrder(payment, [leadPlan, feePlan], 'biz_test', 'prod_test');
  assert.deepEqual(plain(o.items), [{ state: 'AL', stateName: 'Alabama', quantity: 5, pricePerLead: 325, subtotalUsd: 1625 }]); assert.equal(o.orderTotalUsd, 1668.88);
  assert.equal(w.plans.length, 0);
});

test('Wire checkout offers wire only; existing Wire & ACH state plans are switched to wire in place', async () => {
  const w = whop();
  const quote = pricing.calculateLeadQuote('TX', 2, undefined, 'bank');
  const old = { account_id: 'biz_test', product_id: 'prod_test', currency: 'usd', plan_type: 'one_time', visibility: 'quick_link', adaptive_pricing_enabled: false,
    allow_multiple_quantity: true, initial_price: 500, title: 'TX lead (Wire & ACH)', id: 'plan_old', account: { id: 'biz_test' }, product: { id: 'prod_test' },
    payment_method_configuration: { enabled: ['bank_wire', 'us_bank_account'], disabled: ['card', 'crypto', 'eu_bank_transfer', 'sepa_debit', 'us_bank_transfer'], include_platform_defaults: false },
    metadata: native.leadItemMetadata(quote, true) };
  w.plans.push(old);
  const config = methods.paymentConfigurationFor('bank');
  assert.deepEqual(plain(config.enabled), ['bank_wire']);
  assert(config.disabled.includes('us_bank_account') && methods.paymentConfigurationFor('card').disabled.includes('us_bank_account'));
  const checkout = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', quoteOf([{ state: 'TX', quantity: 2 }], undefined, 'bank'));
  assert.equal(checkout.items[0].plan, 'plan_old', 'the existing plan is kept');
  assert.equal(w.plans.length, 1);
  assert.deepEqual(plain(old.payment_method_configuration.enabled), ['bank_wire']);
  assert.equal(old.title, 'TX lead (Wire)');
  // The admin price sync also repairs plans nobody has ordered from since.
  const ga = { ...old, id: 'plan_ga', title: 'GA lead (Wire & ACH)', initial_price: 400, payment_method_configuration: { enabled: ['bank_wire', 'us_bank_account'], disabled: [], include_platform_defaults: false },
    metadata: native.leadItemMetadata(pricing.calculateLeadQuote('GA', 1, undefined, 'bank'), true) };
  w.plans.push(ga);
  assert.equal(await native.syncLeadPlanPrices(w.client, 'biz_test', 'prod_test', pricing.LEAD_STATES), 1);
  assert.deepEqual(plain(ga.payment_method_configuration.enabled), ['bank_wire']); assert.equal(ga.title, 'GA lead (Wire)'); assert.equal(ga.initial_price, 400);
  // A receipt paid while the plan still offered ACH verifies.
  const payment = { id: 'pay_ach', status: 'paid', paid_at: '2026-11-05T00:00:00Z', account_id: 'biz_test', currency: 'usd',
    line_items: [{ plan_id: 'plan_old', product_id: 'prod_test', quantity: 2, subtotal: { amount: '1000.00', currency: 'usd' } }] };
  old.payment_method_configuration = { enabled: ['bank_wire', 'us_bank_account'], disabled: [], include_platform_defaults: false };
  assert.equal(orders.paidLeadOrder(payment, [old], 'biz_test', 'prod_test').orderTotalUsd, 1000);
  assert.match(orders.slackOrderMessage(orders.paidLeadOrder(payment, [old], 'biz_test', 'prod_test')).text, /Checkout: Wire\n/);
});

test('card fee is 3%; receipts at the earlier 2.7% rate still verify, any other rate is refused', async () => {
  const f = await paidCart('card');
  assert.equal(f.cart.feeBasisPoints, 300); assert.equal(f.cart.feeCents, 20775);
  assert.equal(orders.paidLeadOrder(f.payment, f.plans, 'biz_test', 'prod_test').orderTotalUsd, 7132.75);
  const fee = f.plans[3];
  const old = JSON.parse(JSON.stringify(f.payment));
  const oldFee = { ...fee, initial_price: 186.98, metadata: { ...fee.metadata, payment_fee_amount: '186.98', payment_fee_percent: '2.7' } };
  old.line_items[3].subtotal.amount = '186.98';
  assert.equal(orders.paidLeadOrder(old, [...f.plans.slice(0, 3), oldFee], 'biz_test', 'prod_test').orderTotalUsd, 7111.98);
  const odd = { ...oldFee, metadata: { ...oldFee.metadata, payment_fee_percent: '1' } };
  assert.throws(() => orders.paidLeadOrder(old, [...f.plans.slice(0, 3), odd], 'biz_test', 'prod_test'), /fee rate/);
});

test('orders need at least 50 leads per state; receipts for smaller earlier orders still verify', async () => {
  assert.equal(pricing.MIN_LEAD_QUANTITY, 50);
  assert.throws(() => cartLib.calculateCartQuote([{ state: 'TX', quantity: 49 }]), /minimum order is 50 leads per state \(Texas\)/);
  assert.throws(() => cartLib.calculateCartQuote([{ state: 'TX', quantity: 50 }, { state: 'AL', quantity: 10 }], undefined, 'card'), /Alabama/);
  assert.equal(cartLib.calculateCartQuote([{ state: 'TX', quantity: 50 }, { state: 'AL', quantity: 120 }]).leadCount, 170);
  const f = await paidCart('card');
  assert.equal(orders.paidLeadOrder(f.payment, f.plans, 'biz_test', 'prod_test').quantity, 18, 'a receipt below the minimum is still recorded');
});

test('a budget buys the most whole leads it covers and reports the leftover', () => {
  assert.deepEqual(plain(cartLib.leadsForBudget(20000, 500)), { leadCount: 40, spentCents: 2000000, leftoverCents: 0 });
  assert.deepEqual(plain(cartLib.leadsForBudget(20000, 325)), { leadCount: 61, spentCents: 1982500, leftoverCents: 17500 });
  assert.deepEqual(plain(cartLib.leadsForBudget(100, 19.99)), { leadCount: 5, spentCents: 9995, leftoverCents: 5 });
  assert.equal(cartLib.leadsForBudget(400, 500).leadCount, 0);
  for (const bad of [0, -5, 1.5, NaN]) assert.equal(cartLib.leadsForBudget(bad, 500), null);
  assert.equal(cartLib.leadsForBudget(1000, 0), null);
});

test('paid orders record product, quantities, prices and the buyer email; Slack shows them', async () => {
  const f = await paidCart('card');
  f.payment.customer_email = 'buyer@lawfirm.example';
  for (const line of f.payment.line_items) line.product_title = 'LOUDR Leads';
  const o = orders.paidLeadOrder(f.payment, f.plans, 'biz_test', 'prod_test');
  assert.equal(o.customerEmail, 'buyer@lawfirm.example');
  assert.deepEqual(plain(o.product), { id: 'prod_test', name: 'LOUDR Leads' });
  assert.equal(o.quantity, 18); assert.equal(o.orderTotalUsd, 7132.75);
  const text = orders.slackOrderMessage(o).text;
  assert.match(text, /Customer: buyer@lawfirm\.example\nProduct: LOUDR Leads\nStates:/);
  assert.match(text, /Card fee: \$207\.75\nOrder total \(USD\): \$7,132\.75\nCheckout: Card\nPayment ID: pay_cart$/);
  f.payment.customer_email = null;
  assert.match(orders.slackOrderMessage(orders.paidLeadOrder(f.payment, f.plans, 'biz_test', 'prod_test')).text, /Customer: email not provided/);
});

test('checkout metadata names the product and each state quantity and price per lead', () => {
  const cart = cartLib.calculateCartQuote([{ state: 'TX', quantity: 100 }, { state: 'AL', quantity: 50 }], undefined, 'card');
  const m = cartLib.cartMetadata(cart, true);
  assert.equal(m.product, 'LOUDR Leads'); assert.equal(m.quantity, '150'); assert.equal(m.items, 'TX:100@500,AL:50@325');
  assert.equal(m.subtotal_amount, '66250'); assert.equal(m.payment_fee_amount, '1987.5'); assert.equal(m.total_amount, '68237.5');
  assert.equal(m.pricing_mode, 'forced_usd');
  assert(Object.keys(m).length <= 50 && Object.values(m).every((value) => typeof value === 'string' && value.length <= 500), 'fits Whop metadata limits');
  const all = pricing.LEAD_STATES.filter((s) => s.price !== null).map((s) => ({ state: s.code, quantity: 1000 }));
  const big = cartLib.cartMetadata(cartLib.calculateCartQuote(all, undefined, 'card'), true);
  assert(Object.values(big).every((value) => value.length <= 500), 'a 49-state order still fits');
});

test('the webhook accepts multi-state receipts with more than two line items', async () => {
  const f = await paidCart('card');
  assert.equal(f.payment.line_items.length, 4);
  let stored = null;
  const route = load('app/api/webhooks/whop/route.ts', {
    '@whop/sdk': { WhopClient: class { payments = { retrieve: async () => f.payment }; plans = { retrieve: async ({ id }) => f.plans.find((p) => p.id === id) }; } },
    '@whop/sdk/helpers': { unwrapWebhook: () => ({ type: 'payment.succeeded', data: { id: f.payment.id } }) },
    '@/lib/paid-lead-order': orders, '@/lib/lead-cart': cartLib,
    '@/lib/paid-order-store': { recordPaidOrder: async (order) => { stored = order; } },
    '@/lib/slack-order-delivery': { deliverSlackOrder: async () => 'sent' },
  }, { process: { env: { WHOP_WEBHOOK_SECRET: 'test', WHOP_ACCOUNT_ID: 'biz_test', WHOP_LEADS_PRODUCT_ID: 'prod_test', WHOP_API_KEY: 'test' } }, console: { error: () => {} } });
  const response = await route.POST(new Request('https://example.com/api/webhooks/whop', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 200);
  assert.equal(stored.items.length, 3); assert.equal(stored.quantity, 18);
});
