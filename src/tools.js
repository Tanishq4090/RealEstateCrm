// Functions the voice agent calls mid-conversation. Every result is what the
// LLM may say, so bookings and prices only ever come from this data.
import { allProjects } from './db.js';
import { addDays, clean, parseBhk, parseBudgetLakh, parseDate, parseTime, speakDate, speakPrice, speakTime, todayIST } from './parse.js';

export const SLOTS = ['10:00', '11:30', '14:00', '16:00'];
const STATUSES = new Set(['hot', 'warm', 'cold', 'not_interested', 'callback_requested']);

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function matchesLocation(project, location) {
  const q = normalize(location).replace(/\b(road|bengaluru|bangalore|area|side|near)\b/g, '').trim();
  if (!q) return true;
  return [project.location, project.name, ...project.areas].some((text) => {
    const t = normalize(text);
    return t.includes(q) || q.includes(t);
  });
}

function resolveProject(db, name) {
  const q = clean(name);
  if (!q) return null;
  const words = normalize(q).split(' ').filter((w) => w.length > 2);
  let best = null, bestScore = 0;
  for (const p of allProjects(db)) {
    const hay = normalize(`${p.name} ${p.location} ${p.areas.join(' ')}`);
    const score = words.filter((w) => hay.includes(w) || hay.includes(w.replace(/s$/, ''))).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

const unitLine = (c) => ({ bhk: `${c.bhk} BHK`, size: `${c.size_sqft} square feet`, starting_price: speakPrice(c.price_lakh), availability: c.units_left > 0 ? 'available' : 'sold out' });

function brief(p, configs = p.configs) {
  return { project: p.name, location: p.location, possession: p.possession, units: configs.map(unitLine) };
}

const lack = (msg) => ({ ok: false, message: msg });

export function searchProjects(db, { lead_id, location, bhk, budget }) {
  const loc = clean(location), wantBhk = parseBhk(bhk), budgetLakh = parseBudgetLakh(budget);
  // Keeps stated requirements even if the call ends before update_lead runs.
  if (clean(lead_id)) {
    db.prepare(`UPDATE leads SET pref_location = COALESCE(?, pref_location), pref_bhk = COALESCE(?, pref_bhk),
      budget_lakh = COALESCE(?, budget_lakh), updated_at = datetime('now') WHERE id = ?`).run(loc, wantBhk, budgetLakh, Number(clean(lead_id)));
  }
  const matches = [], alternatives = [];
  for (const p of allProjects(db)) {
    const open = p.configs.filter((c) => c.units_left > 0);
    const byBhk = wantBhk ? open.filter((c) => c.bhk === wantBhk) : open;
    const fits = budgetLakh ? byBhk.filter((c) => c.price_lakh <= budgetLakh) : byBhk;
    const inArea = !loc || matchesLocation(p, loc);
    if (inArea && fits.length) { matches.push(brief(p, fits)); continue; }
    const why = [];
    if (!inArea) why.push(`located in ${p.location}, not ${loc}`);
    if (!byBhk.length) why.push(`no ${wantBhk} BHK available`);
    else if (!fits.length) why.push(`above budget, starts at ${speakPrice(Math.min(...byBhk.map((c) => c.price_lakh)))}`);
    alternatives.push({ ...brief(p, byBhk.length ? byBhk : open), why_not_exact: why.join('; ') });
  }
  return { ok: true, match_count: matches.length, matches, alternatives };
}

export function getProjectDetails(db, { project_names }) {
  const names = String(clean(project_names) ?? '').split(/,|\band\b|\bvs\b/i).map((s) => s.trim()).filter(Boolean);
  const found = [...new Map(names.map((n) => resolveProject(db, n)).filter(Boolean).map((p) => [p.id, p])).values()];
  if (!found.length) return lack(`No project found. Available projects: ${allProjects(db).map((p) => p.name).join(', ')}.`);
  return { ok: true, projects: found.map((p) => ({ ...brief(p), description: p.description, amenities: p.amenities,
    nearby: p.landmarks, payment_plan: p.payment_plan, faqs: p.faqs })) };
}

const takenSlots = (db, projectId, date) => new Set(db.prepare(
  "SELECT time FROM appointments WHERE type = 'visit' AND status = 'scheduled' AND project_id = ? AND date = ?").all(projectId, date).map((r) => r.time));

function openSlots(db, projectId, date) {
  const taken = takenSlots(db, projectId, date);
  return SLOTS.filter((s) => !taken.has(s));
}

function nearbyOptions(db, projectId, date) {
  const options = [];
  for (let i = 1; i <= 14 && options.length < 3; i++) {
    const d = addDays(date, i);
    const first = openSlots(db, projectId, d)[0];
    if (first) options.push({ date: d, spoken: `${speakDate(d)} at ${speakTime(first)}`, time: first });
  }
  return options;
}

export function checkSlots(db, { project, date, time }, now = new Date()) {
  const p = resolveProject(db, project);
  if (!p) return lack('Project not recognised. Ask which project they want to visit.');
  const day = parseDate(date);
  if (!day) return lack('Date must be YYYY-MM-DD. Work it out from the current date and try again.');
  if (day <= todayIST(now)) return lack('Visits can be booked from tomorrow onwards. Ask for a later date.');
  const open = openSlots(db, p.id, day);
  const wanted = parseTime(time);
  const preferred = wanted ? open.includes(wanted) : null;
  const result = { ok: true, project: p.name, date: day, date_spoken: speakDate(day),
    open_times: open.map((t) => ({ time: t, spoken: speakTime(t) })) };
  if (wanted) result.requested_time_available = preferred;
  if (preferred === false && open.length) {
    const minutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    result.closest_open_time = speakTime(open.reduce((a, b) => (Math.abs(minutes(b) - minutes(wanted)) < Math.abs(minutes(a) - minutes(wanted)) ? b : a)));
  }
  if (!open.length || preferred === false) result.other_days = nearbyOptions(db, p.id, day);
  return result;
}

const getLead = (db, id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(clean(id)));

function nextRep(db) {
  return db.prepare(`SELECT r.id, r.name FROM reps r
    LEFT JOIN appointments a ON a.rep_id = r.id AND a.status = 'scheduled'
    GROUP BY r.id ORDER BY COUNT(a.id), r.id LIMIT 1`).get();
}

export function bookVisit(db, { lead_id, project, date, time }, now = new Date()) {
  const lead = getLead(db, lead_id);
  if (!lead) return lack('Could not find this customer record. Offer a callback from the sales team instead.');
  const p = resolveProject(db, project);
  const day = parseDate(date), slot = parseTime(time);
  if (!p || !day || !slot) return lack('Need a project, a YYYY-MM-DD date and a time. Call check_slots first.');
  if (day <= todayIST(now)) return lack('Visits can be booked from tomorrow onwards.');
  if (!SLOTS.includes(slot)) return lack(`Visit times are ${SLOTS.map(speakTime).join(', ')}.`);

  const existing = db.prepare(`SELECT * FROM appointments WHERE type = 'visit' AND status = 'scheduled' AND lead_id = ? AND project_id = ?`).get(lead.id, p.id);
  if (existing?.date === day && existing.time === slot) {
    return { ok: true, confirmed: true, already_booked: true, message: `Visit to ${p.name} is confirmed for ${speakDate(day)} at ${speakTime(slot)}.` };
  }

  const rep = nextRep(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (existing) db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(existing.id);
    db.prepare(`INSERT INTO appointments (type, lead_id, project_id, date, time, rep_id, notes) VALUES ('visit', ?, ?, ?, ?, ?, ?)`)
      .run(lead.id, p.id, day, slot, rep?.id ?? null, existing ? 'Rescheduled by customer on call' : null);
    db.prepare(`UPDATE leads SET interested_project = ?, next_action = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(p.name, `Site visit ${day} ${slot}`, lead.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (!String(err.message).includes('UNIQUE')) throw err;
    return { ok: false, confirmed: false, message: 'That slot was just taken. Do not confirm it.',
      open_times: openSlots(db, p.id, day).map(speakTime), other_days: nearbyOptions(db, p.id, day) };
  }
  return { ok: true, confirmed: true, next_step: 'Call update_lead before saying goodbye.', message: `Visit to ${p.name} is confirmed for ${speakDate(day)} at ${speakTime(slot)}.`,
    rescheduled: Boolean(existing), location: p.location, sales_contact: rep?.name };
}

export function scheduleCallback(db, { lead_id, date, time, topic }, now = new Date()) {
  const lead = getLead(db, lead_id);
  if (!lead) return lack('Could not find this customer record.');
  const day = parseDate(date), slot = parseTime(time);
  if (!day || !slot) return lack('Need a YYYY-MM-DD date and a time.');
  if (day < todayIST(now)) return lack('That date has passed. Ask for a later one.');
  const dup = db.prepare(`SELECT id FROM appointments WHERE type = 'callback' AND status = 'scheduled' AND lead_id = ? AND date = ? AND time = ?`).get(lead.id, day, slot);
  const rep = nextRep(db);
  if (!dup) {
    db.prepare(`INSERT INTO appointments (type, lead_id, date, time, rep_id, notes) VALUES ('callback', ?, ?, ?, ?, ?)`)
      .run(lead.id, day, slot, rep?.id ?? null, clean(topic));
    db.prepare(`UPDATE leads SET next_action = ?, updated_at = datetime('now') WHERE id = ?`).run(`Human callback ${day} ${slot}`, lead.id);
  }
  return { ok: true, confirmed: true, next_step: 'Call update_lead before saying goodbye.', message: `A property consultant${rep ? `, ${rep.name},` : ''} will call on ${speakDate(day)} at ${speakTime(slot)}.` };
}

export function updateLead(db, args) {
  const lead = getLead(db, args.lead_id);
  if (!lead) return lack('Customer record not found. Carry on with the conversation.');
  const status = clean(args.status)?.toLowerCase().replace(/[\s-]+/g, '_');
  const optOut = ['true', 'yes'].includes(String(clean(args.do_not_call)).toLowerCase());
  const next = {
    pref_location: clean(args.location) ?? lead.pref_location, pref_bhk: parseBhk(args.bhk) ?? lead.pref_bhk,
    budget_lakh: parseBudgetLakh(args.budget) ?? lead.budget_lakh, purpose: clean(args.purpose) ?? lead.purpose,
    timeline: clean(args.timeline) ?? lead.timeline, interested_project: clean(args.interested_project) ?? lead.interested_project,
    status: STATUSES.has(status) ? status : lead.status, do_not_call: optOut || status === 'not_interested' ? 1 : lead.do_not_call,
  };
  if (optOut) next.status = 'not_interested';
  db.prepare(`UPDATE leads SET pref_location = ?, pref_bhk = ?, budget_lakh = ?, purpose = ?, timeline = ?, interested_project = ?, status = ?, do_not_call = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(next.pref_location, next.pref_bhk, next.budget_lakh, next.purpose, next.timeline, next.interested_project, next.status, next.do_not_call, lead.id);
  return { ok: true, saved: true };
}

export const TOOL_HANDLERS = {
  search_projects: searchProjects, get_project_details: getProjectDetails, check_slots: checkSlots,
  book_visit: bookVisit, schedule_callback: scheduleCallback, update_lead: updateLead,
};
