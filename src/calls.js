// Dialling through Bolna and turning webhook events into lead outcomes.
import { config } from './config.js';
import { allProjects, company } from './db.js';
import { isDialable, speakDate, speakPrice, speakTime } from './parse.js';

const API = 'https://api.bolna.ai';
const FAILED = new Set(['no-answer', 'busy', 'failed', 'canceled', 'stopped', 'error', 'balance-low']);
export const LEAD_STATUSES = new Set(['hot', 'warm', 'cold', 'not_interested', 'callback_requested']);

export function portfolioBrief(db) {
  return allProjects(db).map((p) => {
    const units = p.configs.filter((c) => c.units_left > 0)
      .map((c) => `${c.bhk} BHK from ${speakPrice(c.price_lakh)}`).join(', ');
    return `${p.name} in ${p.location}: ${units || 'sold out'}`;
  }).join('. ');
}

export function dialBlocker(lead) {
  if (!lead.consent) return 'no consent on record';
  if (lead.do_not_call) return 'on do-not-call list';
  if (!isDialable(lead.phone)) return 'sample or invalid number';
  return null;
}

/** What earlier calls learned, so a repeat call does not start from nothing. */
function knownSoFar(db, lead) {
  const facts = [
    lead.pref_bhk && `${lead.pref_bhk} BHK`, lead.pref_location, lead.budget_lakh && `budget ${speakPrice(lead.budget_lakh)}`,
    lead.purpose, lead.timeline,
  ].filter(Boolean);
  const visits = db.prepare(`SELECT p.name, a.date, a.time FROM appointments a JOIN projects p ON p.id = a.project_id
    WHERE a.lead_id = ? AND a.type = 'visit' AND a.status = 'scheduled' ORDER BY a.date, a.time`).all(lead.id);
  const parts = [];
  if (facts.length) parts.push(`Told us before: ${facts.join(', ')}`);
  for (const v of visits) parts.push(`Visit booked: ${v.name} on ${speakDate(v.date)} at ${speakTime(v.time)}`);
  return parts.join('. ') || 'Nothing yet, this is the first conversation.';
}

const firstName = (name) => name.replace(/^(mr|mrs|ms|dr|shri|smt)\.?\s+/i, '').split(' ')[0];

const dialling = new Set();

export async function dialLead(db, lead, campaign = null, fetchImpl = fetch) {
  if (dialling.has(lead.id)) return { ok: false, error: 'already being dialled' };
  dialling.add(lead.id);
  try { return await placeCall(db, lead, campaign, fetchImpl); } finally { dialling.delete(lead.id); }
}

async function placeCall(db, lead, campaign, fetchImpl) {
  const blocked = dialBlocker(lead);
  if (blocked) return { ok: false, error: blocked };
  if (!config.bolnaKey || !config.agentId) return { ok: false, error: 'BOLNA_API_KEY or BOLNA_AGENT_ID is not set' };

  // A manual call only waits for the live call to end. Campaigns also leave recent and booked buyers alone.
  const recent = campaign
    ? "(created_at > datetime('now', '-1 day') OR lead_id IN (SELECT lead_id FROM appointments WHERE status = 'scheduled'))"
    : "(ended_at IS NULL AND created_at > datetime('now', '-10 minutes'))";
  if (db.prepare(`SELECT 1 FROM calls WHERE lead_id = ? AND ${recent}`).get(lead.id)) return { ok: false, error: 'already called recently' };

  const project = campaign?.project_id
    ? db.prepare('SELECT name FROM projects WHERE id = ?').get(campaign.project_id)?.name : null;
  const body = {
    agent_id: config.agentId,
    recipient_phone_number: lead.phone,
    user_data: {
      lead_id: String(lead.id), customer_name: firstName(lead.name),
      builder_name: company(db).name, campaign_project: project ?? 'our current projects',
      enquiry: lead.enquiry || 'residential properties', portfolio_brief: portfolioBrief(db),
      known_so_far: knownSoFar(db, lead), timezone: 'Asia/Kolkata',
    },
  };
  if (config.fromNumber) body.from_phone_number = config.fromNumber;

  const res = await fetchImpl(`${API}/call`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${config.bolnaKey}`, 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.execution_id) return { ok: false, error: data.message || `Bolna returned ${res.status}`, retry: res.status === 429 };

  db.prepare(`INSERT INTO calls (execution_id, lead_id, campaign_id) VALUES (?, ?, ?)
    ON CONFLICT (execution_id) DO UPDATE SET lead_id = excluded.lead_id, campaign_id = excluded.campaign_id`)
    .run(data.execution_id, lead.id, campaign?.id ?? null);
  return { ok: true, execution_id: data.execution_id };
}

/** Applies one Bolna execution event. Safe for duplicate and out-of-order delivery. */
export function handleExecutionEvent(db, event) {
  const executionId = event.id ?? event.execution_id;
  if (!executionId || !event.status) return { ignored: true };
  const lead = db.prepare('SELECT id FROM leads WHERE phone = ?').get(event.user_number ?? event.telephony_data?.to_number ?? '');
  db.prepare(`INSERT INTO calls (execution_id, lead_id, status) VALUES (?, ?, ?)
    ON CONFLICT (execution_id) DO UPDATE SET status = excluded.status WHERE ended_at IS NULL`)
    .run(executionId, lead?.id ?? null, event.status);

  const call = db.prepare('SELECT * FROM calls WHERE execution_id = ?').get(executionId);
  const final = event.status === 'completed' || FAILED.has(event.status);
  if (!final || call.ended_at) return { final, duplicate: Boolean(call.ended_at) };

  const transcript = event.transcript ?? '';
  const duration = Math.round(event.conversation_duration ?? event.telephony_data?.duration ?? 0);
  // `completed` alone does not mean a conversation happened: a voicemail greeting also produces user lines.
  const machine = event.termination_reason === 'voicemail_reached' || event.answered_by_voice_mail === true;
  const connected = event.status === 'completed' && !machine && /(^|\n)\s*user:/i.test(transcript) ? 1 : 0;
  const summary = event.summary || event.extracted_data?.General?.['Call Summary']?.subjective || null;
  db.prepare(`UPDATE calls SET status = ?, connected = ?, duration = ?, transcript = ?, summary = ?, recording_url = ?, cost = ?, ended_at = datetime('now') WHERE id = ?`)
    .run(event.status, connected, duration, transcript || null, summary, event.telephony_data?.recording_url ?? null, event.total_cost ?? null, call.id);

  const leadId = call.lead_id ?? lead?.id;
  if (leadId) {
    finalizeLead(db, leadId, { connected, summary, startedAt: call.created_at, outcome: event.extracted_data?.['Lead Outcome'] ?? {} });
  }
  return { final: true };
}

function finalizeLead(db, leadId, { connected, summary, startedAt, outcome }) {
  // Safety net: the post-call extraction keeps an opt-out even if the agent never reached update_lead.
  if (connected && outcome['Do Not Call']?.objective === 'Yes') {
    db.prepare("UPDATE leads SET do_not_call = 1, status = 'not_interested', status_by = 'asha' WHERE id = ?").run(leadId);
    db.prepare("UPDATE appointments SET status = 'cancelled' WHERE lead_id = ? AND status = 'scheduled'").run(leadId);
  }
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  const pending = (type) => db.prepare(`SELECT 1 FROM appointments WHERE lead_id = ? AND type = ? AND status = 'scheduled' AND created_at >= ?`).get(leadId, type, startedAt);
  const engaged = connected || pending('visit') || pending('callback');
  let { status, next_action: nextAction, do_not_call: doNotCall } = lead;

  if (!engaged) {
    if (['new', 'unreachable'].includes(status)) { status = 'unreachable'; nextAction = 'Retry on another day'; }
  } else if (status === 'not_interested' || doNotCall) {
    status = 'not_interested'; nextAction = 'None';
  } else if (pending('visit')) {
    status = 'hot';
  } else if (pending('callback')) {
    if (!['hot', 'warm'].includes(status)) status = 'callback_requested';
  } else if (status === 'new' || status === 'unreachable') {
    const read = outcome['Lead Status']?.objective;
    if (LEAD_STATUSES.has(read)) {
      status = read;
      if (read === 'not_interested') { doNotCall = 1; nextAction = 'None'; }
    } else {
      status = 'unclassified'; nextAction = 'Review the transcript';
    }
  }

  db.prepare(`UPDATE leads SET status = ?, status_by = ?, next_action = ?, do_not_call = ?, summary = COALESCE(?, summary), updated_at = datetime('now') WHERE id = ?`)
    .run(status, status === lead.status ? lead.status_by : 'asha', nextAction, doNotCall, engaged ? summary : null, leadId);
  // The rep sees the conversation before the callback or visit.
  if (summary) {
    db.prepare(`UPDATE appointments SET notes = TRIM(COALESCE(notes || ' | ', '') || ?) WHERE lead_id = ? AND status = 'scheduled' AND created_at >= ?`)
      .run(summary, leadId, startedAt);
  }
}

export async function runCampaign(db, campaignId, fetchImpl = fetch, gapMs = 1500, retryMs = 30000) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  const rows = db.prepare("SELECT lead_id id FROM campaign_leads WHERE campaign_id = ? AND state = 'pending'").all(campaignId);
  const mark = db.prepare('UPDATE campaign_leads SET state = ?, detail = ? WHERE campaign_id = ? AND lead_id = ?');
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
  // Each lead is read fresh, so someone who opts out mid-campaign is not dialled.
  const dial = (id) => dialLead(db, db.prepare('SELECT * FROM leads WHERE id = ?').get(id), campaign, fetchImpl)
    .catch((err) => ({ ok: false, error: err.message }));
  const stopped = () => db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId).status === 'stopped';
  for (const { id } of rows) {
    if (stopped()) { mark.run('skipped', 'campaign stopped', campaignId, id); continue; }
    let result = await dial(id);
    if (result.retry) { await new Promise((r) => setTimeout(r, retryMs)); result = await dial(id); }
    mark.run(result.ok ? 'dialled' : 'skipped', result.error ?? null, campaignId, id);
    // Stop may have been pressed while this dial was in flight, so its call was not yet there to cancel.
    if (result.ok && stopped()) await cancelQueued(db, campaignId, fetchImpl);
    if (result.ok && gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  db.prepare("UPDATE campaigns SET status = 'done' WHERE id = ? AND status = 'running'").run(campaignId);
}

async function cancelQueued(db, campaignId, fetchImpl) {
  const queued = db.prepare("SELECT execution_id FROM calls WHERE campaign_id = ? AND ended_at IS NULL AND status IN ('queued', 'scheduled')").all(campaignId);
  await Promise.all(queued.map(({ execution_id: id }) => fetchImpl(`${API}/call/${encodeURIComponent(id)}/stop`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.bolnaKey}` },
  }).catch(() => null)));
}

/** Ends the dialling loop and cancels what Bolna has queued. Calls already ringing or connected carry on. */
export async function stopCampaign(db, campaignId, fetchImpl = fetch) {
  const { changes } = db.prepare("UPDATE campaigns SET status = 'stopped' WHERE id = ? AND status = 'running'").run(campaignId);
  if (!changes) return false;
  await cancelQueued(db, campaignId, fetchImpl);
  return true;
}
