#!/usr/bin/env node
// Turns the "Proposal form + Whop payments" n8n template into the website-connected workflow.
//
//   node integrations/n8n/build-website-workflow.mjs <template.n8n.json> [output.n8n.json]
//
// Only the front of the proposal flow changes: the n8n form pages ("Proposal form",
// "Price for state", "Leads and price") are replaced by a webhook the Loudr Team page
// calls, and the two form completion screens become webhook replies. Every GHL, Whop and
// Slack step, both settings nodes and the whole payment flow are kept exactly as they are.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const [templatePath, outputPath = "integrations/n8n/loudr-website-proposals.n8n.json"] = process.argv.slice(2);
if (!templatePath) {
  console.error("Usage: node integrations/n8n/build-website-workflow.mjs <template.n8n.json> [output.n8n.json]");
  process.exit(1);
}

const WEBHOOK = "Loudr website";
const REMOVED = ["Proposal form", "Price for state", "Leads and price"];
const workflow = JSON.parse(readFileSync(templatePath, "utf8"));
const node = (name) => {
  const found = workflow.nodes.find((item) => item.name === name);
  if (!found) throw new Error(`The template has no "${name}" node. Was it renamed?`);
  return found;
};
const replaceOnce = (text, from, to, where) => {
  if (text.split(from).length !== 2) throw new Error(`Expected exactly one "${from}" in ${where}.`);
  return text.replace(from, to);
};

// 1 · Webhook entry point, protected by a shared secret header.
const formPosition = node("Proposal form").position;
workflow.nodes = workflow.nodes.filter((item) => !REMOVED.includes(item.name));
workflow.nodes.push({
  parameters: {
    httpMethod: "POST", path: "loudr-website-proposal", authentication: "headerAuth",
    responseMode: "responseNode", options: {},
  },
  name: WEBHOOK, type: "n8n-nodes-base.webhook", typeVersion: 2.1, position: formPosition,
  webhookId: randomUUID(), id: randomUUID(),
  credentials: { httpHeaderAuth: { id: "", name: "Loudr website secret" } },
});
for (const name of REMOVED) delete workflow.connections[name];
workflow.connections[WEBHOOK] = { main: [[{ node: "Proposal settings", type: "main", index: 0 }]] };
workflow.connections["Proposal settings"] = { main: [[{ node: "Work out total", type: "main", index: 0 }]] };

// 2 · Read the website's order instead of the form pages. Output keys match the original
//     "Work out total" exactly, so every later GHL and Whop step works unchanged.
node("Work out total").parameters.jsCode = `// Reads the proposal sent by the Loudr website (Team page → Send Proposal).
// The website priced the order from its saved rate card; this checks the numbers and
// formats them into the same fields the original proposal form produced.
const body = $('${WEBHOOK}').first().json.body || {};
if (body.event !== 'loudr.proposal.send' || body.version !== 1) throw new Error('Unsupported website request. Re-import this workflow from the Loudr site repo.');
const reps = $('Proposal settings').first().json.config.reps;
const rep = String((body.rep || {}).name || '');
if (!reps[rep]) throw new Error('Rep "' + rep + '" is not in the reps map in Proposal settings');
const c = body.client || {}, o = body.order || {};
const rows = Array.isArray(o.states) ? o.states : [];
if (!rows.length || rows.length > 49) throw new Error('The order has no states');
const cents = (n, what) => { const v = Math.round(Number(n) * 100); if (!Number.isSafeInteger(v) || v <= 0 || Math.abs(Number(n) * 100 - v) > 1e-6) throw new Error('Invalid ' + what + ': ' + n); return v; };
const lines = rows.map(r => {
  const st = String(r.name || r.code || '').trim();
  const leads = Number(r.leads);
  if (!st || !Number.isSafeInteger(leads) || leads < 1) throw new Error('Invalid lead count for ' + st);
  const bankCents = cents(r.wire_price_per_lead, st + ' price per lead');
  // Card price per lead is shown 3% above wire, as before; the card total below is the website's.
  return {st, leads, bankCents, cardCents: Math.round(bankCents * 103 / 100)};
});
const states = lines.map(l => l.st);
const multi = lines.length > 1;
const bankTotalCents = cents(o.wire_total, 'wire total');
const cardTotalCents = cents(o.card_total, 'card total');
const feePercent = Number(o.card_fee_percent);
if (lines.reduce((a, l) => a + l.leads * l.bankCents, 0) !== bankTotalCents) throw new Error('Wire total does not add up from the states');
if (!(feePercent >= 0 && feePercent < 20) || cardTotalCents !== bankTotalCents + Math.round(bankTotalCents * feePercent / 100)) throw new Error('Card total does not match the wire total plus the card fee');
const money = n => '$' + n.toLocaleString('en-US', {minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2});
const leadCount = lines.reduce((a, l) => a + l.leads, 0);
const totalNumber = cardTotalCents / 100;
const bankTotalNumber = bankTotalCents / 100;
const leadsText = multi ? leadCount + '\\n' + lines.map(l => l.st + ': ' + l.leads).join('\\n') + '\\n' : String(leadCount);
const perLead = k => multi ? '\\n' + lines.map(l => l.st + ': ' + money(l[k] / 100)).join('\\n') + '\\n' : money(lines[0][k] / 100);
const leadsLine = multi ? leadCount + ' (' + lines.map(l => l.st + ' ' + l.leads).join(', ') + ')' : String(leadCount);
const perLeadLine = k => multi ? lines.map(l => l.st + ' ' + money(l[k] / 100)).join(', ') : money(lines[0][k] / 100);
const email = String(c.email || '').trim().toLowerCase();
if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) throw new Error('Client email is missing');
const firstName = String(c.first_name || '').trim(), firm = String(c.firm || '').trim();
if (!firstName || !firm) throw new Error('Client first name and law firm are required');
return [{json: {
  userId: reps[rep], rep,
  firstName, lastName: String(c.last_name || '').trim(), email,
  phone: String(c.phone || '').trim(), firm, state: states.join(', '),
  leads: leadsText, leadCount: String(leadCount), cpl: perLead('bankCents'), bankCpl: perLead('bankCents'),
  leadsLine, cplLine: perLeadLine('cardCents'), bankCplLine: perLeadLine('bankCents'), total: money(totalNumber), totalNumber,
  bankTotal: money(bankTotalNumber), bankTotalNumber,
  date: DateTime.now().setZone('America/Los_Angeles').toFormat('MMMM d, yyyy'),
  proposalId: String(body.proposal_id || ''),
}}];
`;

// 3 · Tag both Whop links with the website's proposal ID (kept on the Whop payment).
for (const name of ["Whop card link", "Whop bank link"]) {
  const params = node(name).parameters;
  params.jsonBody = replaceOnce(params.jsonBody, "state: t.state }", "state: t.state, proposal_id: t.proposalId }", name);
}

// 4 · Also retire the links the closer generated on the Team page (the website only passes
//     links it created for this Whop account). Never the links just made.
node("Old plan IDs").parameters.jsCode = `
const c = $('Read old links').first().json.contact || {};
const old = String(((c.customFields || []).find(f => f.id === $('Proposal settings').first().json.config.fields.planIds) || {}).value || '');
const fromSite = ($('${WEBHOOK}').first().json.body || {}).retire_plan_ids || [];
const keep = String($('Check links').first().json.plans).split(',');  // never shut off the links just made
const ids = [...old.split(','), ...(Array.isArray(fromSite) ? fromSite : [])].map(s => String(s).trim());
return [...new Set(ids)].filter(s => /^plan_[A-Za-z0-9]+$/.test(s) && !keep.includes(s)).map(id => ({ json: { id } }));
`;

// 5 · Replies to the website instead of form screens.
const sent = node("Sent");
sent.type = "n8n-nodes-base.respondToWebhook"; sent.typeVersion = 1.1; delete sent.webhookId;
sent.parameters = {
  respondWith: "json",
  responseBody: `={{ (() => {
  const t = $('Work out total').first().json;
  const links = $('Check links').first().json;
  const ref = (($json.links || [])[0] || {}).referenceId;
  return { sent: true, proposal_id: t.proposalId, email: t.email,
    signing_url: ref ? 'https://sendlink.co/documents/v1/' + ref + '?locale=en-US' : null,
    card_url: links.cardUrl, wire_url: links.bankUrl, card_total: t.total, wire_total: t.bankTotal, plan_ids: links.plans };
})() }}`,
  options: { responseCode: 200 },
};
const notSent = node("Not sent");
notSent.type = "n8n-nodes-base.respondToWebhook"; notSent.typeVersion = 1.1; delete notSent.webhookId;
notSent.parameters = {
  respondWith: "json",
  responseBody: `={{ (() => {
  const e = $json.error;
  const why = typeof e === 'string' ? e : (e && (e.description || e.message)) || $json.message || 'GHL did not confirm the proposal was sent.';
  return { sent: false, error: 'Proposal NOT sent: ' + String(why).slice(0, 240) + ' Payment links may already exist; check this n8n execution and GHL before retrying.',
    proposal_id: ($('${WEBHOOK}').first().json.body || {}).proposal_id || null };
})() }}`,
  options: { responseCode: 502 },
};

// 6 · Notes and name.
node("START HERE").parameters.content = `## Loudr website proposals: setup once
1. Select GHL API key, Whop API key and Slack bot credentials (as before).
2. On "${WEBHOOK}", create a Header Auth credential "Loudr website secret": Name = X-Loudr-Secret, Value = a long random secret.
3. Confirm IDs in Proposal settings AND Payment settings. Rep names must match the site's TEAM_REP_NAMES.
4. Paste the complete Whop ws_ signing secret in Sign. Put the card/wire fields in your GHL proposal.
5. Publish. Put the production URL of "${WEBHOOK}" and the same secret in the site's Vercel settings.
See integrations/n8n/README.md in the site repo.`;
node("Proposal flow").parameters.content = `## 1 · Send a proposal (from the Loudr Team page)
Website prices the deal from its rate card (any number of states, budget or lead count).
Same steps as before: GHL contact → Whop card + wire links → save on contact → send proposal.
Replies to the website with the signing link and both payment links. Old links (and links the closer generated) are retired only after GHL confirms sending.`;
workflow.name = "Loudr | Website proposals + Whop payments";
workflow.active = false;

// Every connection must point at a node that exists, and nothing may still read the form.
const names = new Set(workflow.nodes.map((item) => item.name));
for (const [from, outputs] of Object.entries(workflow.connections)) {
  if (!names.has(from)) throw new Error(`Connection from missing node "${from}".`);
  for (const branch of outputs.main ?? []) for (const target of branch ?? []) {
    if (!names.has(target.node)) throw new Error(`Connection to missing node "${target.node}".`);
  }
}
const text = JSON.stringify(workflow);
for (const name of REMOVED) if (text.includes(`$('${name}')`)) throw new Error(`A node still reads "${name}".`);

writeFileSync(outputPath, JSON.stringify(workflow, null, 2) + "\n");
console.log(`Wrote ${outputPath}`);
