const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./load-ts.cjs');
const pricing = loadTypeScript('lib/lead-pricing.ts', { '@/lib/payment-methods': loadTypeScript('lib/payment-methods.ts') });
const card = loadTypeScript('lib/rate-card.ts', { '@/lib/lead-pricing': pricing });
class BlobPreconditionFailedError extends Error {}

function fixture(options = {}) {
  let document = options.document ?? null;
  let revision = document ? 1 : 0;
  let readError = options.readError ?? false;
  let writeError = false;
  const reads = [];
  const writes = [];
  const blob = {
    BlobPreconditionFailedError,
    async get(path, settings) {
      reads.push({ path, settings });
      if (readError) throw new Error('private provider error');
      if (!document) return null;
      const body = JSON.stringify(document);
      return { statusCode: 200, stream: new Response(body).body, blob: { size: body.length, etag: `"version-${revision}"` } };
    },
    async put(path, body, settings) {
      if (writeError) throw new Error('private provider error');
      if (document && settings.allowOverwrite === false) throw new Error('pathname already exists');
      if (settings.ifMatch && settings.ifMatch !== `"version-${revision}"`) throw new BlobPreconditionFailedError();
      writes.push({ path, body, settings });
      document = JSON.parse(body);
      revision++;
      return { etag: `"version-${revision}"` };
    },
  };
  const store = loadTypeScript('lib/pricing-store.ts', { '@vercel/blob': blob, '@/lib/rate-card': card }, {
    process: { env: { NODE_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'test-token', ...options.env } }, AbortSignal,
  });
  return { ...store, reads, writes, document: () => document,
    failReads: () => { readError = true; }, failWrites: () => { writeError = true; } };
}
const initialDocument = () => card.applyPriceChanges(card.defaultRateCard(), [], '2026-10-30T00:00:00.000Z');
const statePrice = (result, code) => result.states.find(state => state.code === code).price;

test('missing store object boots from all 50 defaults; save persists changes and future reads bypass CDN', async () => {
  const store = fixture();
  const initial = await store.readRateCard();
  assert.equal(initial.version, 'initial');
  assert.equal(initial.states.length, 50);
  assert.equal(statePrice(initial, 'CA'), null);
  const saved = await store.saveRateChanges(initial.version, [{ code: 'TX', price: 525.75 }, { code: 'CA', price: 375 }]);
  assert.equal(saved.version, '"version-1"');
  assert.equal(statePrice(saved, 'TX'), 525.75);
  assert.equal(statePrice(await store.readRateCard(), 'CA'), 375);
  assert.equal(statePrice(saved, 'AL'), 325);
  assert.equal(store.writes[0].settings.allowOverwrite, false);
  assert(store.reads.every(read => read.settings.useCache === false && read.settings.access === 'private'));
  assert.equal(pricing.LEAD_STATES.find(state => state.code === 'TX').price, 500);
});

test('saved versions reject stale edits and use atomic ETag checks for concurrent writes', async () => {
  const store = fixture({ document: initialDocument() });
  const before = await store.readRateCard();
  const results = await Promise.allSettled([
    store.saveRateChanges(before.version, [{ code: 'TX', price: 550 }]),
    store.saveRateChanges(before.version, [{ code: 'FL', price: 390 }]),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const conflict = results.find(result => result.status === 'rejected');
  assert.equal(conflict.reason.status, 409);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].settings.ifMatch, before.version);
  await assert.rejects(() => store.saveRateChanges(before.version, [{ code: 'AL', price: 200 }]), error => error.status === 409);
  assert.equal(statePrice(await store.readRateCard(), 'AL'), 325);
});

test('two first saves cannot overwrite each other', async () => {
  const store = fixture();
  const results = await Promise.allSettled([
    store.saveRateChanges('initial', [{ code: 'TX', price: 550 }]),
    store.saveRateChanges('initial', [{ code: 'FL', price: 390 }]),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(store.writes.length, 1);
});

test('invalid edits reject the complete save before reads or writes', async () => {
  for (const price of [undefined, 0, -1, NaN, Infinity, '325', 10000.01, 0.001, 0.000000001, 300.123]) {
    const store = fixture();
    await assert.rejects(() => store.saveRateChanges('initial', [{ code: 'AL', price: 400 }, { code: 'TX', price }]), error => error.status === 400);
    assert.equal(store.reads.length, 0);
    assert.equal(store.writes.length, 0);
  }
  for (const changes of [[], null, {}, [{ code: 'ZZ', price: 100 }], [{ code: 'TX', price: 100 }, { code: 'TX', price: 200 }], [{ code: 'TX', price: 100, unknown: true }]]) {
    await assert.rejects(() => fixture().saveRateChanges('initial', changes), error => error.status === 400);
  }
  for (const version of [null, '', 1, 'bad\nversion']) {
    await assert.rejects(() => fixture().saveRateChanges(version, [{ code: 'TX', price: 100 }]), error => error.status === 400);
  }
});

test('sold out, cent pricing and maximum pricing are valid persisted edits', async () => {
  const store = fixture();
  const saved = await store.saveRateChanges('initial', [{ code: 'TX', price: null }, { code: 'AL', price: 0.01 }, { code: 'AK', price: 10000 }]);
  assert.equal(statePrice(saved, 'TX'), null);
  assert.equal(statePrice(saved, 'AL'), 0.01);
  assert.equal(statePrice(saved, 'AK'), 10000);
});

test('corrupt stored prices and storage failures never silently restore defaults', async () => {
  const invalid = initialDocument();
  delete invalid.prices.CA;
  await assert.rejects(() => fixture({ document: invalid }).readRateCard(), error => error.status === 503);
  const badPrice = initialDocument();
  badPrice.prices.TX = 0;
  await assert.rejects(() => fixture({ document: badPrice }).readRateCard(), error => error.status === 503);
  await assert.rejects(() => fixture({ readError: true }).readRateCard(), error => error.status === 503 && !error.message.includes('provider'));
  const store = fixture();
  store.failWrites();
  await assert.rejects(() => store.saveRateChanges('initial', [{ code: 'TX', price: 600 }]), error => error.status === 503);
  assert.equal(store.document(), null);
});

test('production needs configured storage; local development fallback cannot pretend to save', async () => {
  const production = fixture({ env: { BLOB_READ_WRITE_TOKEN: '' } });
  await assert.rejects(() => production.readRateCard(), error => error.status === 503);
  const local = fixture({ env: { NODE_ENV: 'development', BLOB_READ_WRITE_TOKEN: '' } });
  assert.equal((await local.readRateCard()).version, 'initial');
  await assert.rejects(() => local.saveRateChanges('initial', [{ code: 'TX', price: 600 }]), error => error.status === 503);
});
