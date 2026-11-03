const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./load-ts.cjs');
const pricing = loadTypeScript('lib/lead-pricing.ts', { '@/lib/payment-methods': loadTypeScript('lib/payment-methods.ts') });
const card = loadTypeScript('lib/rate-card.ts', { '@/lib/lead-pricing': pricing });

function routes({ denied = false, originDenied = false, failure = null } = {}) {
  const calls = [];
  const result = card.defaultRateCard();
  const dependencies = {
    '@/lib/admin-auth': {
      requireAdmin: async () => denied ? Response.json({ error: 'Denied' }, { status: 401 }) : null,
      checkMutationOrigin: () => originDenied ? Response.json({ error: 'Wrong origin' }, { status: 403 }) : null,
    },
    '@/lib/rate-card': card,
    '@/lib/pricing-store': {
      PricingError: card.PricingError,
      async readRateCard() { calls.push('read'); if (failure) throw failure; return result; },
      async saveRateChanges(version, changes) {
        calls.push({ version, changes });
        if (failure) throw failure;
        card.validateVersion(version); card.validateChanges(changes);
        return { ...result, version: 'saved' };
      },
    },
  };
  return { admin: loadTypeScript('app/api/admin/prices/route.ts', dependencies), public: loadTypeScript('app/api/prices/route.ts', dependencies), calls };
}
function request(body, headers = {}) {
  return new Request('https://loudr-leads.vercel.app/api/admin/prices', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://loudr-leads.vercel.app', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const update = { version: 'initial', changes: [{ code: 'TX', price: 525 }] };

test('admin guard protects reads and writes and origin check happens before persistence', async () => {
  const unauthorized = routes({ denied: true });
  assert.equal((await unauthorized.admin.GET(request(update))).status, 401);
  assert.equal((await unauthorized.admin.PATCH(request(update))).status, 401);
  assert.equal(unauthorized.calls.length, 0);
  const foreign = routes({ originDenied: true });
  assert.equal((await foreign.admin.PATCH(request(update))).status, 403);
  assert.equal(foreign.calls.length, 0);
});

test('public prices and admin saves are not cacheable and use the persisted card shape', async () => {
  const fixture = routes();
  const read = await fixture.public.GET();
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal((await read.json()).states.length, 50);
  const saved = await fixture.admin.PATCH(request(update));
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.equal((await saved.json()).version, 'saved');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls[1])), update);
});

test('admin rejects invalid JSON, shape, content type and oversized payloads without saving', async () => {
  const fixture = routes();
  for (const body of ['{', 'null', '[]']) assert.equal((await fixture.admin.PATCH(request(body))).status, 400);
  assert.equal((await fixture.admin.PATCH(request(update, { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await fixture.admin.PATCH(request(' '.repeat(16385)))).status, 413);
  assert.equal((await fixture.admin.PATCH(request(update, { 'Content-Length': '20000' }))).status, 413);
  assert.equal(fixture.calls.length, 0);
});

test('conflict and unavailable errors retain actionable status without provider detail', async () => {
  const conflict = routes({ failure: new card.PricingError('Reload prices.', 409) });
  assert.equal((await conflict.admin.PATCH(request(update))).status, 409);
  const unavailable = routes({ failure: new Error('private provider error') });
  const response = await unavailable.public.GET();
  assert.equal(response.status, 503);
  assert(!JSON.stringify(await response.json()).includes('private'));
});
