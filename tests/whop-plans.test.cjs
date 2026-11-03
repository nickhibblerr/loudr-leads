const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./load-ts.cjs');
const pricing = loadTypeScript('lib/top-up.ts');
const preferences = loadTypeScript('lib/payment-methods.ts');
const leads = loadTypeScript('lib/lead-pricing.ts', { '@/lib/top-up': pricing, '@/lib/payment-methods': preferences });
const { getTopUpPlan, isTopUpPlanForAmount } = loadTypeScript('lib/whop-plans.ts', {
  '@/lib/payment-methods': preferences, '@/lib/top-up': pricing, '@/lib/lead-pricing': leads,
});
function planFor(quote, changes = {}) {
  return { id: 'plan_existing', account: { id: 'biz_test' }, product: { id: 'prod_test' },
    currency: quote.currency, initial_price: quote.total, adaptive_pricing_enabled: quote.paymentMode !== 'bank', plan_type: 'one_time', visibility: 'quick_link',
    metadata: pricing.topUpMetadata(quote), payment_method_configuration: preferences.topUpPaymentConfiguration, ...changes };
}
function mockClient(items) {
  const calls = [];
  return { calls, plans: {
    async list(request) { calls.push(['list', request]); return { async *[Symbol.asyncIterator]() { yield* items; } }; },
    async update(request) { calls.push(['update', request]); return { id: request.id }; },
    async create(request, options) { calls.push(['create', request, options]); return { id: 'plan_new' }; },
  } };
}
test('reuses the exact fee-inclusive plan with transfer-only preferences', async () => {
  const quote = pricing.calculateTopUp(2500, 2.5);
  const client = mockClient([planFor(quote)]);
  assert.equal((await getTopUpPlan(client, 'biz_test', 'prod_test', quote)).id, 'plan_existing');
  assert.equal(client.calls.length, 1);
  assert.deepEqual(Array.from(client.calls[0][1].product_ids), ['prod_test']);
});
test('repairs method preferences on a matching top-up plan', async () => {
  const quote = pricing.calculateTopUp(2500, 2.5);
  const client = mockClient([planFor(quote, { payment_method_configuration: null })]);
  await getTopUpPlan(client, 'biz_test', 'prod_test', quote);
  assert.equal(client.calls[1][0], 'update');
  assert.deepEqual(Array.from(client.calls[1][1].payment_method_configuration.enabled), ['bank_wire', 'us_bank_account']);
  assert.equal(client.calls[1][1].payment_method_configuration.include_platform_defaults, false);
});
test('creates the marked-up price and keeps fee and ad spend separate in metadata', async () => {
  const quote = pricing.calculateTopUp(1000, 5, 'eur');
  const client = mockClient([]);
  await getTopUpPlan(client, 'biz_test', 'prod_test', quote);
  const [, request, options] = client.calls[1];
  assert.equal(request.initial_price, 1050);
  assert.equal(request.currency, 'eur');
  assert.equal(request.metadata.topup_amount, '1000');
  assert.equal(request.metadata.ad_spend_fee_percent, '5');
  assert.equal(request.metadata.ad_spend_fee_amount, '50');
  assert.equal(request.adaptive_pricing_enabled, true);
  assert.equal(options.idempotencyKey, 'unlimited-scaling-topup-eur-100000-500-adaptive-v5');
});
test('does not reuse another fee or currency even at the same total', async () => {
  const quote = pricing.calculateTopUp(1000, 5);
  const client = mockClient([
    planFor(quote, { currency: 'eur' }),
    planFor(quote, { metadata: { ...pricing.topUpMetadata(quote), ad_spend_fee_percent: '2.5' } }),
    planFor(quote, { metadata: { ...pricing.topUpMetadata(quote), topup_amount: '1024.39' } }),
    planFor(quote, { initial_price: 1000 }),
  ]);
  await getTopUpPlan(client, 'biz_test', 'prod_test', quote);
  assert.equal(client.calls[1][0], 'create');
});
test('searches all returned plans before creating one', async () => {
  const quote = pricing.calculateTopUp(10000, 2.5);
  const client = mockClient([planFor(pricing.calculateTopUp(5000, 2.5)), planFor(quote)]);
  assert.equal((await getTopUpPlan(client, 'biz_test', 'prod_test', quote)).id, 'plan_existing');
  assert.equal(client.calls.length, 1);
});
test('charging rejects an old business, wrong price, fee metadata or card-enabled plan', () => {
  const quote = pricing.calculateTopUp(1000, 2.5);
  const plan = planFor(quote);
  assert.equal(isTopUpPlanForAmount(plan, 'biz_test', 'prod_test', quote), true);
  for (const change of [
    { account: { id: 'biz_other' } }, { product: { id: 'prod_other' } }, { currency: 'eur' },
    { initial_price: 1000 }, { plan_type: 'renewal' }, { visibility: 'archived' }, { adaptive_pricing_enabled: false },
    { metadata: { ...plan.metadata, ad_spend_fee_percent: '5' } },
    { metadata: { ...plan.metadata, ad_spend_fee_amount: '0' } },
    { payment_method_configuration: { ...preferences.topUpPaymentConfiguration, enabled: ['card'] } },
  ]) assert.equal(isTopUpPlanForAmount({ ...plan, ...change }, 'biz_test', 'prod_test', quote), false);
});

test('Make USD creates a separate non-adaptive plan instead of changing the adaptive plan', async () => {
  const quote = pricing.calculateTopUp(10000, 2.5);
  const client = mockClient([planFor(quote)]);
  await getTopUpPlan(client, 'biz_test', 'prod_test', quote, true);
  assert.equal(client.calls[1][0], 'create');
  assert.equal(client.calls[1][1].currency, 'usd');
  assert.equal(client.calls[1][1].initial_price, 10250);
  assert.equal(client.calls[1][1].adaptive_pricing_enabled, false);
  assert.equal(client.calls[1][1].metadata.pricing_mode, 'forced_usd');
  assert.match(client.calls[1][2].idempotencyKey, /-usd-v5$/);
});
test('forced USD plans can be reused only for the forced USD mode', async () => {
  const quote = pricing.calculateTopUp(10000, 2.5);
  const forced = planFor(quote, { adaptive_pricing_enabled: false, metadata: pricing.topUpMetadata(quote, true) });
  assert.equal(isTopUpPlanForAmount(forced, 'biz_test', 'prod_test', quote, true), true);
  assert.equal(isTopUpPlanForAmount(forced, 'biz_test', 'prod_test', quote), false);
  const client = mockClient([forced]);
  assert.equal((await getTopUpPlan(client, 'biz_test', 'prod_test', quote, true)).id, forced.id);
  assert.equal(client.calls.length, 1);
});

test('lead plans separate state/count identities at equal totals and preserve server-authored metadata', async () => {
  const quote = leads.calculateLeadQuote('TX', 1);
  const other = leads.calculateLeadQuote('HI', 5);
  const wrongOrder = planFor(other, { metadata: leads.leadMetadata(other) });
  const oldTopup = planFor(quote);
  const client = mockClient([wrongOrder, oldTopup]);
  await getTopUpPlan(client, 'biz_test', 'prod_test', quote);
  assert.equal(client.calls[1][0], 'create');
  const created = client.calls[1][1];
  assert.equal(created.metadata.source, 'loudr-leads-site');
  assert.equal(created.metadata.state, 'TX');
  assert.equal(created.metadata.quantity, '1');
  assert.equal(created.metadata.price_per_lead, '500');
  assert.match(client.calls[1][2].idempotencyKey, /loudr-leads-biz_test-prod_test-bank-TX-1-500/);
  assert.equal(isTopUpPlanForAmount(wrongOrder, 'biz_test', 'prod_test', quote), false);
  const matching = planFor(quote, { metadata: leads.leadMetadata(quote) });
  assert.equal(isTopUpPlanForAmount(matching, 'biz_test', 'prod_test', quote), true);
  const reuse = mockClient([matching]);
  assert.equal((await getTopUpPlan(reuse, 'biz_test', 'prod_test', quote)).id, 'plan_existing');
});


test('lead plan lookup ignores wrong merchant or product and never repairs a legacy top-up plan', async () => {
  const quote = leads.calculateLeadQuote('TX', 1);
  const metadata = leads.leadMetadata(quote);
  const client = mockClient([
    planFor(quote, { account: { id: 'biz_other' }, metadata }),
    planFor(quote, { product: { id: 'prod_other' }, metadata }),
    planFor(quote),
  ]);
  await getTopUpPlan(client, 'biz_test', 'prod_test', quote);
  assert.equal(client.calls[1][0], 'create');
  assert.equal(client.calls[1][1].initial_price, 500);
  assert.equal(client.calls[1][1].metadata.ad_spend_fee_percent, undefined);
});

test('lead checkout creates and repairs only the selected payment-method configuration', async () => {
  for (const [mode, enabled] of [['bank', ['bank_wire', 'us_bank_account']], ['card', ['card']]]) {
    const quote = leads.calculateLeadQuote('TX', 2, undefined, mode);
    const client = mockClient([]);
    await getTopUpPlan(client, 'biz_test', 'prod_test', quote);
    const created = client.calls[1][1];
    const config = created.payment_method_configuration;
    assert.deepEqual(Array.from(config.enabled), enabled);
    assert.equal(config.include_platform_defaults, false);
    for (const unwanted of ['card', 'bank_wire', 'us_bank_account', 'sepa_debit', 'eu_bank_transfer', 'crypto', 'us_bank_transfer'].filter((method) => !enabled.includes(method))) {
      assert(config.disabled.includes(unwanted), `${mode} must disable ${unwanted}`);
    }
    assert.equal(created.initial_price, mode === 'card' ? 1027 : 1000);
    assert.equal(created.metadata.payment_mode, mode);
    const good = planFor(quote, { metadata: leads.leadMetadata(quote), payment_method_configuration: config });
    assert.equal(isTopUpPlanForAmount(good, 'biz_test', 'prod_test', quote), true);
    for (const unsafe of [null, { ...config, include_platform_defaults: true }, { ...config, enabled: [...config.enabled, mode === 'card' ? 'bank_wire' : 'card'] }]) {
      const broken = { ...good, payment_method_configuration: unsafe };
      assert.equal(isTopUpPlanForAmount(broken, 'biz_test', 'prod_test', quote), false);
      const repair = mockClient([broken]);
      await getTopUpPlan(repair, 'biz_test', 'prod_test', quote);
      assert.equal(repair.calls[1][0], 'update');
      assert.deepEqual(Array.from(repair.calls[1][1].payment_method_configuration.enabled), enabled);
    }
  }
});

test('bank and card plans never reuse or repair each other even at equal rounded totals', async () => {
  const rates = leads.LEAD_STATES.map((state) => state.code === 'TX' ? { ...state, price: 0.01 } : state);
  const quotes = ['bank', 'card'].map((mode) => leads.calculateLeadQuote('TX', 1, rates, mode));
  const keys = [];
  assert.equal(quotes[0].totalCents, quotes[1].totalCents);
  for (const [index, quote] of quotes.entries()) {
    const other = quotes[1 - index];
    const wrong = planFor(other, { metadata: leads.leadMetadata(other), payment_method_configuration: preferences.paymentConfigurationFor(other.paymentMode) });
    assert.equal(isTopUpPlanForAmount(wrong, 'biz_test', 'prod_test', quote), false);
    const client = mockClient([wrong]);
    await getTopUpPlan(client, 'biz_test', 'prod_test', quote);
    assert.equal(client.calls[1][0], 'create', 'the other payment path must remain unchanged');
    keys.push(client.calls[1][2].idempotencyKey);
  }
  assert.notEqual(keys[0], keys[1]);
});

test('Make USD preserves card-only methods and the exact 2.7% card total', async () => {
  const quote = leads.calculateLeadQuote('TX', 2, undefined, 'card');
  const adaptive = planFor(quote, { metadata: leads.leadMetadata(quote), payment_method_configuration: preferences.paymentConfigurationFor('card') });
  const client = mockClient([adaptive]);
  await getTopUpPlan(client, 'biz_test', 'prod_test', quote, true);
  const created = client.calls[1][1];
  assert.equal(client.calls[1][0], 'create');
  assert.equal(created.initial_price, 1027);
  assert.equal(created.adaptive_pricing_enabled, false);
  assert.deepEqual(Array.from(created.payment_method_configuration.enabled), ['card']);
  assert.equal(created.metadata.payment_mode, 'card');
  assert.equal(created.metadata.pricing_mode, 'forced_usd');
});
