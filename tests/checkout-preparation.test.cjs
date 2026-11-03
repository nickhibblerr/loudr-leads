const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./load-ts.cjs");
const pricing = loadTypeScript("lib/top-up.ts");
const quote = (amount = 2500, fee = 2.5, currency = "usd") => pricing.calculateTopUp(amount, fee, currency);
function loadPreparer() {
  let now = 0;
  const loaded = loadTypeScript("lib/checkout-preparation.ts", { "@/lib/top-up": pricing }, { Date: { now: () => now } });
  return { create: loaded.createPlanPreparer, advance: (ms) => { now += ms; } };
}

test("Continue shares an in-flight background request for the same amount", async () => {
  const { create } = loadPreparer();
  let finish;
  let calls = 0;
  const prepare = create(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const background = prepare(quote(1000));
  const foreground = prepare(quote(1000));
  assert.equal(background, foreground);
  finish("plan_1000");
  assert.equal(await foreground, "plan_1000");
  assert.equal(await prepare(quote(1000)), "plan_1000");
  assert.equal(calls, 1);
});

test("changing the amount cannot reuse a different price's plan", async () => {
  const { create } = loadPreparer();
  const amounts = [];
  const prepare = create(async (q) => { amounts.push(q.amount); return `plan_${q.amountCents}`; });
  assert.equal(await prepare(quote(1000)), "plan_100000");
  assert.equal(await prepare(quote(2500)), "plan_250000");
  assert.equal(await prepare(quote(100.01)), "plan_10001");
  assert.deepEqual(amounts, [1000, 2500, 100.01]);
});

test("a failed prefetch is retried on Continue", async () => {
  const { create } = loadPreparer();
  let calls = 0;
  const prepare = create(async () => { if (++calls === 1) throw new Error("offline"); return "plan_retried"; });
  await assert.rejects(prepare(quote(2500)), /offline/);
  assert.equal(await prepare(quote(2500)), "plan_retried");
  assert.equal(calls, 2);
});

test("stale plans expire after five minutes", async () => {
  const { create, advance } = loadPreparer();
  let calls = 0;
  const prepare = create(async () => `plan_${++calls}`);
  assert.equal(await prepare(quote(2500)), "plan_1");
  advance(300_000);
  assert.equal(await prepare(quote(2500)), "plan_2");
});

test("old failures do not evict a newer request for the same price", async () => {
  const { create, advance } = loadPreparer();
  let rejectOld;
  let calls = 0;
  const prepare = create(() => ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve("plan_new"));
  const old = prepare(quote(2500));
  advance(300_000);
  assert.equal(await prepare(quote(2500)), "plan_new");
  rejectOld(new Error("old failure"));
  await assert.rejects(old, /old failure/);
  assert.equal(await prepare(quote(2500)), "plan_new");
  assert.equal(calls, 2);
});

test("a fee or currency change gets its own plan preparation", async () => {
  const { create } = loadPreparer();
  let calls = 0;
  const prepare = create(async () => `plan_${++calls}`);
  assert.equal(await prepare(quote(1000, 2.5)), "plan_1");
  assert.equal(await prepare(quote(1000, 5)), "plan_2");
  assert.equal(await prepare(quote(1000, 5, "eur")), "plan_3");
  assert.equal(await prepare(quote(1000, 2.5)), "plan_1");
});

test('adaptive and forced USD preparation are cached separately', async () => {
  const { create } = loadPreparer();
  let calls = 0;
  const prepare = create(async (_, forceUsd) => { calls++; return forceUsd ? 'plan_usd' : 'plan_adaptive'; });
  assert.equal(await prepare(quote()), 'plan_adaptive');
  assert.equal(await prepare(quote(), true), 'plan_usd');
  assert.equal(await prepare(quote()), 'plan_adaptive');
  assert.equal(calls, 2);
});

test('lead orders at the same total keep separate cached plans by state and quantity', async () => {
  const { create } = loadPreparer();
  const leads = loadTypeScript('lib/lead-pricing.ts', { '@/lib/top-up': pricing, '@/lib/payment-methods': loadTypeScript('lib/payment-methods.ts') });
  let calls = 0;
  const prepare = create(async () => `plan_${++calls}`, leads.leadQuoteKey);
  const alabama = leads.calculateLeadQuote('AL', 1);
  const alaska = leads.calculateLeadQuote('AK', 1);
  const texas = leads.calculateLeadQuote('TX', 1);
  const idaho = leads.calculateLeadQuote('ID', 2);
  assert.equal(await prepare(alabama), 'plan_1');
  assert.equal(await prepare(alaska), 'plan_2');
  assert.equal(await prepare(texas), 'plan_3');
  assert.equal(await prepare(idaho), 'plan_4');
  assert.equal(await prepare(alabama), 'plan_1');
  assert.equal(calls, 4);
});
