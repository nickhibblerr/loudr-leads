const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./load-ts.cjs');
const crypto = require('node:crypto');
const net = require('node:net');
const key = new Uint8Array(32).fill(7);
const WINDOW_MS = 300_000;
const START = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
class BlobPreconditionFailedError extends Error {}
const request = (ip = '192.0.2.10', headers = {}) => new Request('https://loudr-leads.vercel.app/api/admin/login', {
  headers: { ...(ip ? { 'x-forwarded-for': ip } : {}), ...headers },
});

function fixture(options = {}) {
  let now = START + 1000;
  let revision = 0;
  let readError = false;
  let writeError = false;
  const documents = new Map();
  const reads = [];
  const writes = [];
  const blob = {
    BlobPreconditionFailedError,
    async get(pathname, settings) {
      reads.push({ pathname, settings });
      if (readError) throw new Error('private provider detail');
      const entry = documents.get(pathname);
      if (!entry) return null;
      const body = JSON.stringify(entry.counter);
      return { statusCode: 200, stream: new Response(body).body, blob: { size: body.length, etag: entry.etag } };
    },
    async put(pathname, body, settings) {
      writes.push({ pathname, body, settings });
      if (writeError) throw new Error('private provider detail');
      const previous = documents.get(pathname);
      if (options.alwaysConflict || (settings.ifMatch && settings.ifMatch !== previous?.etag)) throw new BlobPreconditionFailedError();
      if (previous && settings.allowOverwrite === false) throw new Error('pathname already exists');
      const entry = { counter: JSON.parse(body), etag: `"revision-${++revision}"` };
      documents.set(pathname, entry);
      return { etag: entry.etag };
    },
  };
  function instance() {
    return loadTypeScript('lib/admin-login-throttle.ts', {
      'node:crypto': crypto, 'node:net': net, '@vercel/blob': blob,
    }, {
      process: { env: { NODE_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'test', ...options.env } },
      AbortSignal, Date: { now: () => now },
    }).enforceLoginRateLimit;
  }
  return { enforce: instance(), instance, documents, reads, writes,
    setTime: (value) => { now = value; }, failReads: () => { readError = true; }, failWrites: () => { writeError = true; } };
}

test('ten attempts persist across instances, then reject until the next fixed window', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) assert.equal((await f.instance()(request(), key)).allowed, true);
  const blocked = await f.enforce(request(), key);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 299);
  assert.equal(f.writes.length, 10, 'rejected attempts do not write or extend the window');
  assert(f.reads.every(read => read.settings.useCache === false && read.settings.access === 'private'));
  assert(f.writes.every(write => write.settings.access === 'private' && write.settings.addRandomSuffix === false));
  assert.equal(f.writes[0].settings.allowOverwrite, false);
  assert(f.writes.slice(1).every(write => write.settings.ifMatch));
  assert.match(f.writes[0].pathname, /^auth\/login\/[a-f0-9]{64}\.json$/);
  assert(!JSON.stringify(f.writes).includes('192.0.2.10'));
  f.setTime(START + WINDOW_MS);
  assert.equal((await f.enforce(request(), key)).allowed, true);
  assert.equal(f.documents.size, 1, 'window resets reuse the same private object');
  assert.equal([...f.documents.values()][0].counter.count, 1);
});

test('conditional writes preserve both initial concurrent attempts and the final quota slot', async () => {
  const f = fixture();
  const initial = await Promise.all([f.enforce(request(), key), f.instance()(request(), key)]);
  assert(initial.every(result => result.allowed));
  assert.equal([...f.documents.values()][0].counter.count, 2);
  for (let i = 2; i < 9; i++) await f.enforce(request(), key);
  const final = await Promise.all([f.enforce(request(), key), f.instance()(request(), key)]);
  assert.equal(final.filter(result => result.allowed).length, 1);
  assert.equal(final.filter(result => !result.allowed).length, 1);
  assert.equal([...f.documents.values()][0].counter.count, 10);
});

test('Vercel client IP takes precedence; IPv6 normalizes and invalid headers share the unknown bucket', async () => {
  const f = fixture();
  await f.enforce(request('198.51.100.3', { 'x-vercel-forwarded-for': '203.0.113.8' }), key);
  await f.enforce(request('198.51.100.4', { 'x-vercel-forwarded-for': '203.0.113.8' }), key);
  assert.equal(f.documents.size, 1);
  await f.enforce(request('2001:db8::1'), key);
  await f.enforce(request('2001:0DB8:0000:0000:0000:0000:0000:0001'), key);
  assert.equal(f.documents.size, 2);
  await f.enforce(request(null), key);
  await f.enforce(request('not-an-ip'), key);
  assert.equal(f.documents.size, 3);
  assert([...f.documents.values()].every(entry => entry.counter.count === 2));
  await f.enforce(request('198.51.100.5, 192.0.2.2', { 'x-vercel-forwarded-for': 'invalid' }), key);
  await f.enforce(request('198.51.100.5'), key);
  assert.equal(f.documents.size, 4);
});

test('storage failures, corrupt counters and exhausted write conflicts fail closed with sanitized errors', async () => {
  for (const failure of ['failReads', 'failWrites']) {
    const f = fixture();
    f[failure]();
    await assert.rejects(() => f.enforce(request(), key), error => error.status === 503 && !error.message.includes('provider'));
  }
  for (const invalid of [
    { count: 0 }, { count: 11 }, { count: 1.5 }, { count: '1' }, { version: 2 },
    { windowStart: START + WINDOW_MS }, { windowStart: START + 1 }, { windowStart: -WINDOW_MS },
  ]) {
    const f = fixture();
    await f.enforce(request(), key);
    Object.assign([...f.documents.values()][0].counter, invalid);
    await assert.rejects(() => f.enforce(request(), key), error => error.status === 503);
    assert.equal(f.writes.length, 1);
  }
  const race = fixture({ alwaysConflict: true });
  await assert.rejects(() => race.enforce(request(), key), error => error.status === 503);
  assert.equal(race.writes.length, 3);
});

test('missing production storage fails closed; local fallback enforces quota and resets', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development', VERCEL: '1' }]) {
    const f = fixture({ env: { BLOB_READ_WRITE_TOKEN: '', ...env } });
    await assert.rejects(() => f.enforce(request(), key), error => error.status === 503);
  }
  const f = fixture({ env: { NODE_ENV: 'development', BLOB_READ_WRITE_TOKEN: '' } });
  for (let i = 0; i < 10; i++) assert.equal((await f.enforce(request(), key)).allowed, true);
  assert.equal((await f.enforce(request(), key)).allowed, false);
  assert.equal(f.reads.length, 0);
  f.setTime(START + WINDOW_MS);
  assert.equal((await f.enforce(request(), key)).allowed, true);
});
