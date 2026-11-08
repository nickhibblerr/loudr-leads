const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./load-ts.cjs');
const leads = loadTypeScript('lib/leads.ts');
const theme = loadTypeScript('lib/theme.ts');

test('lead packages are Starter 50, Optimal 100 and Scale 200', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(leads.LEAD_TIERS.map((t) => [t.name, t.count]))), [['Starter', 50], ['Optimal', 100], ['Scale', 200]]);
  assert.deepEqual(JSON.parse(JSON.stringify(leads.LEAD_PRESETS)), [50, 100, 200]);
});

test('guidance follows the tiers and the 200+ message appears from 200 leads', () => {
  assert.equal(leads.leadGuidance(49), null);
  assert.equal(leads.leadGuidance(50).tier, 'starter');
  assert.equal(leads.leadGuidance(199).tier, 'optimal');
  assert.equal(leads.leadGuidance(100).tier, 'optimal');
  const scale = leads.leadGuidance(200);
  assert.equal(scale.tier, 'scale');
  assert.match(scale.description, /sign more cases and see better results at 200\+ leads/);
  assert.equal(leads.leadGuidance(950).tier, 'scale');
});

test('the theme boot script only switches to dark for a saved dark preference', () => {
  const run = (saved, throws = false) => {
    const html = { dataset: {} };
    new Function('localStorage', 'document', theme.THEME_BOOT_SCRIPT)({ getItem: () => { if (throws) throw new Error('blocked'); return saved; } }, { documentElement: html });
    return html.dataset.theme;
  };
  assert.equal(run('dark'), 'dark');
  assert.equal(run('light'), undefined);
  assert.equal(run(null), undefined, 'light is the default');
  assert.equal(run('dark', true), undefined, 'blocked storage falls back to light');
});
