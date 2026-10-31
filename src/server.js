import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, ROOT } from './config.js';
import { allProjects, clearSamples, company, openDb } from './db.js';
import { dialBlocker, dialLead, handleExecutionEvent, portfolioBrief, runCampaign } from './calls.js';
import { TOOL_HANDLERS } from './tools.js';
import { normalizePhone, parseCsv } from './parse.js';

const sha = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));
const MAX_BODY = 2_000_000;

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  return raw;
}

function parseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function dashboardAllowed(req) {
  if (!config.dashboardPassword) return true;
  const [scheme, value] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const decoded = Buffer.from(value, 'base64').toString();
  return same(decoded.slice(decoded.indexOf(':') + 1), config.dashboardPassword);
}

function addLead(db, row) {
  const phone = normalizePhone(row.phone);
  const name = (row.name ?? '').trim();
  if (!name || !phone) return { ok: false, error: `Invalid name or phone: ${row.name ?? ''} ${row.phone ?? ''}` };
  const consent = ['1', 'true', 'yes', 'y'].includes(String(row.consent ?? '').trim().toLowerCase()) ? 1 : 0;
  const result = db.prepare(`INSERT INTO leads (name, phone, enquiry, source, consent) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (phone) DO NOTHING`).run(name, phone, row.enquiry ?? '', row.source ?? 'Upload', consent);
  return result.changes ? { ok: true, id: Number(result.lastInsertRowid) } : { ok: false, error: `Duplicate phone: ${phone}` };
}

function overview(db) {
  const one = (sql) => db.prepare(sql).get().n;
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all().map((r) => [r.status, r.n]));
  return {
    leads: one('SELECT COUNT(*) n FROM leads'),
    attempted: one('SELECT COUNT(*) n FROM calls'),
    connected: one('SELECT COUNT(*) n FROM calls WHERE connected = 1'),
    interested: (byStatus.hot ?? 0) + (byStatus.warm ?? 0) + (byStatus.callback_requested ?? 0),
    hot: byStatus.hot ?? 0,
    visits: one("SELECT COUNT(*) n FROM appointments WHERE type = 'visit' AND status != 'cancelled'"),
    visitLeads: one("SELECT COUNT(DISTINCT lead_id) n FROM appointments WHERE type = 'visit' AND status != 'cancelled'"),
    callbacks: one("SELECT COUNT(*) n FROM appointments WHERE type = 'callback' AND status != 'cancelled'"),
    byStatus,
    hasSamples: one('SELECT COUNT(*) n FROM leads WHERE is_sample = 1') > 0,
    calling: Boolean(config.bolnaKey && config.agentId),
    company: company(db),
  };
}

const LEAD_DETAIL = {
  calls: 'SELECT * FROM calls WHERE lead_id = ? ORDER BY id DESC',
  appointments: `SELECT a.*, p.name project, r.name rep FROM appointments a LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN reps r ON r.id = a.rep_id WHERE a.lead_id = ? ORDER BY a.date DESC`,
};

function saveProject(db, b) {
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const configs = (b.configs ?? []).map((c) => ({ bhk: Number(c.bhk), size_sqft: Number(c.size_sqft), price_lakh: Number(c.price_lakh), units_left: Number(c.units_left) }));
  if (!b.name?.trim() || !b.location?.trim() || !configs.length || configs.some((c) => Object.values(c).some((n) => !Number.isFinite(n) || n < 0) || !c.bhk || !c.price_lakh)) {
    throw Object.assign(new Error('Name, location and at least one complete unit type are required'), { status: 400 });
  }
  const areas = list(b.areas).map((s) => s.toLowerCase());
  if (!areas.length) areas.push(b.location.split(',')[0].trim().toLowerCase());
  try {
    const r = db.prepare(`INSERT INTO projects (name, location, areas, description, configs, amenities, possession, landmarks, payment_plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(b.name.trim(), b.location.trim(), JSON.stringify(areas), b.description ?? '', JSON.stringify(configs),
      JSON.stringify(list(b.amenities)), b.possession ?? '', JSON.stringify(list(b.landmarks)), b.payment_plan ?? '');
    return { id: Number(r.lastInsertRowid) };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw Object.assign(new Error('A project with this name exists'), { status: 409 });
    throw err;
  }
}

async function api(db, req, res, pathname) {
  const route = `${req.method} ${pathname}`;
  const id = Number(pathname.split('/')[3]);

  if (route === 'GET /api/overview') return send(res, 200, overview(db));
  if (route === 'GET /api/projects') return send(res, 200, allProjects(db));
  if (route === 'POST /api/projects') return send(res, 201, saveProject(db, parseJson(await readBody(req))));

  if (route === 'GET /api/leads') {
    const rows = db.prepare('SELECT * FROM leads ORDER BY updated_at DESC, id DESC').all();
    return send(res, 200, rows.map((l) => ({ ...l, dial_blocker: dialBlocker(l) })));
  }
  if (route === 'POST /api/leads') {
    const result = addLead(db, parseJson(await readBody(req)));
    return send(res, result.ok ? 201 : 400, result);
  }
  if (route === 'POST /api/leads/csv') {
    const results = parseCsv(await readBody(req)).map((row) => addLead(db, row));
    return send(res, 200, { added: results.filter((r) => r.ok).length, errors: results.filter((r) => !r.ok).map((r) => r.error) });
  }
  if (/^GET \/api\/leads\/\d+$/.test(route)) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return send(res, 404, { error: 'Lead not found' });
    return send(res, 200, { ...lead, calls: db.prepare(LEAD_DETAIL.calls).all(id), appointments: db.prepare(LEAD_DETAIL.appointments).all(id) });
  }
  if (/^POST \/api\/leads\/\d+\/call$/.test(route)) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return send(res, 404, { error: 'Lead not found' });
    const result = await dialLead(db, lead);
    return send(res, result.ok ? 200 : 400, result);
  }

  if (route === 'GET /api/calls') {
    return send(res, 200, db.prepare(`SELECT c.*, l.name lead, l.phone, m.name campaign FROM calls c LEFT JOIN leads l ON l.id = c.lead_id
      LEFT JOIN campaigns m ON m.id = c.campaign_id ORDER BY c.id DESC LIMIT 200`).all());
  }
  if (route === 'GET /api/appointments') {
    return send(res, 200, db.prepare(`SELECT a.*, l.name lead, l.phone, l.pref_bhk, l.budget_lakh, l.summary, p.name project, r.name rep
      FROM appointments a JOIN leads l ON l.id = a.lead_id LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN reps r ON r.id = a.rep_id
      ORDER BY a.status = 'scheduled' DESC, a.date, a.time`).all());
  }
  if (/^POST \/api\/appointments\/\d+$/.test(route)) {
    const { status } = parseJson(await readBody(req));
    if (!['scheduled', 'completed', 'cancelled'].includes(status)) return send(res, 400, { error: 'Invalid status' });
    db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/campaigns') {
    return send(res, 200, db.prepare(`SELECT c.*, p.name project, COUNT(x.lead_id) total,
      SUM(x.state = 'dialled') dialled, SUM(x.state = 'skipped') skipped
      FROM campaigns c LEFT JOIN projects p ON p.id = c.project_id LEFT JOIN campaign_leads x ON x.campaign_id = c.id
      GROUP BY c.id ORDER BY c.id DESC`).all());
  }
  if (route === 'POST /api/campaigns') {
    const b = parseJson(await readBody(req));
    const leadIds = (b.lead_ids ?? []).map(Number).filter(Boolean);
    if (!b.name?.trim() || !leadIds.length) return send(res, 400, { error: 'A name and at least one lead are required' });
    if (!config.bolnaKey || !config.agentId) return send(res, 400, { error: 'Connect Bolna before launching a campaign' });
    const { lastInsertRowid } = db.prepare('INSERT INTO campaigns (name, project_id) VALUES (?, ?)').run(b.name.trim(), b.project_id || null);
    const campaignId = Number(lastInsertRowid);
    for (const lead of leadIds) db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaignId, lead);
    runCampaign(db, campaignId).catch((err) => console.error('campaign failed', err));
    return send(res, 202, { id: campaignId });
  }
  if (route === 'POST /api/samples/clear') { clearSamples(db); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'Not found' });
}

export function createApp(db) {
  const page = () => readFileSync(path.join(ROOT, 'public/index.html'));
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname === '/healthz') return send(res, 200, { ok: true });

      if (req.method === 'POST' && pathname.startsWith('/tools/')) {
        const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!same(auth, config.toolToken)) return send(res, 401, { error: 'Unauthorized' });
        const handler = TOOL_HANDLERS[pathname.slice('/tools/'.length)];
        if (!handler || !Object.hasOwn(TOOL_HANDLERS, pathname.slice('/tools/'.length))) return send(res, 404, { error: 'Unknown tool' });
        const args = { ...Object.fromEntries(url.searchParams), ...parseJson(await readBody(req)) };
        const result = handler(db, args);
        console.log(`[tool] ${pathname.slice(7)} ${JSON.stringify(args)} -> ${result.ok ? 'ok' : result.message}`);
        return send(res, 200, result);
      }

      if (req.method === 'POST' && pathname === '/webhooks/bolna') {
        if (!same(url.searchParams.get('token') ?? '', config.toolToken)) return send(res, 401, { error: 'Unauthorized' });
        return send(res, 200, handleExecutionEvent(db, parseJson(await readBody(req))));
      }

      if (!dashboardAllowed(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="PropReach"' });
        return res.end('Authentication required');
      }
      if (pathname.startsWith('/api/')) return await api(db, req, res, pathname);
      if (req.method === 'GET' && pathname === '/') return send(res, 200, page(), 'text/html; charset=utf-8');
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!err.status) console.error(err);
      return send(res, err.status ?? 500, { ok: false, error: err.status ? err.message : 'Internal error', message: 'Something went wrong on our side. Offer a callback from the sales team.' });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(config.dbPath);
  createApp(db).listen(config.port, () => {
    console.log(`PropReach dashboard: http://localhost:${config.port}`);
    console.log(`Portfolio: ${portfolioBrief(db)}`);
    if (!config.bolnaKey) console.log('BOLNA_API_KEY not set: dashboard works, calling is off.');
  });
}
