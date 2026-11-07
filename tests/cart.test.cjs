const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript: load } = require('./load-ts.cjs');
const plain = (value) => JSON.parse(JSON.stringify(value));
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
  const bank = cartLib.calculateCartQuote(order, undefined, 'bank');
  assert.deepEqual(plain(bank.lines.map((l) => [l.state, l.leadCount, l.amountCents])), [['TX', 10, 500000], ['AL', 5, 162500], ['VT', 3, 30000]]);
  assert.equal(bank.leadCount, 18); assert.equal(bank.amountCents, 692500); assert.equal(bank.feeCents, 0); assert.equal(bank.total, 6925);
  const card = cartLib.calculateCartQuote(order, undefined, 'card');
  assert.equal(card.feeCents, Math.round(692500 * 270 / 10000)); assert.equal(card.totalCents, 692500 + card.feeCents);
  // AL and AK are $325 each: 2.7% of $650 is $17.55, while rounding each state ($8.775) would give $17.56.
  const pair = [{ state: 'AL', quantity: 1 }, { state: 'AK', quantity: 1 }];
  const perState = pair.map((item) => cartLib.calculateCartQuote([item], undefined, 'card').feeCents).reduce((a, b) => a + b, 0);
  assert.equal(cartLib.calculateCartQuote(pair, undefined, 'card').feeCents, 1755); assert.equal(perState, 1756);
});

test('cart rejects empty, duplicate, oversized, sold-out and malformed orders', () => {
  assert.throws(() => cartLib.calculateCartQuote([]), /at least one state/);
  assert.throws(() => cartLib.calculateCartQuote('TX'), /at least one state/);
  assert.throws(() => cartLib.calculateCartQuote([{ state: 'TX', quantity: 1 }, { state: 'TX', quantity: 2 }]), /already in your order/);
  assert.throws(() => cartLib.calculateCartQuote([{ state: 'CA', quantity: 1 }]), /sold out/);
  assert.throws(() => cartLib.calculateCartQuote([{ state: 'TX', quantity: 0 }]), /whole number/);
  assert.throws(() => cartLib.calculateCartQuote([{ state: 'TX', quantity: 1001 }]), /maximum/);
  assert.throws(() => cartLib.calculateCartQuote([null]), /valid state/);
  const fifty = pricing.LEAD_STATES.filter((s) => s.price !== null).map((s) => ({ state: s.code, quantity: 1 }));
  assert.equal(fifty.length, 49);
  assert.equal(cartLib.calculateCartQuote(fifty).lines.length, 49);
  assert.throws(() => cartLib.calculateCartQuote([...fifty, { state: 'TX', quantity: 1 }]), /up to 49 states/);
});

test('requests accept a list of items or the original single state, never both', () => {
  assert.deepEqual(plain(cartLib.requestedCartItems({ items: order })), order);
  assert.deepEqual(plain(cartLib.requestedCartItems({ state: 'TX', quantity: 4 })), [{ state: 'TX', quantity: 4 }]);
  assert.throws(() => cartLib.requestedCartItems({ items: order, state: 'TX' }), /not both/);
});

test('checkout uses one quantity line per state and one card fee line for the whole order', async () => {
  const w = whop();
  const cart = cartLib.calculateCartQuote(order, undefined, 'card');
  const checkout = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', cart);
  assert.equal(w.lists, 1, 'plans are listed once per checkout');
  assert.equal(checkout.items.length, 4);
  assert.deepEqual(plain(checkout.items.slice(0, 3).map((item) => item.quantity)), [10, 5, 3]);
  assert.deepEqual(plain(checkout.items.slice(0, 3).map((item) => w.plans.find((p) => p.id === item.plan).metadata.state)), ['TX', 'AL', 'VT']);
  const fee = w.plans.find((p) => p.id === checkout.feePlanId);
  assert.equal(checkout.items[3].plan, fee.id); assert.equal(checkout.items[3].quantity, 1);
  assert.equal(fee.initial_price, cart.fee); assert.equal(fee.metadata.fee_scope, 'order'); assert.equal(fee.metadata.state, undefined);
  assert.equal(fee.title, 'Card fee (2.7%)');

  // A second order reuses each state's plan; a matching fee amount reuses the fee item.
  const again = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', cart);
  assert.deepEqual(plain(again.items), plain(checkout.items)); assert.equal(w.plans.length, 4);
  const single = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', cartLib.calculateCartQuote([{ state: 'TX', quantity: 2 }], undefined, 'bank'));
  assert.equal(single.items.length, 1); assert.equal(single.feePlanId, null);
  assert.notEqual(single.items[0].plan, checkout.items[0].plan, 'Wire & ACH and Card keep separate state plans');
});

test('a changed price reprices that state plan inside a cart checkout', async () => {
  const w = whop();
  await native.getCartCheckout(w.client, 'biz_test', 'prod_test', cartLib.calculateCartQuote(order, undefined, 'bank'));
  const rates = pricing.LEAD_STATES.map((s) => s.code === 'AL' ? { ...s, price: 410 } : s);
  const next = await native.getCartCheckout(w.client, 'biz_test', 'prod_test', cartLib.calculateCartQuote(order, rates, 'bank'));
  assert.equal(w.updates.length, 1); assert.equal(w.plans.length, 3);
  assert.equal(w.plans.find((p) => p.id === next.items[1].plan).initial_price, 410);
});

async function paidCart(mode = 'card', items = order) {
  const w = whop();
  const cart = cartLib.calculateCartQuote(items, undefined, mode);
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
    assert.deepEqual(plain(o.items), [{ state: 'TX', stateName: 'Texas', quantity: 10 }, { state: 'AL', stateName: 'Alabama', quantity: 5 }, { state: 'VT', stateName: 'Vermont', quantity: 3 }]);
    assert.equal(o.quantity, 18); assert.equal(o.orderTotalUsd, f.cart.total); assert.equal(o.paymentMode, mode);
    const text = orders.slackOrderMessage(o).text;
    assert.match(text, /States:\n• Texas \(TX\): 10 leads\n• Alabama \(AL\): 5 leads\n• Vermont \(VT\): 3 leads\nTotal leads: 18/);
  }
  const one = await paidCart('bank', [{ state: 'TX', quantity: 1 }]);
  assert.match(orders.slackOrderMessage(orders.paidLeadOrder(one.payment, one.plans, 'biz_test', 'prod_test')).text, /State: Texas \(TX\)\nLeads: 1\n/);
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
  const feePlan = { ...leadPlan, id: 'plan_fee', allow_multiple_quantity: false, initial_price: 43.88, metadata: native.leadItemMetadata(quote, false, 'card_fee') };
  const payment = { id: 'pay_old', status: 'paid', paid_at: '2026-11-04T00:00:00Z', account_id: 'biz_test', currency: 'usd',
    line_items: [{ plan_id: 'plan_lead', product_id: 'prod_test', quantity: 5, subtotal: { amount: '1625.00', currency: 'usd' } }, { plan_id: 'plan_fee', product_id: 'prod_test', quantity: 1, subtotal: { amount: '43.88', currency: 'usd' } }] };
  const o = orders.paidLeadOrder(payment, [leadPlan, feePlan], 'biz_test', 'prod_test');
  assert.deepEqual(plain(o.items), [{ state: 'AL', stateName: 'Alabama', quantity: 5 }]); assert.equal(o.orderTotalUsd, 1668.88);
  assert.equal(w.plans.length, 0);
});
