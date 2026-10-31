import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { addDays, nextWeekday, todayIST } from './parse.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS company (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, about TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, location TEXT NOT NULL, areas TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '', configs TEXT NOT NULL DEFAULT '[]', amenities TEXT NOT NULL DEFAULT '[]',
  possession TEXT NOT NULL DEFAULT '', landmarks TEXT NOT NULL DEFAULT '[]', payment_plan TEXT NOT NULL DEFAULT '',
  faqs TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS reps (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, enquiry TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', consent INTEGER NOT NULL DEFAULT 0, do_not_call INTEGER NOT NULL DEFAULT 0,
  pref_location TEXT, pref_bhk INTEGER, budget_lakh REAL, purpose TEXT, timeline TEXT, interested_project TEXT,
  status TEXT NOT NULL DEFAULT 'new', next_action TEXT, summary TEXT, is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, project_id INTEGER REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS campaign_leads (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id), lead_id INTEGER NOT NULL REFERENCES leads(id),
  state TEXT NOT NULL DEFAULT 'pending', detail TEXT, PRIMARY KEY (campaign_id, lead_id));
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, lead_id INTEGER REFERENCES leads(id),
  campaign_id INTEGER REFERENCES campaigns(id), status TEXT NOT NULL DEFAULT 'queued', connected INTEGER NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 0, transcript TEXT, summary TEXT, recording_url TEXT, cost REAL,
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('visit','callback')),
  lead_id INTEGER NOT NULL REFERENCES leads(id), project_id INTEGER REFERENCES projects(id),
  date TEXT NOT NULL, time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', rep_id INTEGER REFERENCES reps(id),
  notes TEXT, is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS one_visit_per_slot ON appointments (project_id, date, time)
  WHERE type = 'visit' AND status = 'scheduled';
`;

// All fictional, following the vision document. Numbers start +9100, which no
// Indian subscriber can hold, so isDialable() refuses them.
const PROJECTS = [
  { name: 'Whitefield Heights', location: 'Whitefield, Bengaluru', areas: ['whitefield', 'itpl', 'kadugodi', 'hoodi'],
    description: 'Mid-rise family community near the ITPL tech corridor.',
    configs: [{ bhk: 2, size_sqft: 1150, price_lakh: 90, units_left: 18 }, { bhk: 3, size_sqft: 1580, price_lakh: 135, units_left: 9 }],
    amenities: ['Clubhouse', 'Swimming pool', 'Children play area', 'Gym'], possession: 'December 2027, under construction',
    landmarks: ['ITPL', 'Hoodi metro station', 'Phoenix Marketcity'],
    payment_plan: '10 percent on booking, construction-linked after that',
    faqs: [{ q: 'Is it RERA registered?', a: 'The consultant will share the registration number.' }, { q: 'Is car parking included?', a: 'One covered car park is included with every apartment.' }] },
  { name: 'Sarjapur Residences', location: 'Sarjapur Road, Bengaluru', areas: ['sarjapur', 'sarjapura', 'bellandur', 'dommasandra'],
    description: 'Larger low-density homes for families who want more space.',
    configs: [{ bhk: 3, size_sqft: 1720, price_lakh: 120, units_left: 14 }, { bhk: 4, size_sqft: 2400, price_lakh: 185, units_left: 5 }],
    amenities: ['Clubhouse', 'Tennis court', 'Jogging track', 'Co-working lounge', 'Swimming pool'], possession: 'June 2028, under construction',
    landmarks: ['Wipro SEZ', 'Bellandur', 'Inventure Academy'],
    payment_plan: '10 percent on booking, 20 percent at agreement, construction-linked after that',
    faqs: [{ q: 'Is car parking included?', a: 'Two covered car parks are included with 4 BHK apartments and one with 3 BHK.' }] },
  { name: 'Electronic City Homes', location: 'Electronic City, Bengaluru', areas: ['electronic city', 'e city', 'ecity', 'bommasandra', 'hosur road'],
    description: 'Value homes close to the Electronic City employment hub.',
    configs: [{ bhk: 2, size_sqft: 1040, price_lakh: 75, units_left: 22 }, { bhk: 3, size_sqft: 1400, price_lakh: 105, units_left: 11 }],
    amenities: ['Gym', 'Children play area', 'Community hall'], possession: 'Ready to move, final phase',
    landmarks: ['Infosys campus', 'Electronic City metro station'],
    payment_plan: '20 percent on booking, balance on registration',
    faqs: [] },
];

const SAMPLE_LEADS = [
  ['Rahul Verma', '+910000000001', '3 BHK enquiry from property portal', 'Portal', { status: 'new' }],
  ['Priya Nair', '+910000000002', 'Website form: Whitefield launch', 'Website', { status: 'hot', pref_location: 'Whitefield', pref_bhk: 3, budget_lakh: 150, purpose: 'Self use', timeline: 'Within 3 months', interested_project: 'Whitefield Heights', summary: 'Looking for a 3 BHK for family. Keen on Whitefield Heights.', next_action: 'Host site visit' }],
  ['Arjun Rao', '+910000000003', 'Facebook ad: Sarjapur', 'Ad', { status: 'warm', pref_location: 'Sarjapur', pref_bhk: 3, budget_lakh: 130, purpose: 'Self use', timeline: '6 to 12 months', interested_project: 'Sarjapur Residences', summary: 'Comparing Sarjapur with Whitefield. Wants a brochure first.', next_action: 'Follow up in two weeks' }],
  ['Meera Iyer', '+910000000004', 'Investment enquiry', 'Portal', { status: 'callback_requested', pref_location: 'Electronic City', pref_bhk: 2, budget_lakh: 80, purpose: 'Investment', interested_project: 'Electronic City Homes', summary: 'Wants the payment plan explained by a person.', next_action: 'Human callback' }],
  ['Karan Shah', '+910000000005', 'Old enquiry from 2025', 'Portal', { status: 'not_interested', do_not_call: 1, summary: 'Already purchased elsewhere. Asked not to be called again.' }],
  ['Sneha Kulkarni', '+910000000006', 'Website form', 'Website', { status: 'unreachable', next_action: 'Retry on another day' }],
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  if (!db.prepare('SELECT 1 FROM company').get()) seed(db);
  // This file holds buyers' phone numbers, so only this user may read it.
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  return db;
}

/** Existing databases keep their data, so new columns are added here rather than in SCHEMA. */
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
  if (!columns.includes('status_by')) db.exec("ALTER TABLE leads ADD COLUMN status_by TEXT NOT NULL DEFAULT 'asha'");
}

function seed(db) {
  db.prepare('INSERT INTO company (id, name, about) VALUES (1, ?, ?)').run(
    'ABC Developers', 'A fictional Bengaluru residential developer with three ongoing projects.');
  const insertProject = db.prepare(`INSERT INTO projects (name, location, areas, description, configs, amenities, possession, landmarks, payment_plan, faqs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of PROJECTS) {
    insertProject.run(p.name, p.location, JSON.stringify(p.areas), p.description, JSON.stringify(p.configs),
      JSON.stringify(p.amenities), p.possession, JSON.stringify(p.landmarks), p.payment_plan, JSON.stringify(p.faqs));
  }
  for (const name of ['Divya Menon', 'Rohit Sharma']) db.prepare('INSERT INTO reps (name) VALUES (?)').run(name);

  for (const [name, phone, enquiry, source, f] of SAMPLE_LEADS) {
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO leads
      (name, phone, enquiry, source, consent, is_sample, do_not_call, status, pref_location, pref_bhk, budget_lakh, purpose, timeline, interested_project, summary, next_action)
      VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, phone, enquiry, source, f.do_not_call ?? 0, f.status,
      f.pref_location ?? null, f.pref_bhk ?? null, f.budget_lakh ?? null, f.purpose ?? null, f.timeline ?? null,
      f.interested_project ?? null, f.summary ?? null, f.next_action ?? null);
    if (f.status !== 'new') {
      const connected = f.status === 'unreachable' ? 0 : 1;
      db.prepare(`INSERT INTO calls (execution_id, lead_id, status, connected, duration, summary, is_sample, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))`).run(`sample-${id}`, id, connected ? 'completed' : 'no-answer',
        connected, connected ? 180 + Number(id) * 25 : 0, f.summary ?? null);
    }
  }

  const whitefield = db.prepare("SELECT id FROM projects WHERE name = 'Whitefield Heights'").get().id;
  const { lastInsertRowid: campaign } = db.prepare("INSERT INTO campaigns (name, project_id, status) VALUES ('Sample: enquiry follow-up', ?, 'done')").run(whitefield);
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, state) SELECT ?, id, 'dialled' FROM leads WHERE is_sample = 1 AND status != 'new'").run(campaign);
  db.prepare('UPDATE calls SET campaign_id = ? WHERE is_sample = 1').run(campaign);

  // Taking the next weekend's 10 AM slots makes the "slot unavailable" path real.
  const today = todayIST();
  const saturday = nextWeekday(today, 6);
  const priya = db.prepare("SELECT id FROM leads WHERE phone = '+910000000002'").get().id;
  const meera = db.prepare("SELECT id FROM leads WHERE phone = '+910000000004'").get().id;
  const insertAppt = db.prepare(`INSERT INTO appointments (type, lead_id, project_id, date, time, rep_id, notes, is_sample) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);
  insertAppt.run('visit', priya, whitefield, saturday, '10:00', 1, 'Priya prefers a corner apartment.');
  insertAppt.run('visit', priya, whitefield, addDays(saturday, 1), '10:00', 1, 'Second visit with parents.');
  insertAppt.run('callback', meera, null, addDays(today, 1), '18:00', 2, 'Wants the payment plan explained.');
}

export function clearSamples(db) {
  db.exec(`DELETE FROM appointments WHERE is_sample = 1 OR lead_id IN (SELECT id FROM leads WHERE is_sample = 1);
    DELETE FROM calls WHERE is_sample = 1 OR lead_id IN (SELECT id FROM leads WHERE is_sample = 1);
    DELETE FROM campaign_leads WHERE lead_id IN (SELECT id FROM leads WHERE is_sample = 1);
    DELETE FROM leads WHERE is_sample = 1;
    DELETE FROM campaigns WHERE id NOT IN (SELECT campaign_id FROM campaign_leads);`);
}

export function getProject(row) {
  return row && { ...row, areas: JSON.parse(row.areas), configs: JSON.parse(row.configs),
    amenities: JSON.parse(row.amenities), landmarks: JSON.parse(row.landmarks), faqs: JSON.parse(row.faqs) };
}

export const allProjects = (db) => db.prepare('SELECT * FROM projects ORDER BY id').all().map(getProject);
export const company = (db) => db.prepare('SELECT * FROM company WHERE id = 1').get();
