import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createAuth, isHttps, same } from './auth.js';
import { config, ROOT } from './config.js';
import { allProjects, clearSamples, company, openDb } from './db.js';
import { dialBlocker, dialLead, handleExecutionEvent, portfolioBrief, runCampaign } from './calls.js';
import { TOOL_HANDLERS } from './tools.js';
import { normalizePhone, parseCsv } from './parse.js';

const MAX_BODY = 2_000_000;
const CLIENT_HEADER = 'x-propreach-client';
const MIN_PASSWORD = 12;

function baseHeaders(req) {
  return {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...(isHttps(req) && { 'Strict-Transport-Security': 'max-age=31536000' }),
  };
}

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { ...baseHeaders(res.req), 'Content-Type': type, ...extra });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function redirect(res, location) {
  res.writeHead(302, { ...baseHeaders(res.req), Location: location });
  res.end();
}

/** Serves a page whose one inline script is allowed by a fresh nonce, so injected scripts cannot run. */
function sendPage(res, file) {
  const nonce = randomBytes(16).toString('base64');
  const html = readFileSync(path.join(ROOT, 'public', file), 'utf8').replace('<script>', `<script nonce="${nonce}">`);
  send(res, 200, html, 'text/html; charset=utf-8', {
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; media-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
}

/** Blocks DNS rebinding: a hostile site pointing its own domain at this machine. */
function hostAllowed(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  const allowed = ['localhost', '127.0.0.1', '[::1]'];
  if (config.publicUrl) allowed.push(new URL(config.publicUrl).hostname);
  return allowed.includes(host);
}

/** Blocks cross-site requests. Other sites cannot set this header without a CORS approval we never give. */
function fromDashboard(req) {
  if (req.headers[CLIENT_HEADER] !== 'dashboard') return false;
  const { origin } = req.headers;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const isRecordingUrl = (url) => {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'api.bolna.ai'; } catch { return false; }
};

// Bolna serves recordings to anyone holding the URL, and the URL contains the execution id.
// Neither goes to the browser, which streams audio through the signed-in route instead.
const publicCall = ({ recording_url, execution_id, ...call }) => ({ ...call, has_recording: isRecordingUrl(recording_url) });

async function streamRecording(db, req, res, id, fetchImpl) {
  const url = db.prepare('SELECT recording_url FROM calls WHERE id = ?').get(id)?.recording_url;
  if (!isRecordingUrl(url)) return send(res, 404, { error: 'No recording' });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const upstream = await fetchImpl(url, { signal: abort.signal, headers: req.headers.range ? { Range: req.headers.range } : {} });
  if (!upstream.ok || !upstream.body) return send(res, 404, { error: 'No recording' });
  const passed = {};
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) passed[name] = value;
  }
  res.writeHead(upstream.status, { ...baseHeaders(req), ...passed });
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

async function readBody(req) {
  let raw = '';
  req.setEncoding('utf8'); // keeps a Hindi character intact when it spans two chunks
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

function addLead(db, row) {
  const phone = normalizePhone(row.phone);
  const name = (row.name ?? '').trim();
  if (!name || !phone) return { ok: false, error: `Invalid name or phone: ${row.name ?? ''} ${row.phone ?? ''}` };
  const consent = ['1', 'true', 'yes', 'y'].includes(String(row.consent ?? '').trim().toLowerCase()) ? 1 : 0;
  const result = db.prepare(`INSERT INTO leads (name, phone, enquiry, source, consent) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (phone) DO NOTHING`).run(name, phone, row.enquiry ?? '', row.source ?? 'Upload', consent);
  return result.changes ? { ok: true, id: Number(result.lastInsertRowid), consent } : { ok: false, error: `Duplicate phone: ${phone}` };
}

function overview(db) {
  const one = (sql) => db.prepare(sql).get().n;
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all().map((r) => [r.status, r.n]));
  return {
    leads: one('SELECT COUNT(*) n FROM leads'),
    attempted: one('SELECT COUNT(*) n FROM calls'),
    connected: one('SELECT COUNT(*) n FROM calls WHERE connected = 1'),
    attemptedLeads: one('SELECT COUNT(DISTINCT lead_id) n FROM calls'),
    connectedLeads: one('SELECT COUNT(DISTINCT lead_id) n FROM calls WHERE connected = 1'),
    interested: (byStatus.hot ?? 0) + (byStatus.warm ?? 0) + (byStatus.callback_requested ?? 0),
    qualified: one("SELECT COUNT(*) n FROM leads WHERE status = 'hot' OR (status = 'warm' AND budget_lakh IS NOT NULL AND pref_bhk IS NOT NULL)"),
    hot: byStatus.hot ?? 0,
    hotBudgetLakh: one("SELECT COALESCE(SUM(budget_lakh), 0) n FROM leads WHERE status = 'hot'"),
    visits: one("SELECT COUNT(*) n FROM appointments WHERE type = 'visit' AND status != 'cancelled'"),
    visitLeads: one("SELECT COUNT(DISTINCT lead_id) n FROM appointments WHERE type = 'visit' AND status != 'cancelled'"),
    callbacks: one("SELECT COUNT(*) n FROM appointments WHERE type = 'callback' AND status != 'cancelled'"),
    byStatus,
    hasSamples: one('SELECT COUNT(*) n FROM leads WHERE is_sample = 1') > 0,
    calling: Boolean(config.bolnaKey && config.agentId),
    signInRequired: Boolean(config.dashboardPassword),
    company: company(db),
  };
}

const CAMPAIGN_SCORECARD = `SELECT c.*, p.name project,
    (SELECT COUNT(*) FROM campaign_leads x WHERE x.campaign_id = c.id) total,
    (SELECT COUNT(*) FROM campaign_leads x WHERE x.campaign_id = c.id AND x.state = 'dialled') dialled,
    (SELECT COUNT(*) FROM campaign_leads x WHERE x.campaign_id = c.id AND x.state = 'skipped') skipped,
    (SELECT GROUP_CONCAT(DISTINCT x.detail) FROM campaign_leads x WHERE x.campaign_id = c.id AND x.state = 'skipped') skip_reasons,
    (SELECT COUNT(DISTINCT k.lead_id) FROM calls k WHERE k.campaign_id = c.id AND k.connected = 1) reached,
    (SELECT COUNT(DISTINCT k.lead_id) FROM calls k JOIN leads l ON l.id = k.lead_id
      WHERE k.campaign_id = c.id AND k.connected = 1 AND l.status IN ('hot', 'warm', 'callback_requested')) interested,
    (SELECT COUNT(DISTINCT a.lead_id) FROM appointments a JOIN calls k ON k.lead_id = a.lead_id
      WHERE k.campaign_id = c.id AND a.type = 'visit' AND a.status != 'cancelled') visits
  FROM campaigns c LEFT JOIN projects p ON p.id = c.project_id ORDER BY c.id DESC`;

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

async function api(db, req, res, pathname, fetchImpl) {
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
    const added = results.filter((r) => r.ok);
    return send(res, 200, { added: added.length, noConsent: added.filter((r) => !r.consent).length, errors: results.filter((r) => !r.ok).map((r) => r.error) });
  }
  if (/^GET \/api\/leads\/\d+$/.test(route)) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return send(res, 404, { error: 'Lead not found' });
    return send(res, 200, { ...lead, calls: db.prepare(LEAD_DETAIL.calls).all(id).map(publicCall), appointments: db.prepare(LEAD_DETAIL.appointments).all(id) });
  }
  if (/^POST \/api\/leads\/\d+\/call$/.test(route)) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return send(res, 404, { error: 'Lead not found' });
    const result = await dialLead(db, lead);
    return send(res, result.ok ? 200 : 400, result.ok ? { ok: true } : { ok: false, error: result.error });
  }

  if (route === 'GET /api/calls') {
    return send(res, 200, db.prepare(`SELECT c.*, l.name lead, l.phone, l.status lead_status, m.name campaign,
        COALESCE(p.name, l.interested_project) project
      FROM calls c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN campaigns m ON m.id = c.campaign_id
      LEFT JOIN projects p ON p.id = m.project_id ORDER BY c.id DESC LIMIT 200`).all().map(publicCall));
  }
  if (/^GET \/api\/calls\/\d+\/recording$/.test(route)) return streamRecording(db, req, res, id, fetchImpl);
  if (route === 'GET /api/appointments') {
    return send(res, 200, db.prepare(`SELECT a.*, l.name lead, l.phone, l.pref_bhk, l.budget_lakh, l.summary, p.name project, r.name rep
      FROM appointments a JOIN leads l ON l.id = a.lead_id LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN reps r ON r.id = a.rep_id
      ORDER BY a.status = 'scheduled' DESC, a.date, a.time`).all());
  }
  if (/^POST \/api\/appointments\/\d+$/.test(route)) {
    const { status } = parseJson(await readBody(req));
    if (!['scheduled', 'completed', 'cancelled'].includes(status)) return send(res, 400, { error: 'Invalid status' });
    let changed;
    try {
      changed = db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id).changes;
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return send(res, 409, { error: 'That slot has been taken' });
      throw err;
    }
    if (!changed) return send(res, 404, { error: 'Appointment not found' });
    if (status !== 'scheduled') {
      db.prepare(`UPDATE leads SET next_action = ?, updated_at = datetime('now') WHERE id = (SELECT lead_id FROM appointments WHERE id = ?)`)
        .run(status === 'cancelled' ? 'Rebook or follow up' : 'Follow up after visit', id);
    }
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/campaigns') {
    return send(res, 200, db.prepare(CAMPAIGN_SCORECARD).all());
  }
  if (route === 'POST /api/campaigns') {
    const b = parseJson(await readBody(req));
    const known = db.prepare('SELECT 1 FROM leads WHERE id = ?');
    const leadIds = (Array.isArray(b.lead_ids) ? b.lead_ids : []).map(Number).filter((id) => id && known.get(id));
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

export function createApp(db, { fetchImpl = fetch } = {}) {
  const auth = createAuth();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;
      if (pathname === '/healthz') return send(res, 200, { ok: true });

      if (req.method === 'POST' && pathname.startsWith('/tools/')) {
        const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!same(auth, config.toolToken)) return send(res, 401, { error: 'Unauthorized' });
        const name = pathname.slice('/tools/'.length);
        if (!Object.hasOwn(TOOL_HANDLERS, name)) return send(res, 404, { error: 'Unknown tool' });
        const handler = TOOL_HANDLERS[name];
        const args = { ...Object.fromEntries(url.searchParams), ...parseJson(await readBody(req)) };
        const result = handler(db, args);
        console.log(`[tool] ${name} ${JSON.stringify(args)} -> ${result.ok ? 'ok' : result.message}`);
        return send(res, 200, result);
      }

      if (req.method === 'POST' && pathname === '/webhooks/bolna') {
        if (!same(url.searchParams.get('token') ?? '', config.webhookToken)) return send(res, 401, { error: 'Unauthorized' });
        return send(res, 200, handleExecutionEvent(db, parseJson(await readBody(req))));
      }

      // Everything below is the dashboard, reached by a person in a browser.
      if (!hostAllowed(req)) return send(res, 403, { error: 'Forbidden' });
      if (req.method !== 'GET' && !fromDashboard(req)) return send(res, 403, { error: 'Forbidden' });

      if (pathname === '/login') {
        if (req.method === 'GET') return auth.isSignedIn(req) ? redirect(res, '/') : sendPage(res, 'login.html');
        if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
        const { status, cookie } = auth.signIn(req, parseJson(await readBody(req)).password);
        return send(res, status, { ok: status === 200 }, 'application/json', cookie ? { 'Set-Cookie': cookie } : {});
      }
      if (req.method === 'POST' && pathname === '/logout') {
        return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': auth.signOut(req) });
      }
      if (!auth.isSignedIn(req)) {
        return pathname.startsWith('/api/') ? send(res, 401, { error: 'Sign in required' }) : redirect(res, '/login');
      }
      if (pathname.startsWith('/api/')) return await api(db, req, res, pathname, fetchImpl);
      if (req.method === 'GET' && pathname === '/') return sendPage(res, 'index.html');
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err.name === 'AbortError' || res.headersSent) return res.destroy();
      if (!err.status) console.error(err);
      return send(res, err.status ?? 500, { ok: false, error: err.status ? err.message : 'Internal error', message: 'Something went wrong on our side. Offer a callback from the sales team.' });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (config.publicUrl && config.dashboardPassword.length < MIN_PASSWORD) {
    console.error(`Set DASHBOARD_PASSWORD to at least ${MIN_PASSWORD} characters: PUBLIC_URL makes this dashboard public.`);
    process.exit(1);
  }
  const db = openDb(config.dbPath);
  // A restart ends the dialling loop. Never resume it silently.
  db.prepare("UPDATE campaigns SET status = 'interrupted' WHERE status = 'running'").run();
  createApp(db).listen(config.port, config.host, () => {
    console.log(`PropReach dashboard: http://localhost:${config.port}`);
    console.log(`Portfolio: ${portfolioBrief(db)}`);
    if (!config.bolnaKey) console.log('BOLNA_API_KEY not set: dashboard works, calling is off.');
  });
}
