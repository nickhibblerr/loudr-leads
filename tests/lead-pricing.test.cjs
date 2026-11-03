const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./load-ts.cjs');
const preferences = loadTypeScript('lib/payment-methods.ts');
const topup = loadTypeScript('lib/top-up.ts');
const { LEAD_STATES, calculateLeadQuote, leadQuoteKey, leadMetadata } = loadTypeScript('lib/lead-pricing.ts', { '@/lib/top-up': topup, '@/lib/payment-methods': preferences });
const expected = { AL:325, AK:325, AZ:450, AR:175, CA:null, CO:400, CT:285, DE:150, FL:375, GA:400, HI:100, ID:250, IL:350, IN:285, IA:250, KS:240, KY:250, LA:225, ME:150, MD:300, MA:290, MI:325, MN:250, MS:175, MO:285, MT:225, NE:325, NV:375, NH:150, NJ:350, NM:280, NY:400, NC:325, ND:250, OH:250, OK:235, OR:350, PA:265, RI:235, SC:300, SD:250, TN:275, TX:500, UT:375, VT:100, VA:225, WA:425, WV:160, WI:250, WY:250 };
test('all 50 state prices match the supplied rate card', () => {
  assert.equal(LEAD_STATES.length, 50);
  assert.deepEqual(Object.fromEntries(LEAD_STATES.map(({code, price}) => [code, price])), expected);
  for (const [state, price] of Object.entries(expected)) {
    if (price === null) { assert.throws(() => calculateLeadQuote(state, 1)); continue; }
    const quote = calculateLeadQuote(state, 25);
    assert.equal(quote.amount, price * 25);
    assert.equal(quote.unitPrice, price);
    assert.equal(quote.feeCents, 0);
    assert.equal(quote.total, price * 25);
  }
});
test('rejects sold-out states, missing states, fractional/invalid counts and oversized orders', () => {
  for (const state of ['CA', 'DC', 'tx', '', undefined, null, 1]) assert.throws(() => calculateLeadQuote(state, 1));
  for (const count of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => calculateLeadQuote('TX', count));
  assert.equal(calculateLeadQuote('TX', 1000).amount, 500000);
  assert.throws(() => calculateLeadQuote('TX', 1001));
  assert.equal(calculateLeadQuote('HI', 1000).amount, 100000);
  assert.throws(() => calculateLeadQuote('HI', 1001));
});
test('same total across states or counts remains a distinct order identity', () => {
  const tx = calculateLeadQuote('TX', 1);
  const hi = calculateLeadQuote('HI', 5);
  const vt = calculateLeadQuote('VT', 5);
  assert.equal(tx.total, hi.total);
  assert.notEqual(leadQuoteKey(tx), leadQuoteKey(hi));
  assert.notEqual(leadQuoteKey(hi), leadQuoteKey(vt));
  assert.equal(leadMetadata(tx).state, 'TX');
  assert.equal(leadMetadata(tx).state_name, 'Texas');
  assert.equal(leadMetadata(tx).source, 'loudr-leads-site');
  assert.equal(leadMetadata(tx).quantity, '1');
  assert.equal(leadMetadata(tx).price_per_lead, '500');
});

test('card markup is 2.7% of the order subtotal, rounded once to cents', () => {
  const standard = calculateLeadQuote('TX', 2, undefined, 'card');
  assert.equal(standard.paymentMode, 'card');
  assert.equal(standard.amountCents, 100000);
  assert.equal(standard.feeBasisPoints, 270);
  assert.equal(standard.feePercent, 2.7);
  assert.equal(standard.feeCents, 2700);
  assert.equal(standard.fee, 27);
  assert.equal(standard.totalCents, 102700);
  assert.equal(standard.total, 1027);
  for (const [unitPrice, quantity, subtotalCents, feeCents] of [
    [19.99, 3, 5997, 162],
    [0.01, 1000, 1000, 27],
    [0.01, 1, 1, 0],
    [10000, 1000, 1000000000, 27000000],
  ]) {
    const rates = LEAD_STATES.map((state) => state.code === 'TX' ? { ...state, price: unitPrice } : state);
    const card = calculateLeadQuote('TX', quantity, rates, 'card');
    const bank = calculateLeadQuote('TX', quantity, rates, 'bank');
    assert.equal(card.amountCents, subtotalCents);
    assert.equal(card.feeCents, feeCents);
    assert.equal(card.totalCents, subtotalCents + feeCents);
    assert.equal(bank.paymentMode, 'bank');
    assert.equal(bank.feeCents, 0);
    assert.equal(bank.totalCents, subtotalCents);
    assert.notEqual(leadQuoteKey(bank), leadQuoteKey(card), 'payment paths need distinct identities even when rounded totals match');
  }
  const metadata = leadMetadata(standard);
  assert.equal(metadata.payment_mode, 'card');
  assert.equal(metadata.subtotal_amount, '1000');
  assert.equal(metadata.payment_fee_percent, '2.7');
  assert.equal(metadata.payment_fee_amount, '27');
  assert.equal(metadata.total_amount, '1027');
  assert.equal(metadata.source, 'loudr-leads-site');
});

test('payment mode defaults only when omitted and rejects unrecognized values', () => {
  assert.equal(calculateLeadQuote('TX', 1).paymentMode, 'bank');
  for (const mode of [null, '', 'CARD', 'wire', 'ach', 'crypto', 0, false, {}, ['card']]) {
    assert.throws(() => calculateLeadQuote('TX', 1, undefined, mode));
  }
});
