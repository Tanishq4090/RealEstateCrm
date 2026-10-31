import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.TOOL_TOKEN = 'test-token';
const { openDb, clearSamples } = await import('../src/db.js');
const { addDays, nextWeekday, normalizePhone, isDialable, parseBudgetLakh, parseBhk, parseCsv, parseTime, clean, todayIST } = await import('../src/parse.js');
const { bookVisit, checkSlots, getProjectDetails, scheduleCallback, searchProjects, updateLead } = await import('../src/tools.js');
const { dialBlocker, dialLead, handleExecutionEvent, runCampaign } = await import('../src/calls.js');
const { buildAgent, SYSTEM_PROMPT, WELCOME, keywordsFor } = await import('../src/agent-config.js');
const { createApp } = await import('../src/server.js');
const { allProjects } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const net = await import('node:net');

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
    const agent = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't', webhookToken: 'w', projects: allProjects(db) });
    const hindi = agent.agent_config.tasks[0].tools_config.multilingual_config.languages.hi.system_prompt;
    const used = [...`${SYSTEM_PROMPT} ${WELCOME} ${hindi}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    for (const name of new Set(used)) assert.ok(data[name], `missing user_data for {{${name}}}`);
    assert.equal(data.customer_name, 'Sharma');
    assert.match(data.known_so_far, /3 BHK, Whitefield, budget 1 crore 50 lakh.*Visit booked: Whitefield Heights/);
  } finally { NO_CREDS(); }
});

test('agent stays inside the limits Bolna enforces', () => {
  const db = fresh();
  const agent = buildAgent({ publicUrl: 'https://x.dev', toolToken: 'tool', webhookToken: 'hook', projects: allProjects(db) });
  const tools = agent.agent_config.tasks[0].tools_config;
  assert.ok(keywordsFor(allProjects(db)).split(', ').length <= 50);
  assert.match(tools.transcriber.keywords, /Sarjapur Residences/);
  assert.deepEqual(Object.keys(tools.multilingual_config.languages), ['en', 'hi']);
  assert.match(agent.agent_config.webhook_url, /token=hook$/);
  assert.ok(!JSON.stringify(tools.api_tools).includes('hook'));
  const plain = buildAgent({ publicUrl: 'https://x.dev', toolToken: 't', webhookToken: 'w', voiceProfile: 'default' }).agent_config.tasks[0].tools_config;
  assert.equal(plain.multilingual_config, undefined);
  assert.equal(plain.api_tools.tools[0].pre_call_message, 'Okay.');
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
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body: JSON.stringify(body) });
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
