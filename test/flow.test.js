import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.TOOL_TOKEN = 'test-token';
const { openDb, clearSamples } = await import('../src/db.js');
const { addDays, nextWeekday, normalizePhone, isDialable, parseBudgetLakh, parseBhk, parseCsv, parseTime, clean, todayIST } = await import('../src/parse.js');
const { bookVisit, checkSlots, getProjectDetails, scheduleCallback, searchProjects, updateLead } = await import('../src/tools.js');
const { dialBlocker, dialLead, handleExecutionEvent, runCampaign } = await import('../src/calls.js');
const { buildAgent } = await import('../src/agent-config.js');
const { createApp } = await import('../src/server.js');

const fresh = () => openDb(':memory:');
const saturday = () => nextWeekday(todayIST(), 6);
const newLead = (db, status = 'new') => Number(db.prepare("INSERT INTO leads (name, phone, consent, status) VALUES ('Test', '+919812345678', 1, ?)").run(status).lastInsertRowid);
const leadRow = (db, id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

test('parsers accept what people say on calls', () => {
  assert.equal(parseBudgetLakh('1.5 crore'), 150);
  assert.equal(parseBudgetLakh('₹1.2 Cr'), 120);
  assert.equal(parseBudgetLakh('90 lakh'), 90);
  assert.equal(parseBudgetLakh('15000000'), 150);
  assert.equal(parseBudgetLakh('any'), null);
  assert.equal(parseBhk('three BHK'), 3);
  assert.equal(parseTime('2:30 PM'), '14:30');
  assert.equal(parseTime('12 am'), '00:00');
  assert.equal(parseTime('10 AM'), '10:00');
  assert.equal(clean('%(budget)s'), null);
});

test('sample numbers can never be dialled, real ones can', () => {
  assert.equal(isDialable('+910000000001'), false);
  assert.equal(isDialable('+919812345678'), true);
  assert.equal(normalizePhone('98123 45678'), '+919812345678');
  assert.equal(normalizePhone('12345'), null);
});

test('csv handles quotes and a BOM', () => {
  const rows = parseCsv('﻿Name,Phone,Enquiry\r\n"Shah, K",9812345678,"said ""hi"""\r\n');
  assert.deepEqual(rows, [{ name: 'Shah, K', phone: '9812345678', enquiry: 'said "hi"' }]);
});

test('search crosses the portfolio and stays honest about budget', () => {
  const db = fresh();
  const r = searchProjects(db, { location: 'Sarjapur', bhk: '3', budget: '1.5 crore' });
  assert.deepEqual(r.matches.map((m) => m.project), ['Sarjapur Residences']);
  assert.equal(r.matches[0].units[0].bhk, '3 BHK');
  assert.ok(r.alternatives.some((a) => a.project === 'Whitefield Heights' && /located in/.test(a.why_not_exact)));

  const none = searchProjects(db, { location: 'Sarjapur Road', bhk: '4', budget: '1 crore' });
  assert.equal(none.match_count, 0);
  assert.match(none.alternatives.find((a) => a.project === 'Sarjapur Residences').why_not_exact, /above budget/);

  assert.equal(searchProjects(db, { location: 'Hebbal', bhk: 'any', budget: 'any' }).match_count, 0);
  assert.equal(searchProjects(db, { location: 'any', bhk: 'any', budget: 'any' }).match_count, 3);
});

test('search saves stated requirements without waiting for update_lead', () => {
  const db = fresh();
  const lead = newLead(db);
  searchProjects(db, { lead_id: String(lead), location: 'Whitefield', bhk: '3', budget: '7 crore' });
  searchProjects(db, { lead_id: String(lead), location: 'any', bhk: '2', budget: 'any' });
  const l = leadRow(db, lead);
  assert.deepEqual([l.pref_location, l.pref_bhk, l.budget_lakh], ['Whitefield', 2, 700]);
});

test('an after-hours request gets the closest time that day', () => {
  const db = fresh();
  const r = checkSlots(db, { project: 'Whitefield', date: addDays(saturday(), 4), time: '6 PM' });
  assert.equal(r.requested_time_available, false);
  assert.equal(r.closest_open_time, '4 PM');
});

test('sold out units are not offered', () => {
  const db = fresh();
  const p = db.prepare("SELECT id, configs FROM projects WHERE name = 'Sarjapur Residences'").get();
  const configs = JSON.parse(p.configs).map((c) => ({ ...c, units_left: c.bhk === 4 ? 0 : c.units_left }));
  db.prepare('UPDATE projects SET configs = ? WHERE id = ?').run(JSON.stringify(configs), p.id);
  assert.equal(searchProjects(db, { location: 'Sarjapur', bhk: '4', budget: 'any' }).match_count, 0);
});

test('details resolve loose names and support comparison', () => {
  const db = fresh();
  const r = getProjectDetails(db, { project_names: 'whitefield heights and the sarjapur project' });
  assert.deepEqual(r.projects.map((p) => p.project), ['Whitefield Heights', 'Sarjapur Residences']);
  assert.equal(getProjectDetails(db, { project_names: 'Nonsense Towers' }).ok, false);
});

test('a taken slot offers alternatives and cannot be booked', () => {
  const db = fresh();
  const lead = newLead(db);
  const check = checkSlots(db, { project: 'Whitefield', date: saturday(), time: '10 AM' });
  assert.equal(check.requested_time_available, false);
  assert.ok(check.open_times.length > 0);
  assert.equal(bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '10 AM' }).confirmed, false);
});

test('booking is confirmed once, retries are idempotent, a new time reschedules', () => {
  const db = fresh();
  const lead = newLead(db);
  const args = { lead_id: String(lead), project: 'Whitefield Heights', date: saturday(), time: '11:30 AM' };
  assert.equal(bookVisit(db, args).confirmed, true);
  assert.equal(bookVisit(db, args).already_booked, true);
  assert.equal(bookVisit(db, { ...args, time: '2 PM' }).rescheduled, true);
  const rows = db.prepare("SELECT time, status FROM appointments WHERE lead_id = ? ORDER BY id").all(lead);
  assert.deepEqual(rows.map((r) => [r.time, r.status]), [['11:30', 'cancelled'], ['14:00', 'scheduled']]);
});

test('rejects past dates, off-grid times and unknown leads', () => {
  const db = fresh();
  const lead = newLead(db);
  assert.equal(bookVisit(db, { lead_id: lead, project: 'Whitefield', date: todayIST(), time: '10 AM' }).ok, false);
  assert.equal(bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '3 AM' }).ok, false);
  assert.equal(bookVisit(db, { lead_id: 9999, project: 'Whitefield', date: saturday(), time: '11:30 AM' }).ok, false);
  assert.equal(checkSlots(db, { project: 'Whitefield', date: 'Saturday', time: 'any' }).ok, false);
});

test('full call: visit makes the lead hot and the rep gets the summary', () => {
  const db = fresh();
  const lead = newLead(db);
  db.prepare("INSERT INTO calls (execution_id, lead_id, created_at) VALUES ('e1', ?, datetime('now', '-1 minute'))").run(lead);
  handleExecutionEvent(db, { id: 'e1', status: 'in-progress', user_number: '+919812345678' });
  bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '11:30 AM' });
  updateLead(db, { lead_id: lead, location: 'Whitefield', bhk: '3', budget: '1.5 crore', purpose: 'Self use', timeline: 'unknown', interested_project: 'Whitefield Heights', status: 'warm', do_not_call: 'false' });
  handleExecutionEvent(db, { id: 'e1', status: 'call-disconnected' });
  const done = { id: 'e1', status: 'completed', transcript: 'assistant: Hi\nuser: Hello', conversation_duration: 212, summary: 'Wants 3 BHK.', telephony_data: { recording_url: 'https://x/r' } };
  handleExecutionEvent(db, done);
  handleExecutionEvent(db, done);
  handleExecutionEvent(db, { id: 'e1', status: 'in-progress' });

  const l = leadRow(db, lead);
  assert.equal(l.status, 'hot');
  assert.equal(l.budget_lakh, 150);
  assert.equal(l.summary, 'Wants 3 BHK.');
  const call = db.prepare("SELECT * FROM calls WHERE execution_id = 'e1'").get();
  assert.deepEqual([call.status, call.connected, call.duration], ['completed', 1, 212]);
  assert.equal(db.prepare('SELECT notes FROM appointments WHERE lead_id = ?').get(lead).notes, 'Wants 3 BHK.');
});

test('no answer marks unreachable but never downgrades a qualified lead', () => {
  const db = fresh();
  const a = newLead(db);
  db.prepare("INSERT INTO calls (execution_id, lead_id) VALUES ('e2', ?)").run(a);
  handleExecutionEvent(db, { id: 'e2', status: 'no-answer' });
  assert.equal(leadRow(db, a).status, 'unreachable');
  db.prepare("UPDATE leads SET status = 'hot' WHERE id = ?").run(a);
  db.prepare("INSERT INTO calls (execution_id, lead_id) VALUES ('e3', ?)").run(a);
  handleExecutionEvent(db, { id: 'e3', status: 'busy' });
  assert.equal(leadRow(db, a).status, 'hot');
});

test('opt-out blocks future dialling', async () => {
  const db = fresh();
  const lead = newLead(db);
  updateLead(db, { lead_id: lead, status: 'not_interested', do_not_call: 'true' });
  const row = leadRow(db, lead);
  assert.equal(row.do_not_call, 1);
  assert.equal(dialBlocker(row), 'on do-not-call list');
  assert.equal((await dialLead(db, row)).ok, false);
});

test('leads without consent are refused and campaigns report skips', async () => {
  const db = fresh();
  process.env.BOLNA_API_KEY = 'k'; process.env.BOLNA_AGENT_ID = 'a';
  const good = newLead(db);
  const noConsent = Number(db.prepare("INSERT INTO leads (name, phone, consent) VALUES ('N', '+919812345679', 0)").run().lastInsertRowid);
  const sample = db.prepare('SELECT id FROM leads WHERE is_sample = 1').get().id;
  const { lastInsertRowid: c } = db.prepare("INSERT INTO campaigns (name) VALUES ('T')").run();
  for (const id of [good, noConsent, sample]) db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(c, id);
  const dialled = [];
  const fakeFetch = async (_u, o) => { dialled.push(JSON.parse(o.body)); return new Response(JSON.stringify({ execution_id: 'x1' }), { status: 200 }); };
  await runCampaign(db, c, fakeFetch, 0);
  delete process.env.BOLNA_API_KEY; delete process.env.BOLNA_AGENT_ID;
  assert.deepEqual(dialled.map((d) => d.recipient_phone_number), ['+919812345678']);
  assert.equal(dialled[0].user_data.lead_id, String(good));
  assert.match(dialled[0].user_data.portfolio_brief, /Sarjapur Residences/);
  const states = db.prepare('SELECT state, COUNT(*) n FROM campaign_leads GROUP BY state ORDER BY state').all();
  assert.deepEqual(states.map((s) => [s.state, s.n]), [['dialled', 1], ['skipped', 2]]);
});

test('callback records and clearing samples removes demo data', () => {
  const db = fresh();
  const lead = newLead(db);
  const r = scheduleCallback(db, { lead_id: lead, date: addDays(todayIST(), 1), time: '6 PM', topic: 'Payment plan' });
  assert.equal(r.confirmed, true);
  scheduleCallback(db, { lead_id: lead, date: addDays(todayIST(), 1), time: '6 PM', topic: 'Payment plan' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE lead_id = ? AND type = 'callback'").get(lead).n, 1);
  clearSamples(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, 1);
});

test('agent config: disclosure, tools and parameters line up', () => {
  const a = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't' });
  assert.match(a.agent_config.agent_welcome_message, /AI assistant/);
  const { tools, tools_params } = a.agent_config.tasks[0].tools_config.api_tools;
  assert.equal(tools.length, 6);
  for (const t of tools) {
    assert.equal(t.key, 'custom_task');
    assert.deepEqual(Object.keys(tools_params[t.name].param).sort(), Object.keys(t.parameters.properties).sort());
  }
});

test('http: tools need the token, dashboard password works', async () => {
  const db = fresh();
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, headers, body = '{}') => fetch(base + p, { method: 'POST', headers, body });
  try {
    assert.equal((await post('/tools/search_projects', {})).status, 401);
    assert.equal((await post('/tools/constructor', { Authorization: 'Bearer test-token' })).status, 404);
    const ok = await post('/tools/search_projects', { Authorization: 'Bearer test-token' }, '{"location":"Sarjapur","bhk":"any","budget":"any"}');
    assert.equal((await ok.json()).match_count, 1);
    assert.equal((await post('/webhooks/bolna?token=bad', {})).status, 401);
    process.env.DASHBOARD_PASSWORD = 'pw';
    assert.equal((await fetch(`${base}/api/leads`)).status, 401);
    const auth = `Basic ${Buffer.from('admin:pw').toString('base64')}`;
    assert.equal((await fetch(`${base}/api/leads`, { headers: { Authorization: auth } })).status, 200);
  } finally {
    delete process.env.DASHBOARD_PASSWORD;
    server.close();
  }
});
