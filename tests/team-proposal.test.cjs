const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const nodeCrypto = require('node:crypto');
const { loadTypeScript: load } = require('./load-ts.cjs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const methods = load('lib/payment-methods.ts');
const topup = load('lib/top-up.ts');
const pricing = load('lib/lead-pricing.ts', { '@/lib/payment-methods': methods, '@/lib/top-up': topup });
const cartLib = load('lib/lead-cart.ts', { '@/lib/lead-pricing': pricing, '@/lib/payment-methods': methods });
const team = load('lib/team-proposal.ts', { '@/lib/payment-methods': methods });

const order = [{ state: 'TX', quantity: 50 }, { state: 'AL', quantity: 61 }];
const bank = cartLib.calculateCartQuote(order, undefined, 'bank');
const card = cartLib.calculateCartQuote(order, undefined, 'card');
const client = { firstName: 'Dana', lastName: 'Reyes', email: 'dana@example.com', phone: '', firm: 'Reyes Law' };

test('rep names default to the automation reps and can be configured', () => {
  assert.deepEqual(plain(team.teamRepNames(undefined)), ['Mason Church', 'Jeremiah Iroff', 'Bernardo Morales']);
  assert.deepEqual(plain(team.teamRepNames(' Ana Diaz , Ana Diaz,Ben Lee ,')), ['Ana Diaz', 'Ben Lee']);
  assert.equal(team.validateRep('Ben Lee', ['Ben Lee']), 'Ben Lee');
  assert.throws(() => team.validateRep('Someone', ['Ben Lee']), /rep list/);
});

test('client details need a first name, valid email and firm', () => {
  assert.deepEqual(plain(team.validateClient({ ...client, email: ' Dana@Example.com ' })), { ...client, email: 'dana@example.com' });
  assert.throws(() => team.validateClient({ ...client, firstName: ' ' }), /first name/);
  assert.throws(() => team.validateClient({ ...client, email: 'dana@' }), /email/);
  assert.throws(() => team.validateClient({ ...client, firm: '' }), /law firm/);
  assert.throws(() => team.validateClient({ ...client, phone: 'call me' }), /phone/);
  assert.deepEqual(plain(team.retirePlanIds(['plan_a1', 'plan_a1'])), ['plan_a1']);
  assert.throws(() => team.retirePlanIds(['nope']), /plan IDs/);
});

test('a payment link is a hidden one-time USD plan priced at the whole order total', () => {
  const context = { accountId: 'biz_test', linkId: 'link_1', rep: 'Mason Church', createdBy: 'Closer', client };
  const wire = team.paymentLinkRequest(bank, context);
  assert.equal(wire.account_id, 'biz_test');
  assert.equal(wire.mode, 'payment');
  assert.equal(wire.plan.initial_price, bank.total);
  assert.equal(wire.plan.initial_price, 25000 + 61 * 325);
  assert.equal(wire.plan.plan_type, 'one_time');
  assert.equal(wire.plan.visibility, 'hidden');
  assert.equal(wire.plan.currency, 'usd');
  assert.equal(wire.plan.adaptive_pricing_enabled, false);
  assert.equal(wire.plan.unlimited_stock, true);
  assert.deepEqual(plain(wire.plan.payment_method_configuration.enabled), ['bank_wire']);
  assert.equal(wire.plan.title, '111 MVA Leads Wire');
  assert.equal(wire.metadata.source, team.TEAM_LINK_SOURCE);
  assert.equal(wire.metadata.pay_method, 'wire');
  assert.equal(wire.metadata.items, 'TX:50@500,AL:61@325');
  assert.equal(wire.metadata.leads, '111 (Texas 50, Alabama 61)');
  assert.equal(wire.metadata.total, '$44,825');
  assert.equal(wire.metadata.email, 'dana@example.com');
  const cardLink = team.paymentLinkRequest(card, context);
  assert.equal(cardLink.plan.initial_price, card.total);
  assert.equal(card.total, Math.round(bank.amountCents * 1.03) / 100);
  assert.equal(cardLink.plan.stock, 1);
  assert.equal(cardLink.plan.unlimited_stock, false);
  assert.deepEqual(plain(cardLink.plan.payment_method_configuration.enabled), ['card']);
  assert.equal(cardLink.metadata.pay_method, 'card');
});

test('only a Whop link for exactly this total is shown to a closer', () => {
  const ok = { purchase_url: 'https://whop.com/checkout/plan_abc123', plan: { id: 'plan_abc123', initial_price: bank.total, currency: 'usd', plan_type: 'one_time' } };
  assert.deepEqual(plain(team.checkPaymentLink(ok, bank)), { url: ok.purchase_url, planId: 'plan_abc123' });
  assert.throws(() => team.checkPaymentLink({ ...ok, purchase_url: 'https://evil.example/checkout/x' }, bank), /usable payment link/);
  assert.throws(() => team.checkPaymentLink({ ...ok, plan: { ...ok.plan, initial_price: bank.total + 1 } }, bank), /doesn’t match/);
  assert.throws(() => team.checkPaymentLink({ ...ok, plan: null }, bank), /plan/);
});

function payload(overrides = {}) {
  return team.proposalPayload({ proposalId: 'prop_1', createdAt: '2026-11-14T00:00:00.000Z', rep: 'Mason Church',
    signedIn: { userId: 'user_1', name: 'Mason' }, client, bank, card, priceVersion: 'v1', retirePlanIds: ['plan_old1'],
    siteOrigin: 'https://loudr.example', ...overrides });
}

test('the proposal payload carries the order priced by the site', () => {
  const body = plain(payload());
  assert.equal(body.event, 'loudr.proposal.send');
  assert.equal(body.version, 1);
  assert.deepEqual(body.client, { first_name: 'Dana', last_name: 'Reyes', email: 'dana@example.com', phone: '', firm: 'Reyes Law' });
  assert.deepEqual(body.order.states, [
    { code: 'TX', name: 'Texas', leads: 50, wire_price_per_lead: 500, subtotal: 25000 },
    { code: 'AL', name: 'Alabama', leads: 61, wire_price_per_lead: 325, subtotal: 19825 },
  ]);
  assert.equal(body.order.wire_total, 44825);
  assert.equal(body.order.card_total, card.total);
  assert.equal(body.order.card_fee_percent, 3);
  assert.deepEqual(body.retire_plan_ids, ['plan_old1']);
  assert.throws(() => payload({ card: bank }), /same order/);
});

test('the workflow reply is trusted only when it says sent', () => {
  assert.deepEqual(plain(team.readProposalResult({ sent: true, signing_url: 'https://sendlink.co/documents/v1/abc', card_url: 'https://whop.com/checkout/a', wire_url: 'javascript:alert(1)', card_total: '$25,750' }, 'x@y.co')),
    { sent: true, email: 'x@y.co', signingUrl: 'https://sendlink.co/documents/v1/abc', cardUrl: 'https://whop.com/checkout/a', wireUrl: null, cardTotal: '$25,750', wireTotal: null });
  assert.equal(team.readProposalResult({ sent: 'yes' }, 'x@y.co').sent, false);
  assert.match(team.readProposalResult({ sent: false, error: 'GHL said no' }, 'x@y.co').error, /GHL said no/);
  assert.equal(team.readProposalResult(null, 'x@y.co').sent, false);
});

// ---- Routes ------------------------------------------------------------------------------

const rateCard = { version: 'v1', updatedAt: null, states: pricing.LEAD_STATES.map((s) => ({ ...s })) };
const site = 'https://loudr.example';
function routeDeps({ access = { status: 'authorized', userId: 'user_1', name: 'Mason Church' }, card: currentCard = rateCard } = {}) {
  const adminAuth = {
    getAdminAccess: async () => access,
    requireAdmin: async () => access.status === 'authorized' ? null : Response.json({ error: 'Sign in to access team tools.' }, { status: 401 }),
    checkMutationOrigin: (request, message) => request.headers.get('origin') === site && request.headers.get('content-type') === 'application/json' ? null : Response.json({ error: message }, { status: 403 }),
  };
  const teamRequest = load('lib/team-request.ts', {
    '@/lib/admin-auth': adminAuth, '@/lib/lead-cart': cartLib, '@/lib/pricing-store': { readRateCard: async () => currentCard }, '@/lib/team-proposal': team,
  });
  return teamRequest;
}
const post = (body, headers = {}) => new Request(`${site}/api/team/x`, { method: 'POST', headers: { origin: site, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function linkRoute(options = {}, env = { WHOP_API_KEY: 'key', WHOP_ACCOUNT_ID: 'biz_test' }) {
  const creates = [];
  const client = { checkoutConfigurations: { create: async (input, requestOptions) => {
    creates.push({ input, requestOptions });
    return { purchase_url: 'https://whop.com/checkout/plan_new1', plan: { id: 'plan_new1', initial_price: options.price ?? input.plan.initial_price, currency: 'usd', plan_type: 'one_time' } };
  } } };
  const { POST } = load('app/api/team/payment-link/route.ts', {
    'node:crypto': nodeCrypto, '@whop/sdk': { WhopClient: class { constructor() { return client; } } },
    '@/lib/payment-methods': methods, '@/lib/team-proposal': team, '@/lib/team-request': routeDeps(options),
  }, { process: { env }, console: { error() {} } });
  return { POST, creates };
}

test('generate link prices the order on the server and returns a copyable Whop link', async () => {
  const { POST, creates } = linkRoute();
  const response = await POST(post({ items: [{ state: 'TX', quantity: 50 }], paymentMode: 'card', priceVersion: 'v1', rep: 'Mason Church', client: { email: 'dana@example.com', total: 1 }, total: 1 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.url, 'https://whop.com/checkout/plan_new1');
  assert.equal(body.planId, 'plan_new1');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].input.plan.initial_price, 25750);
  assert.equal(creates[0].input.account_id, 'biz_test');
  assert.equal(creates[0].input.metadata.rep, 'Mason Church');
  assert.match(creates[0].requestOptions.idempotencyKey, /^loudr-team-link_/);
});

test('generate link refuses signed-out users, other origins, stale prices and short orders', async () => {
  assert.equal((await linkRoute({ access: { status: 'unauthenticated' } }).POST(post({ items: order }))).status, 401);
  const crossSite = linkRoute();
  assert.equal((await crossSite.POST(post({ items: order }, { origin: 'https://evil.example' }))).status, 403);
  const stale = await linkRoute().POST(post({ items: order, priceVersion: 'old' }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).rateCard.version, 'v1');
  const short = linkRoute();
  assert.equal((await short.POST(post({ items: [{ state: 'TX', quantity: 10 }] }))).status, 400);
  assert.equal(short.creates.length, 0);
  const mismatch = linkRoute({ price: 1 });
  assert.equal((await mismatch.POST(post({ items: order }))).status, 502);
  assert.equal((await linkRoute({}, {}).POST(post({ items: order }))).status, 503);
});

function proposalRoute({ reply = { sent: true, email: 'dana@example.com', card_url: 'https://whop.com/checkout/c', wire_url: 'https://whop.com/checkout/w', signing_url: 'https://sendlink.co/documents/v1/r', card_total: '$46,170', wire_total: '$44,825' }, status = 200, env, plans = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return new Response(JSON.stringify(reply), { status }); };
  const client = { plans: { retrieve: async ({ id }) => { if (!plans[id]) throw new Error('missing'); return plans[id]; } } };
  const { POST } = load('app/api/team/proposal/route.ts', {
    'node:crypto': nodeCrypto, '@whop/sdk': { WhopClient: class { constructor() { return client; } } },
    '@/lib/admin-session': { getAuthConfig: () => ({ siteOrigin: site }) }, '@/lib/team-proposal': team, '@/lib/team-request': routeDeps(),
  }, { process: { env: env ?? { N8N_PROPOSAL_WEBHOOK_URL: 'https://n8n.example/webhook/loudr-website-proposal', N8N_PROPOSAL_WEBHOOK_SECRET: 's'.repeat(32), WHOP_API_KEY: 'key', WHOP_ACCOUNT_ID: 'biz_test', NODE_ENV: 'production' } }, fetch, AbortSignal, console: { error() {} } });
  return { POST, calls };
}
const proposalBody = { items: order, priceVersion: 'v1', rep: 'Mason Church', client, retirePlanIds: ['plan_team1', 'plan_other'] };

test('send proposal posts the priced order to n8n with the shared secret and returns the links', async () => {
  const { POST, calls } = proposalRoute({ plans: {
    plan_team1: { id: 'plan_team1', account: { id: 'biz_test' }, metadata: { source: 'loudr-team-link' } },
    plan_other: { id: 'plan_other', account: { id: 'biz_test' }, metadata: { source: 'loudr-leads-site' } },
  } });
  const response = await POST(post({ ...proposalBody, total: 1 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sent, true);
  assert.equal(body.signingUrl, 'https://sendlink.co/documents/v1/r');
  assert.equal(body.cardUrl, 'https://whop.com/checkout/c');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://n8n.example/webhook/loudr-website-proposal');
  assert.equal(calls[0].init.headers['X-Loudr-Secret'], 's'.repeat(32));
  assert.equal(calls[0].body.order.wire_total, 44825);
  assert.equal(calls[0].body.rep.whop_user_id, 'user_1');
  // Only links this site generated for the team are passed on to be retired.
  assert.deepEqual(calls[0].body.retire_plan_ids, ['plan_team1']);
});

test('send proposal reports not connected, invalid details and unconfirmed sends', async () => {
  assert.equal((await proposalRoute({ env: {} }).POST(post(proposalBody))).status, 503);
  const bad = proposalRoute();
  assert.equal((await bad.POST(post({ ...proposalBody, client: { ...client, email: 'nope' } }))).status, 400);
  assert.equal((await bad.POST(post({ ...proposalBody, rep: 'Stranger' }))).status, 400);
  assert.equal(bad.calls.length, 0);
  const failed = await proposalRoute({ reply: { sent: false, error: 'Proposal NOT sent: GHL 401' }, status: 502 }).POST(post(proposalBody));
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /GHL 401/);
  const notJson = proposalRoute({ reply: 'Workflow was started', status: 200 });
  assert.equal((await notJson.POST(post(proposalBody))).status, 502);
});

// ---- n8n workflow ------------------------------------------------------------------------

const workflow = JSON.parse(readFileSync(join(__dirname, '..', 'integrations/n8n/loudr-website-proposals.n8n.json'), 'utf8'));
const nodeNamed = (name) => workflow.nodes.find((n) => n.name === name);
const settings = (() => {
  const code = nodeNamed('Proposal settings').parameters.jsCode;
  return new Function('$input', code)({ all: () => [{ json: {} }] })[0].json.config;
})();
const DateTime = { now: () => ({ setZone: () => ({ toFormat: () => 'November 14, 2026' }) }) };
function runCode(name, outputs) {
  const $ = (node) => ({ first: () => ({ json: outputs[node] }) });
  return new Function('$', 'DateTime', nodeNamed(name).parameters.jsCode)($, DateTime);
}
function workOutTotal(body) {
  return runCode('Work out total', { 'Loudr website': { body }, 'Proposal settings': { config: settings } })[0].json;
}

test('the workflow reads the website order into the fields the GHL and Whop steps use', () => {
  const t = workOutTotal(plain(payload()));
  assert.equal(t.rep, 'Mason Church');
  assert.equal(t.userId, settings.reps['Mason Church']);
  assert.equal(t.email, 'dana@example.com');
  assert.equal(t.firm, 'Reyes Law');
  assert.equal(t.state, 'Texas, Alabama');
  assert.equal(t.leadCount, '111');
  assert.equal(t.leadsLine, '111 (Texas 50, Alabama 61)');
  assert.equal(t.bankCplLine, 'Texas $500, Alabama $325');
  assert.equal(t.bankTotalNumber, 44825);
  assert.equal(t.bankTotal, '$44,825');
  assert.equal(t.totalNumber, card.total);
  assert.equal(t.total, team.money(card.total));
  assert.equal(t.proposalId, 'prop_1');
  // Single state: the README's acceptance test, Texas 50 leads.
  const single = cartLib.calculateCartQuote([{ state: 'TX', quantity: 50 }], undefined, 'bank');
  const singleCard = cartLib.calculateCartQuote([{ state: 'TX', quantity: 50 }], undefined, 'card');
  const one = workOutTotal(plain(payload({ bank: single, card: singleCard })));
  assert.equal(one.bankTotal, '$25,000');
  assert.equal(one.total, '$25,750');
  assert.equal(one.leads, '50');
  assert.equal(one.cpl, '$500');
});

test('the workflow refuses tampered totals, unknown reps and old payload versions', () => {
  const body = plain(payload());
  assert.throws(() => workOutTotal({ ...body, order: { ...body.order, card_total: body.order.card_total - 1 } }), /Card total/);
  assert.throws(() => workOutTotal({ ...body, order: { ...body.order, wire_total: 1 } }), /Wire total/);
  assert.throws(() => workOutTotal({ ...body, rep: { name: 'Stranger' } }), /reps map/);
  assert.throws(() => workOutTotal({ ...body, version: 2 }), /Unsupported/);
  assert.throws(() => workOutTotal({ ...body, client: { ...body.client, email: '' } }), /email/);
});

test('the workflow keeps every GHL, Whop and payment step and replaces only the form', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  for (const removed of ['Proposal form', 'Price for state', 'Leads and price']) assert.equal(names.has(removed), false);
  for (const kept of ['Save on GHL contact', 'Whop card link', 'Whop bank link', 'Check links', 'Save pay link', 'Send proposal', 'Retire old link', 'Whop payment', 'Check', 'Tag contact', 'Post to sales team']) assert.ok(names.has(kept), kept);
  for (const [from, outputs] of Object.entries(workflow.connections)) {
    assert.ok(names.has(from), from);
    for (const branch of outputs.main) for (const target of branch ?? []) assert.ok(names.has(target.node), target.node);
  }
  const hook = nodeNamed('Loudr website');
  assert.equal(hook.type, 'n8n-nodes-base.webhook');
  assert.equal(hook.parameters.authentication, 'headerAuth');
  assert.equal(hook.parameters.responseMode, 'responseNode');
  assert.equal(nodeNamed('Sent').type, 'n8n-nodes-base.respondToWebhook');
  assert.equal(nodeNamed('Not sent').parameters.options.responseCode, 502);
  assert.equal(workflow.active, false);
  assert.doesNotMatch(JSON.stringify(workflow), /\$\('Proposal form'\)|\$\('Price for state'\)|\$\('Leads and price'\)/);
  // No secrets ship in the file: credentials are selected in n8n.
  assert.doesNotMatch(JSON.stringify(workflow), /Bearer [A-Za-z0-9]|apik_|ws_[A-Za-z0-9]{8}/);
});

test('the Whop link requests use the website totals and carry the proposal ID', () => {
  const t = workOutTotal(plain(payload()));
  const evaluate = (name) => {
    const expression = nodeNamed(name).parameters.jsonBody.replace(/^=\{\{/, '').replace(/\}\}$/, '');
    const $ = (node) => ({ first: () => ({ json: node === 'Work out total' ? t : node === 'Proposal settings' ? { config: settings } : { contact: { id: 'ghl_1' } } }) });
    return JSON.parse(new Function('$', `return ${expression}`)($));
  };
  const cardBody = evaluate('Whop card link');
  assert.equal(cardBody.variant.initial_price, card.total);
  assert.equal(cardBody.metadata.source, settings.source);
  assert.equal(cardBody.metadata.ghl_contact_id, 'ghl_1');
  assert.equal(cardBody.metadata.proposal_id, 'prop_1');
  const wireBody = evaluate('Whop bank link');
  assert.equal(wireBody.variant.initial_price, 44825);
  assert.equal(wireBody.metadata.total, '$44,825');
});

test('after sending, the workflow retires old GHL links and the closer’s generated links, never the new ones', () => {
  const out = runCode('Old plan IDs', {
    'Read old links': { contact: { customFields: [{ id: settings.fields.planIds, value: 'plan_old1,plan_new1' }] } },
    'Proposal settings': { config: settings },
    'Loudr website': { body: { retire_plan_ids: ['plan_team1', 'plan_old1', 'bad id'] } },
    'Check links': { plans: 'plan_new1,plan_new2' },
  });
  assert.deepEqual(plain(out.map((item) => item.json.id)), ['plan_old1', 'plan_team1']);
});
