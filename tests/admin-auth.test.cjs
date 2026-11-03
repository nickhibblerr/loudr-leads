const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const nodeUtil = require('node:util');
const { loadTypeScript } = require('./load-ts.cjs');

const site = 'https://loudr-leads.vercel.app';
const businessId = 'biz_HqBscEcuZxTgaf';
const cookieName = '__Host-loudr-admin-session';
const username = 'test-admin';
const password = 'Example test password!82';
function passwordHash(value, salt = Buffer.alloc(16, 31)) {
  const hash = nodeCrypto.scryptSync(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
const hash = passwordHash(password);
const baseEnv = {
  NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: site, WHOP_ACCOUNT_ID: businessId,
  ADMIN_USERNAME: username, ADMIN_PASSWORD_HASH: hash,
  ADMIN_SESSION_SECRET: 'session-test-secret-'.repeat(4),
  ADMIN_ACCESS_MODE: 'open', // The retired flag must never bypass authentication.
};
const key = nodeCrypto.createHash('sha256').update(baseEnv.ADMIN_SESSION_SECRET).digest();

function setCookies(response) {
  return response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
}
function cookieFrom(response) {
  return setCookies(response).find(value => value.startsWith(`${cookieName}=`))?.split(';')[0] ?? null;
}
function loginRequest(fields = { username, password }, { origin = site, contentType = 'application/x-www-form-urlencoded', rawBody, extraHeaders = {} } = {}) {
  return new Request(`${site}/api/auth/login`, {
    method: 'POST', headers: { ...(origin === null ? {} : { origin }), 'content-type': contentType, ...extraHeaders },
    body: rawBody ?? new URLSearchParams(fields),
  });
}
function redirectPath(response) {
  const location = response.headers.get('location');
  return location ? new URL(location, site).pathname : null;
}

async function fixture(overrides = {}, options = {}) {
  const jose = await import('jose');
  const env = { ...baseEnv, ...overrides };
  const globals = {
    process: { env }, Buffer, Uint8Array, TextEncoder, TextDecoder,
    AbortSignal, Headers, crypto: nodeCrypto.webcrypto, setTimeout, clearTimeout,
  };
  let scryptCalls = 0;
  const throttleCalls = [];
  const cryptoDependency = { ...nodeCrypto, scrypt(...args) { scryptCalls++; return nodeCrypto.scrypt(...args); } };
  const session = loadTypeScript('lib/admin-session.ts', {
    jose, 'node:crypto': cryptoDependency, crypto: cryptoDependency, 'node:util': nodeUtil, 'server-only': {},
    '@/lib/admin-login-throttle': {
      async enforceLoginRateLimit(request, key) {
        throttleCalls.push({ request, key });
        if (options.throttleError) throw new Error('private throttle storage details');
        return options.throttleResult ?? { allowed: true, retryAfter: 0 };
      },
    },
  }, globals);
  const guard = loadTypeScript('lib/admin-auth.ts', { '@/lib/admin-session': session }, globals);
  async function cookie() { return (await session.createSessionCookie()).split(';')[0]; }
  async function alteredCookie(claims = {}, expiration = Math.floor(Date.now() / 1000) + 300) {
    const original = await cookie();
    const { payload } = await jose.jwtDecrypt(original.slice(original.indexOf('=') + 1), key);
    const token = await new jose.EncryptJWT({ ...payload, ...claims })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setIssuer(site).setAudience('loudr-admin-session')
      .setIssuedAt().setExpirationTime(expiration).encrypt(key);
    return `${cookieName}=${token}`;
  }
  return { session, guard, jose, cookie, alteredCookie, throttleCalls, scryptCalls: () => scryptCalls };
}

test('a correct password establishes an encrypted, secure admin session', async () => {
  const f = await fixture();
  const response = await f.session.handleLogin(loginRequest());
  assert.equal(response.status, 303);
  assert.equal(redirectPath(response), '/admin');
  const cookie = cookieFrom(response);
  assert(cookie, 'Successful login must set a session cookie');
  const access = await f.guard.getAdminAccess(cookie);
  assert.equal(access.status, 'authorized');
  assert.equal(access.username, username);
  const attributes = setCookies(response).find(value => value.startsWith(`${cookieName}=`));
  assert.match(attributes, /HttpOnly/i); assert.match(attributes, /Secure/i); assert.match(attributes, /SameSite=Lax/i);
  assert.match(attributes, /Path=\//); assert.match(attributes, /Max-Age=28800/);
  assert(!attributes.includes(password)); assert(!attributes.includes(hash)); assert(!attributes.includes(username));
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('incorrect or empty credentials receive the same generic failure without a session', async () => {
  const f = await fixture();
  for (const fields of [{ username, password: 'incorrect' }, { username: 'other-admin', password }, { username: '', password }, { username, password: '' }, { username: username.toUpperCase(), password }]) {
    const response = await f.session.handleLogin(loginRequest(fields));
    assert.equal(response.status, 303);
    assert.equal(redirectPath(response), '/admin/login');
    assert.equal(new URL(response.headers.get('location'), site).searchParams.get('error'), 'invalid_credentials');
    assert(!cookieFrom(response) || cookieFrom(response) === `${cookieName}=`);
    assert(!(await response.text()).includes(password));
  }
});

test('login rejects cross-origin, missing-origin and non-form requests', async () => {
  const f = await fixture();
  for (const origin of ['https://foreign.example', null]) {
    const response = await f.session.handleLogin(loginRequest(undefined, { origin }));
    assert.equal(response.status, 403);
    assert.equal(cookieFrom(response), null);
  }
  const badType = await f.session.handleLogin(loginRequest(undefined, { contentType: 'application/json', rawBody: JSON.stringify({ username, password }) }));
  assert.equal(redirectPath(badType), '/admin/login');
  assert.equal(cookieFrom(badType), null);
});

test('oversized credential submissions are rejected without processing a password', async () => {
  const f = await fixture();
  for (const extraHeaders of [{ 'content-length': '20009' }, {}]) {
    const response = await f.session.handleLogin(loginRequest(undefined, { rawBody: `username=${username}&password=` + 'x'.repeat(20000), extraHeaders }));
    assert.equal(redirectPath(response), '/admin/login');
    assert.equal(cookieFrom(response), null);
  }
  assert.equal(f.scryptCalls(), 0);
  assert.equal(f.throttleCalls.length, 0);
});

test('a throttled sign-in returns a retry delay without checking credentials or creating a session', async () => {
  const f = await fixture({}, { throttleResult: { allowed: false, retryAfter: 61.2 } });
  const response = await f.session.handleLogin(loginRequest());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '62');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(cookieFrom(response), null);
  assert.equal(f.scryptCalls(), 0);
  assert.equal(f.throttleCalls.length, 1);
  assert.deepEqual(Buffer.from(f.throttleCalls[0].key), key);
});

test('throttle storage failure fails closed without checking credentials or creating a session', async () => {
  const f = await fixture({}, { throttleError: true });
  const response = await f.session.handleLogin(loginRequest());
  assert.equal(response.status, 503);
  assert.equal(cookieFrom(response), null);
  assert.equal(f.scryptCalls(), 0);
  assert.equal(f.throttleCalls.length, 1);
  assert(!(await response.text()).includes('private throttle'));
});

test('trusted browser origins work behind an internal proxy URL while forged origin headers are rejected', async () => {
  const f = await fixture();
  const internal = 'http://localhost:3000';
  const accepted = await f.session.handleLogin(new Request(`${internal}/api/auth/login`, {
    method: 'POST', headers: { origin: site, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }),
  }));
  assert.equal(accepted.status, 303);
  assert.equal(redirectPath(accepted), '/admin');
  assert(cookieFrom(accepted));
  assert.equal(f.guard.checkMutationOrigin(new Request(`${internal}/api/admin/prices`, {
    method: 'PATCH', headers: { origin: site, 'content-type': 'Application/JSON' }, body: '{}',
  })), null);
  const denied = await f.session.handleLogin(new Request(`${internal}/api/auth/login`, {
    method: 'POST', headers: { origin: 'https://foreign.example', host: 'loudr-leads.vercel.app', 'x-forwarded-host': 'loudr-leads.vercel.app', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }),
  }));
  assert.equal(denied.status, 403);
  assert.equal(cookieFrom(denied), null);
  const mutation = f.guard.checkMutationOrigin(new Request(`${internal}/api/admin/prices`, {
    method: 'PATCH', headers: { origin: 'https://foreign.example', 'x-forwarded-host': 'loudr-leads.vercel.app', 'content-type': 'application/json' }, body: '{}',
  }));
  assert.equal(mutation.status, 403);
  const logout = await f.session.handleLogout(new Request(`${internal}/api/auth/logout`, { method: 'POST', headers: { origin: site } }));
  assert.equal(logout.status, 303);
  assert.equal(redirectPath(logout), '/admin/login');
});

test('sessions require a valid encrypted cookie, current business, and unexpired claims', async () => {
  const f = await fixture();
  assert.equal((await f.guard.getAdminAccess(null)).status, 'unauthenticated');
  assert.equal((await f.guard.getAdminAccess(`${cookieName}=unsigned-token`)).status, 'unauthenticated');
  const valid = await f.cookie();
  assert.equal((await f.guard.getAdminAccess(valid)).status, 'authorized');
  const tampered = valid.slice(0, -2) + 'zz';
  for (const cookie of [tampered, await f.alteredCookie({}, Math.floor(Date.now() / 1000) - 60), await f.alteredCookie({ business_id: 'biz_other' }), await f.alteredCookie({ username: 'other-admin' }), `${valid}; ${valid}`]) {
    assert.equal((await f.guard.getAdminAccess(cookie)).status, 'unauthenticated');
  }
});

test('password, username, session-secret and business changes revoke existing sessions', async () => {
  const original = await fixture();
  const cookie = await original.cookie();
  const changed = [
    { ADMIN_PASSWORD_HASH: passwordHash('A different test password!') },
    { ADMIN_USERNAME: 'replacement-admin' },
    { ADMIN_SESSION_SECRET: 'replacement-session-secret-'.repeat(4) },
    { WHOP_ACCOUNT_ID: 'biz_other' },
  ];
  for (const settings of changed) {
    const f = await fixture(settings);
    assert.equal((await f.guard.getAdminAccess(cookie)).status, 'unauthenticated');
  }
});

test('admin API reads and writes require a session even when legacy open mode is set', async () => {
  const f = await fixture();
  const priceModule = loadTypeScript('lib/lead-pricing.ts', { '@/lib/payment-methods': loadTypeScript('lib/payment-methods.ts') });
  const rateCard = loadTypeScript('lib/rate-card.ts', { '@/lib/lead-pricing': priceModule });
  const storageCalls = [];
  const route = loadTypeScript('app/api/admin/prices/route.ts', {
    '@/lib/admin-auth': f.guard, '@/lib/rate-card': rateCard,
    '@/lib/pricing-store': {
      PricingError: rateCard.PricingError,
      readRateCard: async () => { storageCalls.push('read'); return rateCard.defaultRateCard(); },
      saveRateChanges: async () => { storageCalls.push('write'); return rateCard.defaultRateCard(); },
    },
  });
  const body = JSON.stringify({ version: 'initial', changes: [{ code: 'TX', price: 525 }] });
  const request = (headers = {}, method = 'PATCH') => new Request(`${site}/api/admin/prices`, { method, headers: { origin: site, 'content-type': 'application/json', ...headers }, ...(method === 'PATCH' ? { body } : {}) });
  assert.equal((await route.GET(request({}, 'GET'))).status, 401);
  assert.equal((await route.PATCH(request())).status, 401);
  const cookie = await f.cookie();
  assert.equal((await route.PATCH(request({ cookie, origin: 'https://foreign.example' }))).status, 403);
  assert.equal(storageCalls.length, 0);
  assert.equal((await route.GET(request({ cookie }, 'GET'))).status, 200);
  assert.equal((await route.PATCH(request({ cookie }))).status, 200);
  assert.deepEqual(storageCalls, ['read', 'write']);
});

test('logout rejects cross-origin requests and clears the browser session', async () => {
  const f = await fixture();
  const foreign = await f.session.handleLogout(new Request(`${site}/api/auth/logout`, { method: 'POST', headers: { origin: 'https://foreign.example' } }));
  assert.equal(foreign.status, 403);
  const response = await f.session.handleLogout(new Request(`${site}/api/auth/logout`, { method: 'POST', headers: { origin: site } }));
  assert.equal(response.status, 303);
  assert.equal(redirectPath(response), '/admin/login');
  assert(setCookies(response).some(cookie => cookie.startsWith(`${cookieName}=`) && /Max-Age=0/i.test(cookie)));
});

test('missing or invalid configuration fails closed despite the legacy open flag', async () => {
  for (const settings of [{ ADMIN_PASSWORD_HASH: '' }, { ADMIN_PASSWORD_HASH: 'not-a-valid-hash' }, { ADMIN_SESSION_SECRET: 'short' }, { ADMIN_USERNAME: '' }, { NEXT_PUBLIC_SITE_URL: 'http://loudr-leads.vercel.app' }]) {
    const f = await fixture(settings);
    assert.equal(f.session.authConfigured(), false);
    assert.notEqual((await f.guard.getAdminAccess(null)).status, 'authorized');
    const response = await f.session.handleLogin(loginRequest());
    assert.equal(response.status, 503);
    assert(!cookieFrom(response));
    assert(!(await response.text()).includes('test-merchant-key'));
  }
});
