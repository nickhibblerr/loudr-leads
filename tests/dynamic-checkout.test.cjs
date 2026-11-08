const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./load-ts.cjs');

const pricing = loadTypeScript('lib/top-up.ts');
const preferences = loadTypeScript('lib/payment-methods.ts');
const realLeads = loadTypeScript('lib/lead-pricing.ts', { '@/lib/top-up': pricing, '@/lib/payment-methods': preferences });
// These route tests cover caching, pricing and tampering with small orders; the 50-lead minimum has its own tests.
const leads = { ...realLeads, MIN_LEAD_QUANTITY: 1 };
const cartLib=loadTypeScript('lib/lead-cart.ts',{'@/lib/lead-pricing':leads,'@/lib/payment-methods':preferences});
const planHelpers = loadTypeScript('lib/whop-plans.ts', {
  '@/lib/top-up': pricing,
  '@/lib/lead-pricing': leads, '@/lib/lead-cart': cartLib,
  '@/lib/payment-methods': preferences,
});
const checkoutHelpers = loadTypeScript('lib/lead-checkout.ts', { '@/lib/payment-methods': preferences, '@/lib/lead-cart': cartLib });
const env = {
  WHOP_API_KEY: 'test-key', WHOP_ACCOUNT_ID: 'biz_test',
  WHOP_LEADS_PRODUCT_ID: 'prod_test', NEXT_PUBLIC_SITE_URL: 'https://example.com',
};
const request = (body) => new Request('https://example.com/api/test', {
  method: 'POST', body: JSON.stringify(body),
});
const paymentRequest = (checkout, extra = {}) => request({
  state: checkout.quote.state, quantity: checkout.quote.leadCount, paymentMode: checkout.quote.paymentMode, forceUsd: checkout.forceUsd,
  priceVersion: checkout.priceVersion, planId: checkout.planId,
  confirmationToken: checkout.quote.paymentMode === 'card' ? 'ctok_card' : 'ctok_test', orderId: 'leads_test', ...extra,
});

function harness() {
  let card = { version: 'initial', updatedAt: null, states: leads.LEAD_STATES.map((state) => ({ ...state })) };
  let storageError = false;
  let version = 0;
  const calls = { clients: 0, reads: 0, lists: 0, creates: [], updates: [], confirmations: 0, retrieves: 0, payments: [] };
  const savedPlans = [];
  const client = {
    plans: {
      list: async () => { calls.lists++; return savedPlans; },
      create: async (input, options) => {
        calls.creates.push({ input, options });
        const plan = { ...input, ...options.additionalBodyParameters, id: `plan_${savedPlans.length + 1}`, account: { id: input.account_id }, product: { id: input.product_id } };
        savedPlans.push(plan);
        return plan;
      },
      update: async ({ id, ...changes }) => {
        calls.updates.push({ id, ...changes });
        const plan = savedPlans.find((item) => item.id === id);
        Object.assign(plan, changes);
        return plan;
      },
      retrieve: async ({ id }) => { calls.retrieves++; return savedPlans.find((plan) => plan.id === id); },
    },
    confirmationTokens: { retrieve: async ({ id }) => { calls.confirmations++; return { status: 'pending', payment_method_preview: { type: id === 'ctok_card' ? 'card' : 'bank_wire' } }; } },
    payments: { create: async (input) => { calls.payments.push(input); return { id: 'pay_test', status: 'pending' }; } },
  };
  const dependencies = {
    '@/lib/lead-pricing': leads, '@/lib/lead-cart': cartLib, '@/lib/payment-methods': preferences,
    '@/lib/whop-plans': planHelpers, '@/lib/lead-checkout': checkoutHelpers,
    '@/lib/pricing-store': {
      readRateCard: async () => {
        calls.reads++;
        if (storageError) throw new Error('Storage unavailable.');
        return card;
      },
    },
    '@whop/sdk': { WhopClient: class { constructor() { calls.clients++; return client; } } },
    'next/cache': {
      // Match unstable_cache's relevant contract: the wrapper memoizes by arguments,
      // including the serialized quote, rather than simply executing the callback.
      unstable_cache: (fn, keyParts) => {
        const cache = new Map();
        return async (...args) => {
          const key = JSON.stringify([keyParts, args]);
          if (!cache.has(key)) {
            const result = Promise.resolve(fn(...args));
            cache.set(key, result);
            result.catch(() => cache.delete(key));
          }
          return cache.get(key);
        };
      },
    },
  };
  const globals = { process: { env } };
  return {
    checkout: loadTypeScript('app/api/checkout/route.ts', dependencies, globals).POST,
    pay: loadTypeScript('app/api/pay/route.ts', dependencies, globals).POST,
    calls, savedPlans,
    get card() { return card; },
    setPrice(code, price) {
      card = { version: `saved-${++version}`, updatedAt: '2026-10-30T00:00:00.000Z',
        states: card.states.map((state) => state.code === code ? { ...state, price } : state) };
    },
    failStorage() { storageError = true; },
  };
}

async function checkout(h, state = 'TX', quantity = 2, extra = {}) {
  const response = await h.checkout(request({ state, quantity, ...extra }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

test('saved rates override defaults in checkout and payment metadata using integer cents', async () => {
  const h = harness();
  h.setPrice('TX', 19.99);
  const order = await checkout(h, 'TX', 3, { priceVersion: h.card.version, unitPrice: 1, total: 1 });
  assert.equal(order.quote.unitPrice, 19.99);
  assert.equal(order.quote.totalCents, 5997);
  assert.equal(order.quote.total, 59.97);
  assert.equal(order.priceVersion, 'saved-1');
  assert.equal(h.calls.creates[0].input.initial_price, 19.99);
  assert.equal((await h.pay(paymentRequest(order, { total: 1, unitPrice: 1 }))).status, 200);
  assert.equal(h.calls.payments[0].metadata.price_per_lead, '19.99');
  assert.equal(h.calls.payments[0].metadata.total_amount, '59.97');
  assert.equal(h.calls.payments[0].metadata.quantity, '3');

  h.setPrice('TX', 0.29);
  const smallOrder = await checkout(h, 'TX', 7);
  assert.equal(smallOrder.quote.totalCents, 203);
  assert.equal(smallOrder.quote.total, 2.03);
});

test('a price change reprices the state plan in place and stale quotes cannot be charged', async () => {
  const h = harness();
  let previous = await checkout(h);
  assert.equal(previous.quote.total, 1000);
  assert.equal((await checkout(h)).planId, previous.planId);
  assert.equal(h.calls.lists, 1, 'identical requests should reuse the cached result');

  for (const price of [625, 375]) {
    h.setPrice('TX', price);
    const current = await checkout(h);
    assert.equal(current.planId, previous.planId, 'the state keeps one lead plan');
    assert.equal(current.quote.unitPrice, price);
    assert.equal(current.quote.total, price * 2);
    assert.equal(h.savedPlans.find((plan) => plan.id === current.planId).initial_price, price);
    assert.equal(h.savedPlans.find((plan) => plan.id === current.planId).metadata.price_per_lead, String(price));
    assert.equal((await checkout(h)).planId, current.planId);
    const paymentCount = h.calls.payments.length;
    const stale = await h.pay(paymentRequest(previous));
    assert.equal(stale.status, 409, 'a quote made at the old price must be re-confirmed');
    assert.equal(h.calls.payments.length, paymentCount, 'stale quotes must never create a payment');
    assert.equal((await h.pay(paymentRequest(current))).status, 200);
    previous = current;
  }
  assert.equal(h.calls.creates.length, 1, 'price changes must not add plans');
  assert.equal(h.calls.updates.length, 2);
});
test('unit plans remain specific to state and reuse the same price for different quantities', async () => {
  const h = harness();
  const alabama = await checkout(h, 'AL', 1);
  const alaska = await checkout(h, 'AK', 1);
  const doubled = await checkout(h, 'AL', 2);
  assert.notEqual(alabama.planId, alaska.planId);
  assert.equal(alabama.planId, doubled.planId);
  assert.equal(doubled.items[0].quantity, 2);
  assert.equal(alabama.quote.total, alaska.quote.total);
  assert.equal((await checkout(h, 'AL', 1)).planId, alabama.planId);
  assert.equal(h.calls.lists, 3);
  assert.equal((await h.pay(paymentRequest(alabama, { state: 'AK' }))).status, 400);
  assert.equal(h.calls.payments.length, 0);
});

test('a saved sold-out state blocks checkout and an existing plan before any Whop call', async () => {
  const h = harness();
  const oldOrder = await checkout(h);
  h.setPrice('TX', null);
  const clientCount = h.calls.clients;
  assert.equal((await h.checkout(request({ state: 'TX', quantity: 2 }))).status, 400);
  assert.equal((await h.pay(paymentRequest(oldOrder, { priceVersion: h.card.version }))).status, 400);
  assert.equal(h.calls.clients, clientCount);
  assert.equal(h.calls.payments.length, 0);
  h.setPrice('CA', 450);
  const available = await checkout(h, 'CA', 1);
  assert.equal(available.quote.total, 450, 'admin can make an initially sold-out state available');
});

test('stale price versions return 409 before Whop and checkout returns the current card', async () => {
  const h = harness();
  const oldOrder = await checkout(h);
  h.setPrice('TX', 550);
  const clientCount = h.calls.clients;
  const checkoutResponse = await h.checkout(request({ state: 'TX', quantity: 2, priceVersion: oldOrder.priceVersion }));
  assert.equal(checkoutResponse.status, 409);
  assert.equal(checkoutResponse.headers.get('cache-control'), 'no-store');
  const body = await checkoutResponse.json();
  assert.equal(body.rateCard.version, h.card.version);
  assert.equal(body.rateCard.states.find((state) => state.code === 'TX').price, 550);
  assert.equal((await h.pay(paymentRequest(oldOrder))).status, 409);
  assert.equal(h.calls.clients, clientCount);
  assert.equal(h.calls.payments.length, 0);
});

test('storage errors fail both endpoints closed even when a plan was cached earlier', async () => {
  const h = harness();
  const order = await checkout(h);
  h.failStorage();
  const clientCount = h.calls.clients;
  for (const response of [
    await h.checkout(request({ state: 'TX', quantity: 2 })),
    await h.pay(paymentRequest(order)),
  ]) {
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Pricing is temporarily unavailable/);
  }
  assert.equal(h.calls.clients, clientCount);
  assert.equal(h.calls.payments.length, 0);
  assert.equal(h.calls.reads, 3, 'checkout must read current prices even when its plan ID was cached');
});

test('invalid saved monetary values cannot reach plan creation or payment', async () => {
  for (const price of [0, -1, 1.005, 10000.01, Infinity, NaN]) {
    const h = harness();
    h.setPrice('TX', price);
    assert.equal((await h.checkout(request({ state: 'TX', quantity: 2 }))).status, 400);
    assert.equal((await h.pay(request({ state: 'TX', quantity: 2, confirmationToken: 'ctok_test', orderId: 'leads_test', planId: 'plan_test' }))).status, 400);
    assert.equal(h.calls.clients, 0);
  }
});

test('card and bank cached plans remain distinct and preserve current saved rates', async () => {
  const h = harness();
  h.setPrice('TX', 19.99);
  const bank = await checkout(h, 'TX', 3, { paymentMode: 'bank' });
  const card = await checkout(h, 'TX', 3, { paymentMode: 'card', feePercent: 0, total: 1 });
  assert.equal(bank.quote.totalCents, 5997);
  assert.equal(card.quote.amountCents, 5997);
  assert.equal(card.quote.feeCents, 180);
  assert.equal(card.quote.totalCents, 6177);
  assert.notEqual(bank.planId, card.planId);
  assert.equal((await checkout(h, 'TX', 3, { paymentMode: 'card' })).planId, card.planId);
  assert.equal((await checkout(h, 'TX', 3, { paymentMode: 'bank' })).planId, bank.planId);
  assert.equal(h.calls.creates.length, 3);
  assert.equal((await h.pay(paymentRequest(card, { paymentMode: 'bank' }))).status, 400);
  assert.equal((await h.pay(paymentRequest(bank, { paymentMode: 'card' }))).status, 400);
  assert.equal(h.calls.payments.length, 0);
  assert.equal((await h.pay(paymentRequest(card))).status, 200);
  assert.equal(h.calls.payments[0].metadata.total_amount, '61.77');
  h.setPrice('TX', 25.5);
  const changed = await checkout(h, 'TX', 3, { paymentMode: 'card' });
  assert.equal(changed.quote.amountCents, 7650);
  assert.equal(changed.quote.feeCents, 230);
  assert.equal(changed.quote.totalCents, 7880);
  assert.equal(changed.planId, card.planId, 'the card plan is repriced, not replaced');
  assert.equal(h.savedPlans.find((plan) => plan.id === card.planId).initial_price, 25.5);
  assert.equal((await h.pay(paymentRequest(card))).status, 409);
});

test('zero rounded surcharge still separates plans; every checkout is USD whatever is requested', async () => {
  const h = harness();
  h.setPrice('TX', 0.01);
  const orders = [];
  for (const paymentMode of ['bank', 'card']) {
    for (const forceUsd of [false, true]) {
      const order = await checkout(h, 'TX', 1, { paymentMode, forceUsd });
      orders.push(order);
      assert.equal(order.quote.totalCents, 1);
      assert.equal(order.quote.paymentMode, paymentMode);
      assert.equal(order.forceUsd, true, 'adaptive pricing is never enabled');
      assert.equal((await h.pay(paymentRequest(order))).status, 200);
    }
  }
  assert.equal(new Set(orders.map((order) => order.planId)).size, 2, 'one USD plan per payment method');
  assert(h.savedPlans.every((plan) => plan.adaptive_pricing_enabled === false));
  assert.equal(new Set(h.calls.creates.map(({ options }) => options.idempotencyKey)).size, 2);
  assert.equal(h.calls.payments.length, 4);
  assert.equal((await h.pay(paymentRequest(orders[0], { paymentMode: 'card', confirmationToken: 'ctok_card' }))).status, 400);
  assert.equal(h.calls.payments.length, 4);
});

test('checkout accepts a multi-state order and prices it from saved rates', async () => {
  const h = harness();
  h.setPrice('AL', 410);
  const items = [{ state: 'TX', quantity: 10 }, { state: 'AL', quantity: 3 }];
  const response = await h.checkout(request({ items, paymentMode: 'card', priceVersion: h.card.version, total: 1 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.quote, undefined, 'the single-state quote is only returned for one-state orders');
  assert.deepEqual(body.cart.lines.map((line) => [line.state, line.leadCount, line.unitPrice]), [['TX', 10, 500], ['AL', 3, 410]]);
  assert.equal(body.cart.amountCents, 623000); assert.equal(body.cart.feeCents, 18690); assert.equal(body.cart.totalCents, 641690);
  assert.equal(body.items.length, 3);
  assert.deepEqual(body.items.map((item) => item.quantity), [10, 3, 1]);
  assert.equal(body.items[2].plan, body.feePlanId);
  for (const bad of [[{ state: 'TX', quantity: 1 }, { state: 'TX', quantity: 2 }], [{ state: 'CA', quantity: 1 }], [], [{ state: 'TX', quantity: 0 }]]) {
    assert.equal((await h.checkout(request({ items: bad, priceVersion: h.card.version }))).status, 400);
  }
  assert.equal((await h.checkout(request({ items, state: 'TX' }))).status, 400);
  const stale = await h.checkout(request({ items, priceVersion: 'saved-0' }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).rateCard.version, h.card.version);
});

test('checkout refuses any state below the 50-lead minimum', async () => {
  const strict = { ...harness() };
  const route = loadTypeScript('app/api/checkout/route.ts', {
    '@/lib/lead-pricing': realLeads, '@/lib/lead-cart': loadTypeScript('lib/lead-cart.ts', { '@/lib/lead-pricing': realLeads, '@/lib/payment-methods': preferences }),
    '@/lib/payment-methods': preferences, '@/lib/lead-checkout': { getCartCheckout: async () => { throw new Error('Whop must not be called'); } },
    '@/lib/pricing-store': { readRateCard: async () => strict.card }, '@whop/sdk': { WhopClient: class {} },
    'next/cache': { unstable_cache: (fn) => fn },
  }, { process: { env: { WHOP_API_KEY: 'test', WHOP_ACCOUNT_ID: 'biz_test', WHOP_LEADS_PRODUCT_ID: 'prod_test' } } }).POST;
  for (const body of [{ state: 'TX', quantity: 49 }, { items: [{ state: 'TX', quantity: 50 }, { state: 'AL', quantity: 20 }] }]) {
    const response = await route(request(body));
    assert.equal(response.status, 400, 'the exact message is checked in the cart tests');
  }
});
