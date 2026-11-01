import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.TOOL_TOKEN = 'test-token';
// Set before config loads, so a developer's real .env can never reach these tests.
for (const name of ['BOLNA_API_KEY', 'BOLNA_AGENT_ID', 'DASHBOARD_PASSWORD', 'PUBLIC_URL', 'BOLNA_FROM_NUMBER', 'TEST_PHONES']) process.env[name] = '';
const { openDb, clearSamples } = await import('../src/db.js');
const { addDays, nextWeekday, normalizePhone, isDialable, parseBudgetLakh, parseBhk, parseCsv, parseTime, clean, todayIST } = await import('../src/parse.js');
const { bookVisit, checkSlots, doNotCall, getProjectDetails, scheduleCallback, searchProjects, updateLead } = await import('../src/tools.js');
const { dialBlocker, dialLead, handleExecutionEvent, portfolioBrief, runCampaign, withinCallingHours } = await import('../src/calls.js');
const { buildAgent, SYSTEM_PROMPT, WELCOME, keywordsFor } = await import('../src/agent-config.js');
const { createApp } = await import('../src/server.js');
const { allProjects } = await import('../src/db.js');
const { bestQuote, recentActivity } = await import('../src/activity.js');
const { stopCampaign } = await import('../src/calls.js');
const { config } = await import('../src/config.js');
const net = await import('node:net');
const nodeHttp = await import('node:http');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { spawnSync } = await import('node:child_process');

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
  const states = db.prepare('SELECT state, COUNT(*) n FROM campaign_leads WHERE campaign_id = ? GROUP BY state ORDER BY state').all(c);
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
  assert.deepEqual(tools.map((x) => x.name), ['do_not_call', 'book_visit', 'schedule_callback']);
  for (const t of tools) {
    assert.equal(t.key, 'custom_task');
    assert.deepEqual(Object.keys(tools_params[t.name].param).sort(), Object.keys(t.parameters.properties).sort());
  }
});

test('http: tools need the token', async () => {
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
  } finally {
    server.close();
  }
});

const DASHBOARD = { 'x-propreach-client': 'dashboard' };
const WITH_CREDS = () => { process.env.BOLNA_API_KEY = 'k'; process.env.BOLNA_AGENT_ID = 'a'; };
const NO_CREDS = () => { delete process.env.BOLNA_API_KEY; delete process.env.BOLNA_AGENT_ID; };
const okFetch = (log) => async (_u, o) => {
  log.push(JSON.parse(o.body));
  return new Response(JSON.stringify({ execution_id: `x${log.length}` }), { status: 200 });
};
const startCall = (db, id, lead) => db.prepare("INSERT INTO calls (execution_id, lead_id, created_at) VALUES (?, ?, datetime('now', '-1 minute'))").run(id, lead);
const addCampaign = (db, ...leads) => {
  const c = db.prepare("INSERT INTO campaigns (name) VALUES ('T')").run().lastInsertRowid;
  for (const l of leads) db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(c, l);
  return c;
};

test('budgets come out right however they are spoken', () => {
  const cases = {
    '1 crore 20 lakh': 120, '1 crore 35 lakh': 135, '1 to 1.5 crore': 150, '80 to 90 lakh': 90,
    'between 90 lakh and 1.2 crore': 120, 'ninety lakh': 90, 'one crore': 100, 'one and a half crore': 150,
    'one point five crore': 150, 'dedh crore': 150, 'डेढ़ करोड़': 150, '१.५ करोड़': 150, '15 लाख': 15, '1.5cr': 150,
    '1.35 crore rupees': 135, 'Rs. 90 lakh': 90, '90': 90, '1.5': 150,
  };
  for (const [spoken, lakh] of Object.entries(cases)) assert.equal(parseBudgetLakh(spoken), lakh, spoken);
});

test('bare hours mean daytime, and part-of-day words work', () => {
  const cases = { 'after 6': '18:00', 'at 4': '16:00', 'after six': '18:00', evening: '18:00', morning: '10:00', afternoon: '14:00', '6 in the morning': '06:00', '9': '09:00', '६ बजे': '18:00', 'शाम': '18:00' };
  for (const [spoken, time] of Object.entries(cases)) assert.equal(parseTime(spoken), time, spoken);
  assert.equal(parseBhk('३ बीएचके'), 3);
  assert.equal(parseBudgetLakh('no preference'), null);
  assert.equal(clean('anywhere'), null);
  assert.equal(normalizePhone('09812345678'), '+919812345678');
});

test('csv accepts the headers builders really export', () => {
  assert.deepEqual(parseCsv('Full Name,Mobile Number\nAsha,9812345678\n'), [{ name: 'Asha', phone: '9812345678' }]);
});

test('non-Latin location is not treated as no filter', () => {
  assert.equal(searchProjects(fresh(), { location: 'हेब्बल', bhk: 'any', budget: 'any' }).match_count, 0);
});

test('search volunteers the best other project with a reason', () => {
  const r = searchProjects(fresh(), { location: 'Whitefield', bhk: '3', budget: '1.5 crore' });
  assert.equal(r.matches[0].project, 'Whitefield Heights');
  assert.match(r.also_consider, /^Sarjapur Residences.*15 lakh less, 140 square feet larger/);
  const tight = searchProjects(fresh(), { location: 'Whitefield', bhk: '2', budget: '95 lakh' });
  assert.match(tight.also_consider, /Electronic City Homes/);
});

test('a sold out project never says no null BHK', () => {
  const db = fresh();
  const p = db.prepare("SELECT id, configs FROM projects WHERE name = 'Sarjapur Residences'").get();
  db.prepare('UPDATE projects SET configs = ? WHERE id = ?').run(JSON.stringify(JSON.parse(p.configs).map((c) => ({ ...c, units_left: 0 }))), p.id);
  const alt = searchProjects(db, { location: 'any', bhk: 'any', budget: '1 lakh' }).alternatives.find((a) => a.project === 'Sarjapur Residences');
  assert.equal(alt.why_not_exact, 'sold out');
});

test('an ambiguous project name asks instead of booking the wrong site', () => {
  const db = fresh();
  assert.equal(checkSlots(db, { project: 'Sarjapur Heights', date: saturday(), time: 'any' }).ok, false);
  assert.equal(checkSlots(db, { project: 'Bengaluru', date: saturday(), time: 'any' }).ok, false);
  assert.equal(checkSlots(db, { project: 'sarjapur', date: saturday(), time: 'any' }).ok, true);
});

test('one buyer cannot hold two sites at once, and one rep cannot be in two places', () => {
  const db = fresh();
  const a = newLead(db);
  const b = Number(db.prepare("INSERT INTO leads (name, phone, consent) VALUES ('B', '+919812345679', 1)").run().lastInsertRowid);
  const when = { date: saturday(), time: '11:30 AM' };
  assert.equal(bookVisit(db, { lead_id: a, project: 'Whitefield', ...when }).confirmed, true);
  assert.equal(bookVisit(db, { lead_id: a, project: 'Sarjapur', ...when }).confirmed, false);
  assert.equal(bookVisit(db, { lead_id: b, project: 'Sarjapur', ...when }).confirmed, true);
  const reps = db.prepare("SELECT rep_id FROM appointments WHERE date = ? AND time = '11:30' AND status = 'scheduled'").all(saturday()).map((r) => r.rep_id);
  assert.equal(new Set(reps).size, 2);
});

test('callbacks refuse past and night times, and a new time replaces the old one', () => {
  const db = fresh();
  const lead = newLead(db);
  const evening = new Date('2026-11-02T12:30:00Z'); // 6 PM IST
  assert.equal(scheduleCallback(db, { lead_id: lead, date: '2026-11-02', time: '10 AM', topic: 'x' }, evening).ok, false);
  assert.equal(scheduleCallback(db, { lead_id: lead, date: '2026-11-03', time: '3 AM', topic: 'x' }, evening).ok, false);
  scheduleCallback(db, { lead_id: lead, date: '2026-11-03', time: '6 PM', topic: 'x' }, evening);
  scheduleCallback(db, { lead_id: lead, date: '2026-11-03', time: '7 PM', topic: 'x' }, evening);
  const open = db.prepare("SELECT time FROM appointments WHERE lead_id = ? AND status = 'scheduled'").all(lead);
  assert.deepEqual(open.map((a) => a.time), ['19:00']);
});

test('opting out cancels booked visits and callbacks', () => {
  const db = fresh();
  const lead = newLead(db);
  bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '11:30 AM' });
  updateLead(db, { lead_id: lead, status: 'not_interested', do_not_call: 'true' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE lead_id = ? AND status = 'scheduled'").get(lead).n, 0);
  assert.equal(leadRow(db, lead).next_action, 'None');
});

test('notes reach the sales team without repeating', () => {
  const db = fresh();
  const lead = newLead(db);
  updateLead(db, { lead_id: lead, status: 'warm', notes: 'Send brochure' });
  updateLead(db, { lead_id: lead, status: 'warm', notes: 'Send brochure' });
  assert.equal(leadRow(db, lead).next_action, 'Send brochure');
});

test('a booking survives the call ending badly', () => {
  const db = fresh();
  const lead = newLead(db);
  startCall(db, 'e4', lead);
  bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '11:30 AM' });
  handleExecutionEvent(db, { id: 'e4', status: 'failed' });
  const l = leadRow(db, lead);
  assert.equal(l.status, 'hot');
  assert.match(l.next_action, /Site visit/);
});

test('voicemail is not a conversation', () => {
  const db = fresh();
  const lead = newLead(db);
  startCall(db, 'e5', lead);
  handleExecutionEvent(db, { id: 'e5', status: 'completed', termination_reason: 'voicemail_reached', transcript: 'assistant: Hi\nuser: Please leave a message' });
  assert.equal(db.prepare("SELECT connected FROM calls WHERE execution_id = 'e5'").get().connected, 0);
  assert.equal(leadRow(db, lead).status, 'unreachable');
});

test('extraction rescues a missed opt-out and a missed classification', () => {
  const db = fresh();
  const a = newLead(db);
  startCall(db, 'e6', a);
  bookVisit(db, { lead_id: a, project: 'Whitefield', date: saturday(), time: '11:30 AM' });
  handleExecutionEvent(db, { id: 'e6', status: 'completed', transcript: 'user: stop calling me',
    extracted_data: { 'Lead Outcome': { 'Do Not Call': { objective: 'Yes' } } } });
  const l = leadRow(db, a);
  assert.deepEqual([l.do_not_call, l.status], [1, 'not_interested']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE lead_id = ? AND status = 'scheduled'").get(a).n, 0);

  const b = Number(db.prepare("INSERT INTO leads (name, phone, consent) VALUES ('B', '+919812345679', 1)").run().lastInsertRowid);
  startCall(db, 'e7', b);
  handleExecutionEvent(db, { id: 'e7', status: 'completed', transcript: 'user: still comparing',
    extracted_data: { 'Lead Outcome': { 'Do Not Call': { objective: 'No' }, 'Lead Status': { objective: 'warm' } } } });
  assert.equal(leadRow(db, b).status, 'warm');
});

test('a retry that fails cannot wipe a good summary', () => {
  const db = fresh();
  const lead = newLead(db, 'hot');
  db.prepare("UPDATE leads SET summary = 'Keen buyer' WHERE id = ?").run(lead);
  startCall(db, 'e8', lead);
  handleExecutionEvent(db, { id: 'e8', status: 'no-answer', summary: 'No conversation took place.' });
  assert.equal(leadRow(db, lead).summary, 'Keen buyer');
});

test('dialling guards: opt-out mid-campaign, concurrent clicks, repeat campaigns, booked buyers', async () => {
  WITH_CREDS();
  try {
    const db = fresh();
    const a = newLead(db);
    const b = Number(db.prepare("INSERT INTO leads (name, phone, consent) VALUES ('B', '+919812345679', 1)").run().lastInsertRowid);
    const log = [];
    const optOutB = async (u, o) => {
      updateLead(db, { lead_id: b, status: 'not_interested', do_not_call: 'true' });
      return okFetch(log)(u, o);
    };
    await runCampaign(db, addCampaign(db, a, b), optOutB, 0);
    assert.deepEqual(log.map((d) => d.recipient_phone_number), ['+919812345678']);

    const c = Number(db.prepare("INSERT INTO leads (name, phone, consent) VALUES ('C', '+919812345670', 1)").run().lastInsertRowid);
    const lead = leadRow(db, c);
    const [first, second] = await Promise.all([dialLead(db, lead, null, okFetch(log)), dialLead(db, lead, null, okFetch(log))]);
    assert.deepEqual([first.ok, second.error], [true, 'already being dialled']);

    const before = log.length;
    const repeat = addCampaign(db, a);
    await runCampaign(db, repeat, okFetch(log), 0);
    assert.equal(log.length, before);
    assert.equal(db.prepare('SELECT detail FROM campaign_leads WHERE campaign_id = ?').get(repeat).detail, 'already called recently');
  } finally { NO_CREDS(); }
});

test('a rate limit is retried once rather than skipping the lead', async () => {
  WITH_CREDS();
  try {
    const db = fresh();
    const lead = newLead(db);
    let tries = 0;
    const flaky = async () => (++tries === 1 ? new Response('{}', { status: 429 }) : new Response('{"execution_id":"r1"}', { status: 200 }));
    const c = addCampaign(db, lead);
    await runCampaign(db, c, flaky, 0, 0);
    assert.equal(db.prepare('SELECT state FROM campaign_leads WHERE campaign_id = ?').get(c).state, 'dialled');
  } finally { NO_CREDS(); }
});

test('every prompt variable is supplied at dial time, and repeat calls carry memory', async () => {
  WITH_CREDS();
  try {
    const db = fresh();
    const lead = newLead(db);
    db.prepare("UPDATE leads SET pref_bhk = 3, pref_location = 'Whitefield', budget_lakh = 150, name = 'Mr. Sharma' WHERE id = ?").run(lead);
    bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '11:30 AM' });
    const log = [];
    await dialLead(db, leadRow(db, lead), null, okFetch(log));
    const data = log[0].user_data;
    const agent = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't', webhookToken: 'w', voiceProfile: 'sarvam', projects: allProjects(db) });
    const hindi = agent.agent_config.tasks[0].tools_config.multilingual_config.languages.hi.system_prompt;
    const used = [...`${SYSTEM_PROMPT} ${WELCOME} ${hindi}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    for (const name of new Set(used)) assert.ok(data[name], `missing user_data for {{${name}}}`);
    assert.equal(data.customer_name, 'Sharma');
    assert.match(data.known_so_far, /3 BHK, Whitefield, budget 1 crore 50 lakh.*Visit booked: Whitefield Heights/);
  } finally { NO_CREDS(); }
});

test('agent stays inside the limits Bolna enforces', () => {
  const db = fresh();
  const agent = buildAgent({ publicUrl: 'https://x.dev', toolToken: 'tool', webhookToken: 'hook', voiceProfile: 'sarvam', projects: allProjects(db) });
  const tools = agent.agent_config.tasks[0].tools_config;
  assert.ok(keywordsFor(allProjects(db)).split(', ').length <= 50);
  assert.match(tools.transcriber.keywords, /Sarjapur Residences/);
  assert.deepEqual(Object.keys(tools.multilingual_config.languages), ['en', 'hi']);
  assert.match(agent.agent_config.webhook_url, /token=hook$/);
  assert.ok(!JSON.stringify(tools.api_tools).includes('hook'));
  const plain = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't', webhookToken: 'w', voiceProfile: 'default' }).agent_config.tasks[0].tools_config;
  assert.equal(plain.multilingual_config, undefined);
  assert.equal(plain.api_tools.tools[1].pre_call_message, 'One second.');
});

test('scorecard and funnel count people, not attempts', async () => {
  const db = fresh();
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const o = await (await fetch(`${base}/api/overview`)).json();
    assert.ok(o.connectedLeads <= o.attemptedLeads && o.attemptedLeads <= o.leads);
    assert.ok(o.hot <= o.qualified && o.qualified <= o.interested);
    assert.equal(o.hotBudgetLakh, 150);
    const [c] = await (await fetch(`${base}/api/campaigns`)).json();
    assert.deepEqual([c.dialled, c.reached, c.interested, c.visits], [5, 4, 3, 1]);
    const calls = await (await fetch(`${base}/api/calls`)).json();
    assert.ok(calls.every((x) => x.campaign === 'Sample: enquiry follow-up' && x.project === 'Whitefield Heights' && x.lead_status));
  } finally { server.close(); }
});

test('cancelling an appointment updates the lead, and bad ids and slots are handled', async () => {
  const db = fresh();
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: DASHBOARD, body: JSON.stringify(body) });
  try {
    const appt = db.prepare("SELECT * FROM appointments WHERE type = 'visit' LIMIT 1").get();
    assert.equal((await post(`/api/appointments/${appt.id}`, { status: 'cancelled' })).status, 200);
    assert.equal(leadRow(db, appt.lead_id).next_action, 'Rebook or follow up');
    assert.equal((await post('/api/appointments/9999', { status: 'cancelled' })).status, 404);
    const rival = newLead(db);
    bookVisit(db, { lead_id: rival, project: 'Whitefield', date: appt.date, time: appt.time });
    assert.equal((await post(`/api/appointments/${appt.id}`, { status: 'scheduled' })).status, 409);
    process.env.BOLNA_API_KEY = 'k'; process.env.BOLNA_AGENT_ID = 'a';
    assert.equal((await post('/api/campaigns', { name: 'X', lead_ids: [99999] })).status, 400);
    assert.equal((await post('/api/campaigns', { name: 'X', lead_ids: 'nope' })).status, 400);
  } finally { NO_CREDS(); server.close(); }
});

test('http: a malformed path cannot crash the server, and split Hindi survives', async () => {
  const db = fresh();
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const raw = (lines) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(lines));
    socket.setTimeout(1500, () => socket.destroy()); // a dead server must fail this test, not hang it
    let out = '';
    socket.on('data', (d) => { out += d; });
    socket.on('close', () => resolve(out));
    socket.on('error', () => resolve(out));
  });
  try {
    assert.match(await raw('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /HTTP\/1\.1 \d{3}/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })).status, 200);

    const lead = newLead(db);
    startCall(db, 'e9', lead);
    const body = Buffer.from(JSON.stringify({ id: 'e9', status: 'completed', transcript: 'user: नमस्ते' }));
    const cut = body.indexOf(0xE0) + 1; // inside the first Hindi character
    await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', async () => {
        socket.write(`POST /webhooks/bolna?token=${config.webhookToken} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`);
        socket.write(body.subarray(0, cut));
        await new Promise((r) => setTimeout(r, 20));
        socket.write(body.subarray(cut));
      });
      socket.on('data', () => {});
      socket.on('close', resolve);
    });
    assert.equal(db.prepare("SELECT transcript FROM calls WHERE execution_id = 'e9'").get().transcript, 'user: नमस्ते');
    assert.equal((await fetch(`http://127.0.0.1:${port}/webhooks/bolna?token=${config.toolToken}`, { method: 'POST', body: '{}' })).status, 401);
  } finally { server.close(); }
});

const withApp = async (fn, options) => {
  const db = fresh();
  const server = createApp(db, options).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ db, base, port: server.address().port }); } finally { server.close(); }
};
const withPassword = async (fn, options) => {
  process.env.DASHBOARD_PASSWORD = 'correct-horse-battery';
  try { await withApp(fn, options); } finally { delete process.env.DASHBOARD_PASSWORD; }
};
const signIn = (base, password) => fetch(`${base}/login`, { method: 'POST', headers: DASHBOARD, body: JSON.stringify({ password }) });

test('no secret reaches any response, even with every route called', async () => {
  const canaries = { BOLNA_API_KEY: 'bn-canary-bolna-key', BOLNA_AGENT_ID: 'canary-agent-id', TOOL_TOKEN: process.env.TOOL_TOKEN, DASHBOARD_PASSWORD: 'canary-password-long' };
  const previous = { key: process.env.BOLNA_API_KEY, agent: process.env.BOLNA_AGENT_ID };
  process.env.BOLNA_API_KEY = canaries.BOLNA_API_KEY; process.env.BOLNA_AGENT_ID = canaries.BOLNA_AGENT_ID;
  process.env.DASHBOARD_PASSWORD = canaries.DASHBOARD_PASSWORD;
  try {
    await withApp(async ({ base, db }) => {
      const lead = newLead(db);
      db.prepare("INSERT INTO calls (execution_id, lead_id, recording_url, transcript) VALUES ('exec-canary', ?, 'https://api.bolna.ai/recordings/call/exec-canary', 'user: hi')").run(lead);
      const login = await signIn(base, canaries.DASHBOARD_PASSWORD);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const pages = ['/', '/login', '/api/overview', '/api/projects', '/api/leads', `/api/leads/${lead}`, '/api/calls', '/api/appointments', '/api/campaigns', '/healthz', '/nope'];
      const seen = [login];
      for (const p of pages) seen.push(await fetch(base + p, { headers: { cookie } }));
      const failing = await fetch(`${base}/api/leads/${lead}/call`, { method: 'POST', headers: { ...DASHBOARD, cookie } });
      seen.push(failing);
      const everything = (await Promise.all(seen.map(async (r) => JSON.stringify([...r.headers]) + await r.text()))).join('\n');
      for (const [name, value] of Object.entries(canaries)) assert.ok(!everything.includes(value), `${name} leaked`);
      assert.ok(!everything.includes('exec-canary'), 'recording id leaked');
      assert.ok(!everything.includes('recordings/call'), 'recording url leaked');
    }, { fetchImpl: async () => new Response('{"message":"nope"}', { status: 400 }) });
  } finally {
    delete process.env.DASHBOARD_PASSWORD;
    if (previous.key === undefined) delete process.env.BOLNA_API_KEY; else process.env.BOLNA_API_KEY = previous.key;
    if (previous.agent === undefined) delete process.env.BOLNA_AGENT_ID; else process.env.BOLNA_AGENT_ID = previous.agent;
  }
});

test('sign-in: nothing opens without it, and the cookie is locked down', async () => {
  await withPassword(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/leads`)).status, 401);
    assert.equal((await fetch(`${base}/api/leads`, { headers: { authorization: `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}` } })).status, 401);
    assert.equal((await fetch(`${base}/api/leads`, { headers: { cookie: 'pr_session=forged' } })).status, 401);
    const home = await fetch(`${base}/`, { redirect: 'manual' });
    assert.deepEqual([home.status, home.headers.get('location')], [302, '/login']);
    assert.equal(home.headers.get('www-authenticate'), null);

    assert.equal((await signIn(base, 'wrong')).status, 401);
    const good = await signIn(base, 'correct-horse-battery');
    assert.equal(good.status, 200);
    const setCookie = good.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.ok(!setCookie.includes('correct-horse-battery'));
    const cookie = setCookie.split(';')[0];
    assert.equal((await fetch(`${base}/api/leads`, { headers: { cookie } })).status, 200);

    await fetch(`${base}/logout`, { method: 'POST', headers: { ...DASHBOARD, cookie } });
    assert.equal((await fetch(`${base}/api/leads`, { headers: { cookie } })).status, 401, 'old session still works after sign out');
  });
});

test('sign-in: guessing locks out, and the cookie is Secure over https', async () => {
  await withPassword(async ({ base }) => {
    for (let i = 0; i < 5; i++) assert.equal((await signIn(base, `guess${i}`)).status, 401);
    assert.equal((await signIn(base, 'correct-horse-battery')).status, 429, 'correct password must wait out the lock too');
  });
  await withPassword(async ({ base }) => {
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { ...DASHBOARD, 'x-forwarded-proto': 'https' }, body: '{"password":"correct-horse-battery"}' });
    assert.match(res.headers.get('set-cookie'), /Secure/);
    assert.match(res.headers.get('strict-transport-security'), /max-age/);
  });
});

test('cross-site requests are refused, signed in or not', async () => {
  await withPassword(async ({ base }) => {
    const cookie = (await signIn(base, 'correct-horse-battery')).headers.get('set-cookie').split(';')[0];
    const attempt = (headers) => fetch(`${base}/api/samples/clear`, { method: 'POST', headers: { cookie, ...headers }, body: '{}' });
    assert.equal((await attempt({})).status, 403, 'missing header');
    assert.equal((await attempt({ ...DASHBOARD, origin: 'https://evil.example' })).status, 403, 'wrong origin');
    assert.equal((await attempt({ ...DASHBOARD, origin: 'null' })).status, 403, 'sandboxed origin');
    assert.equal((await attempt({ ...DASHBOARD, origin: base })).status, 200);
    const preflight = await fetch(`${base}/api/samples/clear`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });
});

test('a foreign Host is refused, which blocks DNS rebinding', async () => {
  await withApp(async ({ port }) => {
    const status = await new Promise((resolve) => {
      nodeHttp.get({ port, path: '/api/leads', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
    });
    assert.equal(status, 403);
  });
});

test('pages carry a strict policy, and scripts only run with the nonce', async () => {
  await withApp(async ({ base }) => {
    for (const page of ['/', '/login']) {
      const res = await fetch(base + page);
      const html = await res.text();
      const csp = res.headers.get('content-security-policy');
      const nonce = csp.match(/nonce-([^']+)/)[1];
      assert.ok(html.includes(`<script nonce="${nonce}">`), page);
      assert.equal(html.match(/<script/g).length, 1, page);
      assert.ok(!/script-src[^;]*unsafe/.test(csp));
      assert.ok(!/\son[a-z]+=/.test(html.replace(/<script[\s\S]*<\/script>/, '')), `inline handler in ${page}`);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    const a = (await fetch(`${base}/`)).headers.get('content-security-policy');
    const b = (await fetch(`${base}/`)).headers.get('content-security-policy');
    assert.notEqual(a, b, 'nonce must change per response');
  });
});

test('recordings stream through sign-in, and only from Bolna', async () => {
  const asked = [];
  const fetchImpl = async (url, o) => {
    asked.push([url, o.headers.Range]);
    return new Response('AUDIO', { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-4/5' } });
  };
  await withPassword(async ({ base, db }) => {
    const lead = newLead(db);
    const insert = db.prepare('INSERT INTO calls (execution_id, lead_id, recording_url) VALUES (?, ?, ?)');
    const good = insert.run('r1', lead, 'https://api.bolna.ai/recordings/call/r1').lastInsertRowid;
    const evil = insert.run('r2', lead, 'http://169.254.169.254/latest/meta-data').lastInsertRowid;
    assert.equal((await fetch(`${base}/api/calls/${good}/recording`)).status, 401);
    const cookie = (await signIn(base, 'correct-horse-battery')).headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${base}/api/calls/${good}/recording`, { headers: { cookie, range: 'bytes=0-4' } });
    assert.deepEqual([res.status, res.headers.get('content-type'), await res.text()], [206, 'audio/mpeg', 'AUDIO']);
    assert.deepEqual(asked, [['https://api.bolna.ai/recordings/call/r1', 'bytes=0-4']]);
    assert.equal((await fetch(`${base}/api/calls/${evil}/recording`, { headers: { cookie } })).status, 404);
    assert.equal(asked.length, 1, 'must not fetch a non-Bolna URL');
    const calls = await (await fetch(`${base}/api/calls`, { headers: { cookie } })).json();
    const mine = calls.find((c) => c.id === Number(good));
    assert.equal(mine.has_recording, true);
    assert.ok(!('recording_url' in mine) && !('execution_id' in mine));
  }, { fetchImpl });
});

test('the database and generated files are private to this user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propreach-test-'));
  try {
    const file = path.join(dir, 'p.db');
    openDb(file).close();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a public server refuses a weak password and listens only locally by default', () => {
  const run = (env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'],
    { env: { ...process.env, PORT: '0', DB_PATH: ':memory:', ...env }, encoding: 'utf8', timeout: 4000 });
  assert.equal(run({ PUBLIC_URL: 'https://x.dev', DASHBOARD_PASSWORD: 'admin123' }).status, 1);
  assert.equal(run({ PUBLIC_URL: 'https://x.dev', DASHBOARD_PASSWORD: '' }).status, 1);
  assert.equal(config.host, process.env.HOST || '127.0.0.1');
});

test('sign-in works through the public tunnel address', async () => {
  process.env.PUBLIC_URL = 'https://demo.trycloudflare.com';
  try {
    await withPassword(async ({ port }) => {
      const tunnelled = (options, body) => new Promise((resolve) => {
        const req = nodeHttp.request({ port, ...options, headers: { Host: 'demo.trycloudflare.com', 'x-forwarded-proto': 'https', ...options.headers } }, (r) => {
          r.resume(); r.on('end', () => resolve(r));
        });
        req.end(body);
      });
      const origin = { Origin: 'https://demo.trycloudflare.com', ...DASHBOARD };
      const login = await tunnelled({ method: 'POST', path: '/login', headers: origin }, '{"password":"correct-horse-battery"}');
      assert.equal(login.statusCode, 200);
      assert.match(login.headers['set-cookie'][0], /Secure/);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      assert.equal((await tunnelled({ path: '/api/leads', headers: { cookie } })).statusCode, 200);
      assert.equal((await tunnelled({ method: 'POST', path: '/api/samples/clear', headers: { ...origin, cookie } }, '{}')).statusCode, 200);
    });
  } finally { process.env.PUBLIC_URL = ''; }
});

test('stopping a campaign ends dialling and cancels only what is queued', async () => {
  WITH_CREDS();
  try {
    const db = fresh();
    const ids = [newLead(db)];
    for (const phone of ['+919812345671', '+919812345672']) ids.push(Number(db.prepare("INSERT INTO leads (name, phone, consent) VALUES ('X', ?, 1)").run(phone).lastInsertRowid));
    const c = addCampaign(db, ...ids);
    const log = [], stops = [];
    const fetchImpl = async (url, o) => {
      if (url.endsWith('/stop')) { stops.push(url); return new Response('{}', { status: 200 }); }
      const res = await okFetch(log)(url, o);
      if (log.length === 1) await stopCampaign(db, c, fetchImpl); // the builder presses Stop during the first dial
      return res;
    };
    await runCampaign(db, c, fetchImpl, 0);
    assert.equal(log.length, 1, 'no new calls after Stop');
    assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(c).status, 'stopped');
    assert.deepEqual(db.prepare("SELECT detail FROM campaign_leads WHERE campaign_id = ? AND state = 'skipped'").all(c).map((r) => r.detail), ['campaign stopped', 'campaign stopped']);
    assert.deepEqual(stops, ['https://api.bolna.ai/call/x1/stop'], 'the call placed while Stop was pressed is cancelled too');
    db.prepare("UPDATE calls SET status = 'stopped' WHERE execution_id = 'x1'").run();

    db.prepare("INSERT INTO calls (execution_id, lead_id, campaign_id, status) VALUES ('q1', ?, ?, 'queued'), ('r1', ?, ?, 'in-progress')").run(ids[0], c, ids[1], c);
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(c);
    stops.length = 0;
    assert.equal(await stopCampaign(db, c, fetchImpl), true);
    assert.deepEqual(stops, ['https://api.bolna.ai/call/q1/stop'], 'a connected call is left alone');
    assert.equal(await stopCampaign(db, c, fetchImpl), false, 'stopping twice reports nothing to stop');
  } finally { NO_CREDS(); }
});

test('the team can correct the AI, and the record shows who decided', async () => {
  await withApp(async ({ db, base }) => {
    const lead = newLead(db);
    const post = (body) => fetch(`${base}/api/leads/${lead}`, { method: 'POST', headers: DASHBOARD, body: JSON.stringify(body) });
    updateLead(db, { lead_id: lead, status: 'cold' });
    assert.equal(leadRow(db, lead).status_by, 'asha');
    assert.equal((await post({ status: 'hot' })).status, 200);
    assert.deepEqual([leadRow(db, lead).status, leadRow(db, lead).status_by], ['hot', 'team']);
    assert.equal((await post({ status: 'nonsense' })).status, 400);

    bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '11:30 AM' });
    await post({ do_not_call: true });
    assert.equal(leadRow(db, lead).do_not_call, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE lead_id = ? AND status = 'scheduled'").get(lead).n, 0);
    assert.equal(dialBlocker(leadRow(db, lead)), 'on do-not-call list');
    await post({ do_not_call: false });
    assert.equal(dialBlocker(leadRow(db, lead)), null);
    assert.equal(leadRow(db, lead).next_action, 'Review before calling');
    assert.equal((await fetch(`${base}/api/leads/99999`, { method: 'POST', headers: DASHBOARD, body: '{"status":"hot"}' })).status, 404);
  });
});

test('an older database gains the new column and keeps its data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propreach-test-'));
  try {
    const file = path.join(dir, 'old.db');
    const db = openDb(file);
    const lead = newLead(db);
    db.exec('ALTER TABLE leads DROP COLUMN status_by');
    db.close();
    const again = openDb(file);
    assert.equal(leadRow(again, lead).status_by, 'asha');
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the activity feed tells the story in the buyer\'s words', () => {
  assert.equal(bestQuote('assistant: Hi\nuser: Yes\nuser: I want a 3 BHK near Whitefield please\nuser: this is a much longer line about nothing in particular at all'), 'I want a 3 BHK near Whitefield please');
  assert.equal(bestQuote('user: Yes.\nuser: Okay sure.'), null);
  assert.ok(bestQuote(`user: I want ${'a very long line '.repeat(20)}`).length <= 120);

  const db = fresh();
  const lead = newLead(db);
  db.prepare("UPDATE leads SET pref_bhk = 3, budget_lakh = 150 WHERE id = ?").run(lead);
  startCall(db, 'a1', lead);
  bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '11:30 AM' });
  handleExecutionEvent(db, { id: 'a1', status: 'completed', transcript: 'assistant: Hi\nuser: I want to visit Whitefield on Saturday' });
  const [story] = recentActivity(db);
  assert.equal(story.kind, 'visit');
  assert.equal(story.quote, 'I want to visit Whitefield on Saturday');
  assert.equal(story.date, saturday());
  assert.deepEqual(story.details, ['Whitefield Heights', '3 BHK', '1 crore 50 lakh']);

  updateLead(db, { lead_id: lead, status: 'not_interested', do_not_call: 'true' });
  assert.equal(recentActivity(db)[0].kind, 'optout');
  assert.ok(recentActivity(db).some((s) => s.note), 'sample calls fall back to the AI summary');
  assert.ok(recentActivity(db).length <= 6);
});

test('one transcriber and one voice cover English, Hindi and Hinglish', () => {
  const db = fresh();
  const task = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't', webhookToken: 'w', projects: allProjects(db) }).agent_config.tasks[0];
  const tools = task.tools_config;
  assert.deepEqual([tools.transcriber.provider, tools.synthesizer.provider], ['soniox', 'sarvam']);
  assert.equal(tools.multilingual_config, undefined);
  assert.equal(typeof tools.api_tools.tools[0].pre_call_message, 'string');
  assert.equal(task.task_config.number_of_words_for_interruption, 3);
  assert.doesNotMatch(tools.transcriber.keywords, /itpl|e city|ecity|kadugodi/i, 'short names caused false interruptions');
});

test('the prompt and tools stay compact, because they cost time on every turn', () => {
  const { tools } = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't', webhookToken: 'w' }).agent_config.tasks[0].tools_config.api_tools;
  assert.ok(SYSTEM_PROMPT.length < 3800, `prompt is ${SYSTEM_PROMPT.length} characters`);
  assert.ok(JSON.stringify(tools).length < 1400, `tools are ${JSON.stringify(tools).length} characters`);
  for (const word of ['Hinglish', 'ending the call', 'OTP', 'Devanagari']) assert.ok(SYSTEM_PROMPT.includes(word), word);
});

test('abuse ends in do-not-call and review, and stays off the home page', () => {
  const db = fresh();
  const lead = newLead(db);
  startCall(db, 'b1', lead);
  bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '11:30 AM' });
  handleExecutionEvent(db, { id: 'b1', status: 'completed', transcript: 'user: I want to visit but you are a stupid useless bot',
    summary: 'Customer was abusive.', extracted_data: { 'Lead Outcome': { Abusive: { objective: 'Yes' }, 'Do Not Call': { objective: 'No' } } } });
  const l = leadRow(db, lead);
  assert.deepEqual([l.do_not_call, l.status, l.next_action], [1, 'not_interested', 'Review: abusive call']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE lead_id = ? AND status = 'scheduled'").get(lead).n, 0);
  const [story] = recentActivity(db);
  assert.deepEqual([story.kind, story.quote, story.note], ['abusive', null, null]);
});

test('frustration alone is not treated as abuse', () => {
  const db = fresh();
  const lead = newLead(db);
  startCall(db, 'b2', lead);
  handleExecutionEvent(db, { id: 'b2', status: 'completed', transcript: 'user: this is taking long',
    extracted_data: { 'Lead Outcome': { Abusive: { objective: 'No' }, 'Do Not Call': { objective: 'No' }, 'Lead Status': { objective: 'warm' } } } });
  assert.deepEqual([leadRow(db, lead).do_not_call, leadRow(db, lead).status], [0, 'warm']);
});

test('every tool has its own short filler, so Bolna never plays its long default', () => {
  const { tools } = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't', webhookToken: 'w' }).agent_config.tasks[0].tools_config.api_tools;
  for (const tool of tools) assert.ok(tool.pre_call_message?.length <= 12, `${tool.name}: ${tool.pre_call_message}`);
});

test('someone who asks for a call but hangs up first is not lost', () => {
  const db = fresh();
  const lead = newLead(db);
  startCall(db, 'c1', lead);
  handleExecutionEvent(db, { id: 'c1', status: 'completed', transcript: 'user: call me later tomorrow',
    extracted_data: { 'Lead Outcome': { Abusive: { objective: 'No' }, 'Do Not Call': { objective: 'No' }, 'Lead Status': { objective: 'callback_requested' } } } });
  assert.deepEqual([leadRow(db, lead).status, leadRow(db, lead).next_action], ['callback_requested', 'Call back: no time agreed']);
});

test('a taken time comes straight back with alternatives, in one request', () => {
  const db = fresh();
  const lead = newLead(db);
  const r = bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '10 AM' });
  assert.deepEqual([r.confirmed, r.closest_open_time], [false, '11:30 AM']);
  assert.ok(r.other_days.length > 0);
});

test('the call brief answers common questions without a lookup', () => {
  const brief = portfolioBrief(fresh());
  for (const fact of ['1150 square feet', '90 lakh', 'December 2027', 'ITPL', 'Clubhouse', '10 percent on booking', 'car park']) assert.ok(brief.includes(fact), fact);
  assert.equal(brief.split('\n').length, 3);
});

test('details spoken on the call are saved from the transcript afterwards', () => {
  const db = fresh();
  const lead = newLead(db);
  startCall(db, 'd1', lead);
  const said = (v) => ({ subjective: v });
  handleExecutionEvent(db, { id: 'd1', status: 'completed', transcript: 'user: I want a home',
    extracted_data: { 'Lead Outcome': { 'Preferred Location': said('Whitefield'), BHK: said('3'), Budget: said('1.5 crore'), Purpose: said('Self use'),
      Timeline: said('unknown'), Project: said('Whitefield Heights'), 'Team Notes': said('Send brochure on WhatsApp'), 'Lead Status': { objective: 'warm' } } } });
  const l = leadRow(db, lead);
  assert.deepEqual([l.pref_location, l.pref_bhk, l.budget_lakh, l.purpose, l.timeline, l.interested_project, l.status],
    ['Whitefield', 3, 150, 'Self use', null, 'Whitefield Heights', 'warm']);
  assert.match(l.next_action, /Send brochure/);
});

test('a returning lead is reclassified from the transcript, since Asha saves nothing mid-call', () => {
  const db = fresh();
  const end = (id, lead, status, extra = {}) => { startCall(db, id, lead);
    handleExecutionEvent(db, { id, status: 'completed', transcript: 'user: hello', extracted_data: { 'Lead Outcome': { 'Lead Status': { objective: status }, ...extra } } }); };
  const lead = newLead(db);
  db.prepare("UPDATE leads SET status = 'warm' WHERE id = ?").run(lead);
  end('r1', lead, 'cold');
  assert.equal(leadRow(db, lead).status, 'cold');
  end('r2', lead, 'not_interested');
  assert.deepEqual([leadRow(db, lead).status, leadRow(db, lead).do_not_call, leadRow(db, lead).next_action], ['not_interested', 1, 'None']);
});

test('saying no cancels an earlier visit, a chat alone does not, and a booking on the call beats the read', () => {
  const db = fresh();
  const end = (id, lead, status) => { startCall(db, id, lead);
    handleExecutionEvent(db, { id, status: 'completed', transcript: 'user: hello', extracted_data: { 'Lead Outcome': { 'Lead Status': { objective: status } } } }); };
  const visits = (lead) => db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE lead_id = ? AND status = 'scheduled'").get(lead).n;

  const lead = newLead(db);
  startCall(db, 'v1', lead);
  assert.equal(bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '2 PM' }).confirmed, true);
  handleExecutionEvent(db, { id: 'v1', status: 'completed', transcript: 'user: yes', extracted_data: { 'Lead Outcome': { 'Lead Status': { objective: 'not_interested' } } } });
  assert.deepEqual([leadRow(db, lead).status, visits(lead)], ['hot', 1]);
  db.exec("UPDATE appointments SET created_at = datetime('now', '-1 day')"); // Timestamps are per second, and this booking belongs to an earlier call.

  end('v2', lead, 'warm');
  assert.deepEqual([leadRow(db, lead).status, visits(lead)], ['hot', 1]);

  end('v3', lead, 'not_interested');
  assert.deepEqual([leadRow(db, lead).status, leadRow(db, lead).do_not_call, visits(lead)], ['not_interested', 1, 0]);
});

test('blank answers from the transcript never overwrite what is known', () => {
  const db = fresh();
  const lead = newLead(db);
  db.prepare("UPDATE leads SET pref_location = 'Whitefield', next_action = 'Share brochure' WHERE id = ?").run(lead);
  startCall(db, 'b1', lead);
  const said = (v) => ({ subjective: v });
  handleExecutionEvent(db, { id: 'b1', status: 'completed', transcript: 'user: hello', extracted_data: { 'Lead Outcome': {
    'Preferred Location': said('unknown'), BHK: said('unknown'), Budget: said('unknown'), 'Team Notes': said('none'), 'Lead Status': { objective: 'warm' } } } });
  const l = leadRow(db, lead);
  assert.deepEqual([l.pref_location, l.next_action], ['Whitefield', 'Share brochure']);
});

test('a promise made on the call survives a callback with no agreed time', () => {
  const db = fresh();
  const lead = newLead(db);
  startCall(db, 'p1', lead);
  handleExecutionEvent(db, { id: 'p1', status: 'completed', transcript: 'user: send the brochure', extracted_data: { 'Lead Outcome': {
    'Team Notes': { subjective: 'Send brochure on WhatsApp' }, 'Lead Status': { objective: 'callback_requested' } } } });
  assert.equal(leadRow(db, lead).next_action, 'Send brochure on WhatsApp; Call back: no time agreed');
});

test('calls stay inside the hours TRAI leaves on by default', () => {
  const agent = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't', webhookToken: 'w', projects: [] });
  assert.deepEqual(agent.agent_config.calling_guardrails, { call_start_hour: 10, call_end_hour: 21 });
});

test('calling hours follow the clock in India, whatever the server runs on', () => {
  const ist = (time) => new Date(`2026-11-02T${time}:00+05:30`);
  assert.equal(withinCallingHours(ist('09:59')), false);
  assert.equal(withinCallingHours(ist('10:00')), true);
  assert.equal(withinCallingHours(ist('20:59')), true);
  assert.equal(withinCallingHours(ist('21:00')), false);
  assert.equal(withinCallingHours(ist('00:30')), false);
});

test('only a team phone rings at night, and only from the Call button', async () => {
  WITH_CREDS();
  process.env.TEST_PHONES = '98123 45678, +919812345679';
  try {
    const sent = async (lead, campaign) => {
      const db = fresh();
      db.prepare('INSERT INTO leads (name, phone, consent) VALUES (?, ?, 1)').run('Test', lead);
      const log = [];
      const row = db.prepare('SELECT * FROM leads WHERE phone = ?').get(lead);
      const result = await dialLead(db, row, campaign, okFetch(log));
      return { body: log[0], result };
    };
    assert.equal((await sent('+919812345678')).body.bypass_call_guardrails, true);
    assert.equal((await sent('+919812345679')).body.bypass_call_guardrails, true);
    assert.equal((await sent('+919812345678')).result.held, false, 'a test call is never held');
    assert.equal((await sent('+919812345670')).body.bypass_call_guardrails, undefined, 'a buyer stays inside calling hours');
    assert.equal((await sent('+919812345678', { id: null })).body.bypass_call_guardrails, undefined, 'a campaign never skips them');
  } finally { delete process.env.TEST_PHONES; NO_CREDS(); }
});

test('a call held until morning is remembered and cannot be stacked', async () => {
  WITH_CREDS();
  try {
    const db = fresh();
    const id = newLead(db);
    const log = [];
    await dialLead(db, leadRow(db, id), null, okFetch(log));
    const execution = db.prepare('SELECT execution_id FROM calls WHERE lead_id = ?').get(id).execution_id;
    handleExecutionEvent(db, { id: execution, status: 'rescheduled', scheduled_at: '2026-11-02T04:29:59.388499+00:00' });
    const row = () => db.prepare('SELECT * FROM calls WHERE execution_id = ?').get(execution);
    assert.equal(row().status, 'rescheduled');
    assert.equal(row().scheduled_at, '2026-11-02 04:29:59');
    assert.equal(row().ended_at, null);

    db.prepare("UPDATE calls SET created_at = datetime('now', '-3 hours') WHERE execution_id = ?").run(execution);
    assert.deepEqual(await dialLead(db, leadRow(db, id), null, okFetch(log)), { ok: false, error: 'already called recently' });

    handleExecutionEvent(db, { id: execution, status: 'ringing' });
    assert.equal(row().scheduled_at, '2026-11-02 04:29:59', 'later events without a time keep the one Bolna gave');
    assert.ok(row().status_at, 'the banner times the call from this status, not from the night before');
  } finally { NO_CREDS(); }
});

test('stopping a campaign also cancels calls held until morning', async () => {
  WITH_CREDS();
  try {
    const db = fresh();
    const c = addCampaign(db, newLead(db));
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(c);
    db.prepare("INSERT INTO calls (execution_id, campaign_id, status) VALUES ('h1', ?, 'rescheduled')").run(c);
    const stops = [];
    await stopCampaign(db, c, async (url) => { stops.push(url); return new Response('{}'); });
    assert.deepEqual(stops, ['https://api.bolna.ai/call/h1/stop']);
  } finally { NO_CREDS(); }
});

test('the live line only reports what Bolna has actually said', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('const HELD = new Set');
  const code = html.slice(start, html.indexOf('/** A table cell that carries'));
  const ago = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
  const esc = String, RESULT = {}, ACTIVE_WINDOW_MS = 600000;
  const utc = (s) => new Date(`${s.replace(' ', 'T')}Z`);
  const ui = new Function('esc', 'RESULT', 'ACTIVE_WINDOW_MS', 'utc', `${code}; return { isHeld, isActive, liveLine, heldUntil };`)(esc, RESULT, ACTIVE_WINDOW_MS, utc);
  const call = (status, extra = {}) => ({ status, lead: 'Anugrah', created_at: ago(5000), ended_at: null, ...extra });

  const tomorrow = call('rescheduled', { scheduled_at: new Date(Date.now() + 3.6e7).toISOString().slice(0, 19).replace('T', ' ') });
  assert.equal(ui.isHeld(tomorrow), true);
  assert.equal(ui.isActive(tomorrow), false, 'a held call is not a live call');
  assert.match(ui.heldUntil(call('rescheduled', { scheduled_at: '2026-11-02 04:29:59' })), /10:00/, 'reads 10:00, not 9:59');
  assert.equal(ui.liveLine(call('queued')), 'Calling Anugrah');
  assert.equal(ui.liveLine(call('ringing')), 'Ringing Anugrah');
  assert.match(ui.liveLine(call('in-progress', { status_at: ago(65000) })), /^Asha is talking to Anugrah · 1:05$/);
  // A call held overnight rings hours after it was created, and must still show as live.
  assert.equal(ui.isActive(call('ringing', { created_at: ago(3.6e7), status_at: ago(1000) })), true);
});

test('an opt-out during the call takes effect at once and cancels bookings', () => {
  const db = fresh();
  const lead = newLead(db);
  assert.equal(bookVisit(db, { lead_id: lead, project: 'Whitefield', date: saturday(), time: '2 PM' }).confirmed, true);
  assert.equal(doNotCall(db, { lead_id: String(lead) }).saved, true);
  const l = leadRow(db, lead);
  assert.deepEqual([l.do_not_call, l.status, l.next_action], [1, 'not_interested', 'None']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE lead_id = ? AND status = 'scheduled'").get(lead).n, 0);
  assert.equal(doNotCall(db, { lead_id: '999999' }).ok, false);
});

test('a dashboard other machines can reach will not start without a strong password', () => {
  const start = (env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'],
    { env: { PATH: process.env.PATH, DB_PATH: ':memory:', PORT: '0', BOLNA_API_KEY: '', DASHBOARD_PASSWORD: '', PUBLIC_URL: '', TOOL_TOKEN: 't', ...env }, timeout: 3000, encoding: 'utf8' });
  const refused = start({ HOST: '0.0.0.0' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /DASHBOARD_PASSWORD/);
  assert.equal(start({ HOST: '0.0.0.0', DASHBOARD_PASSWORD: 'long-enough-password' }).status, null, 'a strong password lets it run until the timeout');
  assert.equal(start({ HOST: '127.0.0.1' }).status, null, 'local use still needs no password');
});

test('behind Render each visitor has their own sign-in lockout, and forged headers count for nothing elsewhere', async () => {
  const { createAuth } = await import('../src/auth.js');
  const saved = [process.env.DASHBOARD_PASSWORD, process.env.RENDER];
  process.env.DASHBOARD_PASSWORD = 'correct-horse-battery';
  try {
    const from = (ip) => ({ headers: { 'cf-connecting-ip': ip }, socket: { remoteAddress: '10.20.30.40' } });
    process.env.RENDER = 'true';
    const hosted = createAuth();
    for (let i = 0; i < 5; i++) hosted.signIn(from('203.0.113.1'), 'wrong');
    assert.equal(hosted.signIn(from('203.0.113.1'), 'correct-horse-battery').status, 429);
    assert.notEqual(hosted.signIn(from('203.0.113.2'), 'correct-horse-battery').status, 429);

    delete process.env.RENDER;
    const direct = createAuth();
    for (let i = 0; i < 5; i++) direct.signIn(from(`198.51.100.${i}`), 'wrong');
    assert.equal(direct.signIn(from('198.51.100.99'), 'correct-horse-battery').status, 429, 'a forged header must not dodge the lockout');
  } finally {
    process.env.DASHBOARD_PASSWORD = saved[0] ?? ''; if (saved[1] === undefined) delete process.env.RENDER; else process.env.RENDER = saved[1];
  }
});

test('Render supplies the public address, and an explicit one still wins', () => {
  const saved = [process.env.PUBLIC_URL, process.env.RENDER_EXTERNAL_URL];
  try {
    process.env.PUBLIC_URL = ''; process.env.RENDER_EXTERNAL_URL = 'https://propreach-ai.onrender.com/';
    assert.equal(config.publicUrl, 'https://propreach-ai.onrender.com');
    process.env.PUBLIC_URL = 'https://demo.example.com';
    assert.equal(config.publicUrl, 'https://demo.example.com');
  } finally {
    process.env.PUBLIC_URL = saved[0] ?? ''; if (saved[1] === undefined) delete process.env.RENDER_EXTERNAL_URL; else process.env.RENDER_EXTERNAL_URL = saved[1];
  }
});
