// Dialling through Bolna and turning webhook events into lead outcomes.
import { config } from './config.js';
import { allProjects, company } from './db.js';
import { isDialable, speakPrice } from './parse.js';

const API = 'https://api.bolna.ai';
const FAILED = new Set(['no-answer', 'busy', 'failed', 'canceled', 'stopped', 'error', 'balance-low']);

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

export async function dialLead(db, lead, campaign = null, fetchImpl = fetch) {
  const blocked = dialBlocker(lead);
  if (blocked) return { ok: false, error: blocked };
  if (!config.bolnaKey || !config.agentId) return { ok: false, error: 'BOLNA_API_KEY or BOLNA_AGENT_ID is not set' };

  const project = campaign?.project_id
    ? db.prepare('SELECT name FROM projects WHERE id = ?').get(campaign.project_id)?.name : null;
  const body = {
    agent_id: config.agentId,
    recipient_phone_number: lead.phone,
    user_data: {
      lead_id: String(lead.id), customer_name: lead.name.split(' ')[0],
      builder_name: company(db).name, campaign_project: project ?? 'our current projects',
      enquiry: lead.enquiry || 'residential properties', portfolio_brief: portfolioBrief(db),
      timezone: 'Asia/Kolkata',
    },
  };
  if (config.fromNumber) body.from_phone_number = config.fromNumber;

  const res = await fetchImpl(`${API}/call`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${config.bolnaKey}`, 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.execution_id) return { ok: false, error: data.message || `Bolna returned ${res.status}` };

  db.prepare(`INSERT INTO calls (execution_id, lead_id, campaign_id) VALUES (?, ?, ?)
    ON CONFLICT (execution_id) DO UPDATE SET lead_id = excluded.lead_id, campaign_id = excluded.campaign_id`)
    .run(data.execution_id, lead.id, campaign?.id ?? null);
  return { ok: true, execution_id: data.execution_id };
}

/** Applies one Bolna execution event. Safe for duplicate and out-of-order delivery. */
export function handleExecutionEvent(db, event) {
  const executionId = event.id ?? event.execution_id;
  if (!executionId || !event.status) return { ignored: true };
  const lead = db.prepare('SELECT id FROM leads WHERE phone = ?').get(event.user_number ?? '');
  db.prepare(`INSERT INTO calls (execution_id, lead_id, status) VALUES (?, ?, ?)
    ON CONFLICT (execution_id) DO UPDATE SET status = excluded.status WHERE ended_at IS NULL`)
    .run(executionId, lead?.id ?? null, event.status);

  const call = db.prepare('SELECT * FROM calls WHERE execution_id = ?').get(executionId);
  const final = event.status === 'completed' || FAILED.has(event.status);
  if (!final || call.ended_at) return { final, duplicate: Boolean(call.ended_at) };

  const transcript = event.transcript ?? '';
  const duration = Math.round(event.conversation_duration ?? event.telephony_data?.duration ?? 0);
  const connected = event.status === 'completed' && /(^|\n)\s*user:/i.test(transcript) ? 1 : 0;
  const summary = event.summary ?? event.extracted_data?.General?.['Call Summary']?.subjective ?? null;
  db.prepare(`UPDATE calls SET status = ?, connected = ?, duration = ?, transcript = ?, summary = ?, recording_url = ?, cost = ?, ended_at = datetime('now') WHERE id = ?`)
    .run(event.status, connected, duration, transcript || null, summary, event.telephony_data?.recording_url ?? null, event.total_cost ?? null, call.id);

  const leadId = call.lead_id ?? lead?.id;
  if (leadId) finalizeLead(db, leadId, { connected, summary, startedAt: call.created_at });
  return { final: true };
}

function finalizeLead(db, leadId, { connected, summary, startedAt }) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  const pending = (type) => db.prepare(`SELECT 1 FROM appointments WHERE lead_id = ? AND type = ? AND status = 'scheduled' AND created_at >= ?`).get(leadId, type, startedAt);
  let status = lead.status, nextAction = lead.next_action;

  if (!connected) {
    if (['new', 'unreachable'].includes(status)) { status = 'unreachable'; nextAction = 'Retry on another day'; }
  } else if (status === 'not_interested' || lead.do_not_call) {
    status = 'not_interested'; nextAction = 'None';
  } else if (pending('visit')) {
    status = 'hot';
  } else if (pending('callback')) {
    if (!['hot', 'warm'].includes(status)) status = 'callback_requested';
  } else if (status === 'new' || status === 'unreachable') {
    status = 'unclassified'; nextAction = 'Review the transcript';
  }

  db.prepare(`UPDATE leads SET status = ?, next_action = ?, summary = COALESCE(?, summary), updated_at = datetime('now') WHERE id = ?`)
    .run(status, nextAction, summary, leadId);
  // The rep sees the conversation before the callback or visit.
  if (summary) {
    db.prepare(`UPDATE appointments SET notes = TRIM(COALESCE(notes || ' | ', '') || ?) WHERE lead_id = ? AND status = 'scheduled' AND created_at >= ?`)
      .run(summary, leadId, startedAt);
  }
}

export async function runCampaign(db, campaignId, fetchImpl = fetch, gapMs = 1500) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  const rows = db.prepare(`SELECT l.* FROM leads l JOIN campaign_leads c ON c.lead_id = l.id WHERE c.campaign_id = ? AND c.state = 'pending'`).all(campaignId);
  const mark = db.prepare('UPDATE campaign_leads SET state = ?, detail = ? WHERE campaign_id = ? AND lead_id = ?');
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaignId);
  for (const lead of rows) {
    const result = await dialLead(db, lead, campaign, fetchImpl).catch((err) => ({ ok: false, error: err.message }));
    mark.run(result.ok ? 'dialled' : 'skipped', result.error ?? null, campaignId, lead.id);
    if (result.ok && gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  db.prepare("UPDATE campaigns SET status = 'done' WHERE id = ?").run(campaignId);
}
