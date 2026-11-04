const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { loadTypeScript } = require('./load-ts.cjs');

const site = 'https://loudr-leads.vercel.app';
const businessId = 'biz_HqBscEcuZxTgaf';
const clientId = 'app_RaP619R6n2xjF2';
const sessionCookie = '__Host-loudr-admin-session';
const flowCookie = '__Host-loudr-admin-oauth';
const memberId = 'user_member123';
const baseEnv = {
  NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: site, WHOP_ACCOUNT_ID: businessId, WHOP_OAUTH_CLIENT_ID: clientId,
  WHOP_API_KEY: 'test-merchant-key', ADMIN_SESSION_SECRET: 'session-test-secret-'.repeat(4),
  // Retired settings must never bypass Whop sign-in.
  ADMIN_ACCESS_MODE: 'open', ADMIN_USERNAME: 'test-admin', ADMIN_PASSWORD_HASH: 'scrypt$x$y',
};

function teamMember(userId, overrides = {}) {
  return {
    id: 'ausr_x', status: 'joined', role: 'admin', is_agent: false, account_id: businessId,
    user: { id: userId, name: 'Team Member', username: 'teammember' }, ...overrides,
  };
}

function setCookies(response) {
  return response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
}
function cookieValue(response, name) {
  const found = setCookies(response).find(value => value.startsWith(`${name}=`));
  return found ? found.split(';')[0] : null;
}
function location(response) { return new URL(response.headers.get('location'), site); }

async function fixture(overrides = {}, options = {}) {
  const jose = await import('jose');
  const env = { ...baseEnv, ...overrides };
  const calls = [];
  const state = {
    members: options.members ?? [teamMember(memberId)], userId: options.userId ?? memberId,
    teamStatus: options.teamStatus ?? 200, tokenStatus: options.tokenStatus ?? 200,
  };
  async function fetch(url, init = {}) {
    const parsed = new URL(url);
    calls.push({ url: parsed, init, body: init.body ? JSON.parse(init.body) : null });
    if (parsed.pathname === '/oauth/token') {
      return Response.json(state.tokenStatus === 200 ? { access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 3600 } : { error: 'invalid_grant' }, { status: state.tokenStatus });
    }
    if (parsed.pathname === '/oauth/userinfo') return Response.json({ sub: state.userId, name: 'Team Member' });
    if (parsed.pathname === '/oauth/revoke') return new Response(null, { status: 200 });
    if (parsed.pathname === '/api/v1/team_members') {
      if (state.teamStatus !== 200) return Response.json({ error: { message: 'nope' } }, { status: state.teamStatus });
      const userId = parsed.searchParams.get('user_id');
      return Response.json({ data: state.members.filter(m => m.user?.id === userId), page_info: {} });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }
  const globals = {
    process: { env }, Buffer, Uint8Array, TextEncoder, TextDecoder, AbortSignal, Headers, fetch, Date,
    crypto: nodeCrypto.webcrypto, setTimeout, clearTimeout,
  };
  const team = loadTypeScript('lib/whop-team.ts', {}, globals);
  const session = loadTypeScript('lib/admin-session.ts', { jose, 'node:crypto': nodeCrypto, '@/lib/whop-team': team }, globals);
  const guard = loadTypeScript('lib/admin-auth.ts', { '@/lib/admin-session': session, '@/lib/whop-team': team }, globals);

  async function start() {
    const response = await session.handleStart(new Request(`${site}/api/auth/whop/start`, { method: 'POST', headers: { origin: site } }));
    return { response, flow: cookieValue(response, flowCookie), url: location(response) };
  }
  async function callback(params, cookie) {
    return session.handleCallback(new Request(`${site}/api/auth/whop/callback?${new URLSearchParams(params)}`, { headers: cookie ? { cookie } : {} }));
  }
  async function signIn() {
    const { flow, url } = await start();
    const response = await callback({ code: 'auth-code', state: url.searchParams.get('state') }, flow);
    return { response, cookie: cookieValue(response, sessionCookie), url };
  }
  return { env, state, calls, session, guard, jose, start, callback, signIn };
}

test('start redirects to Whop OAuth with PKCE and a short-lived encrypted flow cookie', async () => {
  const f = await fixture();
  const { response, flow, url } = await f.start();
  assert.equal(response.status, 303);
  assert.equal(url.origin + url.pathname, 'https://api.whop.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), clientId);
  assert.equal(url.searchParams.get('redirect_uri'), `${site}/api/auth/whop/callback`);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(url.searchParams.get('scope'), /openid/);
  assert(url.searchParams.get('state').length >= 32);
  assert(flow);
  const attributes = setCookies(response).find(value => value.startsWith(`${flowCookie}=`));
  assert.match(attributes, /HttpOnly/); assert.match(attributes, /Secure/); assert.match(attributes, /SameSite=Lax/); assert.match(attributes, /Max-Age=600/);
  assert(!attributes.includes(url.searchParams.get('state')), 'flow cookie must be encrypted');
});

test('start rejects cross-origin and missing-origin requests', async () => {
  const f = await fixture();
  for (const headers of [{ origin: 'https://foreign.example' }, {}]) {
    const response = await f.session.handleStart(new Request(`${site}/api/auth/whop/start`, { method: 'POST', headers }));
    assert.equal(response.status, 403);
    assert.equal(cookieValue(response, flowCookie), null);
  }
});

test('a joined team member signs in, the verifier is sent, and Whop tokens are revoked rather than stored', async () => {
  const f = await fixture();
  const { response, cookie } = await f.signIn();
  assert.equal(response.status, 303);
  assert.equal(location(response).pathname, '/admin');
  assert(cookie, 'a session cookie is set');
  assert(!cookie.includes('access-token') && !cookie.includes('refresh-token'));
  const token = f.calls.find(c => c.url.pathname === '/oauth/token');
  assert.equal(token.body.grant_type, 'authorization_code');
  assert.equal(token.body.client_id, clientId);
  assert.equal(token.body.code, 'auth-code');
  assert.match(token.body.code_verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(token.body.client_secret, undefined);
  const team = f.calls.find(c => c.url.pathname === '/api/v1/team_members');
  assert.equal(team.url.searchParams.get('account_id'), businessId);
  assert.equal(team.url.searchParams.get('user_id'), memberId);
  assert.equal(team.url.searchParams.get('status'), 'joined');
  assert.equal(team.init.headers.Authorization, 'Bearer test-merchant-key');
  assert(f.calls.some(c => c.url.pathname === '/oauth/revoke' && c.body.token === 'refresh-token'));
  assert(setCookies(response).some(v => v.startsWith(`${flowCookie}=;`) && /Max-Age=0/.test(v)), 'flow cookie is cleared');
  const access = await f.guard.getAdminAccess(cookie);
  assert.equal(access.status, 'authorized');
  assert.equal(access.userId, memberId);
});

test('the optional client secret is sent when configured', async () => {
  const f = await fixture({ WHOP_OAUTH_CLIENT_SECRET: 'client-secret' });
  await f.signIn();
  assert.equal(f.calls.find(c => c.url.pathname === '/oauth/token').body.client_secret, 'client-secret');
});

test('Whop users who are not eligible team members are refused a session', async () => {
  const cases = [
    { members: [] },
    { members: [teamMember(memberId, { status: 'pending' })] },
    { members: [teamMember(memberId, { role: 'partner' })] },
    { members: [teamMember(memberId, { is_agent: true })] },
    { members: [teamMember(memberId, { account_id: 'biz_other' })] },
  ];
  for (const options of cases) {
    const f = await fixture({}, options);
    const { response, cookie } = await f.signIn();
    assert.equal(location(response).pathname, '/admin/login');
    assert.equal(location(response).searchParams.get('error'), 'not_team_member');
    assert.equal(cookie, null);
  }
});

test('callback rejects missing, mismatched or replayed state without contacting Whop', async () => {
  const f = await fixture();
  const { flow, url } = await f.start();
  const good = url.searchParams.get('state');
  for (const [params, cookie] of [
    [{ code: 'c', state: good }, null],
    [{ code: 'c', state: 'wrong-state' }, flow],
    [{ code: 'c' }, flow],
    [{ code: 'c', state: good }, `${flowCookie}=tampered`],
    [{ code: 'c', state: good }, `${flow}; ${flow}`],
  ]) {
    const response = await f.callback(params, cookie);
    assert.equal(location(response).searchParams.get('error'), 'sign_in_expired');
    assert.equal(cookieValue(response, sessionCookie), null);
  }
  assert.equal(f.calls.length, 0);
});

test('a cancelled authorization or failed token exchange does not sign in', async () => {
  const f = await fixture();
  const { flow, url } = await f.start();
  const denied = await f.callback({ error: 'access_denied', state: url.searchParams.get('state') }, flow);
  assert.equal(location(denied).searchParams.get('error'), 'whop_denied');
  const g = await fixture({}, { tokenStatus: 400 });
  const { response, cookie } = await g.signIn();
  assert.equal(location(response).searchParams.get('error'), 'sign_in_failed');
  assert.equal(cookie, null);
});

test('a team lookup outage fails closed at sign-in and on later requests', async () => {
  const f = await fixture({}, { teamStatus: 500 });
  const { response, cookie } = await f.signIn();
  assert.equal(location(response).searchParams.get('error'), 'unavailable');
  assert.equal(cookie, null);
  const signed = await (await fixture()).signIn();
  // A fresh guard has no cached membership, so it must ask Whop and fail closed.
  const outage = await fixture({}, { teamStatus: 503 });
  assert.equal((await outage.guard.getAdminAccess(signed.cookie)).status, 'unavailable');
});

test('removing a member from the team revokes access once the short membership cache expires', async () => {
  const f = await fixture();
  const { cookie } = await f.signIn();
  assert.equal((await f.guard.getAdminAccess(cookie)).status, 'authorized');
  f.state.members = [];
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    assert.equal((await f.guard.getAdminAccess(cookie)).status, 'forbidden');
  } finally { Date.now = realNow; }
});

test('sessions require a valid cookie for the current business and OAuth app', async () => {
  const f = await fixture();
  const { cookie } = await f.signIn();
  assert.equal((await f.guard.getAdminAccess(null)).status, 'unauthenticated');
  assert.equal((await f.guard.getAdminAccess(`${sessionCookie}=garbage`)).status, 'unauthenticated');
  assert.equal((await f.guard.getAdminAccess(cookie.slice(0, -2) + 'zz')).status, 'unauthenticated');
  assert.equal((await f.guard.getAdminAccess(`${cookie}; ${cookie}`)).status, 'unauthenticated');
  for (const settings of [{ WHOP_ACCOUNT_ID: 'biz_other' }, { WHOP_OAUTH_CLIENT_ID: 'app_other' }, { ADMIN_SESSION_SECRET: 'replacement-session-secret-'.repeat(4) }]) {
    const g = await fixture(settings);
    assert.equal((await g.guard.getAdminAccess(cookie)).status, 'unauthenticated');
  }
});

test('admin API reads and writes require a team-member session', async () => {
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
  const { cookie } = await f.signIn();
  assert.equal((await route.PATCH(request({ cookie, origin: 'https://foreign.example' }))).status, 403);
  assert.equal(storageCalls.length, 0);
  assert.equal((await route.GET(request({ cookie }, 'GET'))).status, 200);
  assert.equal((await route.PATCH(request({ cookie }))).status, 200);
  assert.deepEqual(storageCalls, ['read', 'write']);
});

test('logout rejects cross-origin requests and clears the session', async () => {
  const f = await fixture();
  const foreign = await f.session.handleLogout(new Request(`${site}/api/auth/logout`, { method: 'POST', headers: { origin: 'https://foreign.example' } }));
  assert.equal(foreign.status, 403);
  const response = await f.session.handleLogout(new Request(`${site}/api/auth/logout`, { method: 'POST', headers: { origin: site } }));
  assert.equal(location(response).pathname, '/admin/login');
  assert(setCookies(response).some(v => v.startsWith(`${sessionCookie}=`) && /Max-Age=0/.test(v)));
});

test('missing or invalid configuration fails closed despite retired password settings', async () => {
  for (const settings of [{ WHOP_OAUTH_CLIENT_ID: '' }, { WHOP_OAUTH_CLIENT_ID: 'not-an-app' }, { WHOP_API_KEY: '' }, { ADMIN_SESSION_SECRET: 'short' }, { NEXT_PUBLIC_SITE_URL: 'http://loudr-leads.vercel.app' }]) {
    const f = await fixture(settings);
    assert.equal(f.session.authConfigured(), false);
    assert.equal((await f.guard.getAdminAccess(null)).status, 'unavailable');
    const response = await f.session.handleStart(new Request(`${site}/api/auth/whop/start`, { method: 'POST', headers: { origin: site } }));
    assert.equal(response.status, 503);
    assert(!(await response.text()).includes('test-merchant-key'));
  }
});
