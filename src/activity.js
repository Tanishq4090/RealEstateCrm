// Turns finished calls into the story shown on the Overview: what Asha did, in the buyer's own words.
import { ABUSIVE_NEXT_STEP } from './calls.js';
import { speakPrice } from './parse.js';

const BUYING_WORDS = /bhk|crore|lakh|budget|visit|looking|want|need|family|invest/i;
const MAX_QUOTE = 120;
const MAX_NOTE = 140;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Picks the line that best shows what the buyer wanted. Short replies like "yes please" say nothing. */
export function bestQuote(transcript) {
  const lines = (transcript ?? '').split('\n')
    .map((line) => line.match(/^\s*user:\s*(.+)$/i)?.[1]?.trim())
    .filter((line) => line && line.split(/\s+/).length >= 4);
  const pick = lines.find((line) => BUYING_WORDS.test(line)) ?? [...lines].sort((a, b) => b.length - a.length)[0];
  return pick ? clip(pick, MAX_QUOTE) : null;
}

export function recentActivity(db, limit = 6) {
  const calls = db.prepare(`SELECT c.id call_id, c.lead_id, c.transcript, c.summary, c.created_at, c.ended_at,
      l.name lead, l.status, l.do_not_call, l.next_action, l.pref_bhk, l.pref_location, l.budget_lakh, l.interested_project
    FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.connected = 1 ORDER BY c.id DESC LIMIT ?`).all(limit);
  const booking = db.prepare(`SELECT a.type, a.date, a.time, p.name project FROM appointments a
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.lead_id = ? AND a.status != 'cancelled' AND a.created_at >= ? AND a.created_at <= datetime(?, '+1 minute')
    ORDER BY a.type = 'visit' DESC, a.id DESC LIMIT 1`);

  return calls.map((c) => {
    const made = booking.get(c.lead_id, c.created_at, c.ended_at ?? c.created_at);
    const abusive = c.next_action === ABUSIVE_NEXT_STEP;
    const kind = abusive ? 'abusive' : c.do_not_call ? 'optout' : made?.type ?? 'spoke';
    const quote = abusive ? null : bestQuote(c.transcript); // abuse never goes on the home page
    const place = made?.project ?? c.interested_project ?? c.pref_location; // a project already says where
    const details = [place, c.pref_bhk && `${c.pref_bhk} BHK`, c.budget_lakh && speakPrice(c.budget_lakh)];
    return {
      call_id: c.call_id, lead_id: c.lead_id, lead: c.lead, status: c.status, kind, quote,
      note: !quote && !abusive && c.summary ? clip(c.summary, MAX_NOTE) : null,
      date: made?.date ?? null, time: made?.time ?? null, details: [...new Set(details.filter(Boolean))], when: c.created_at,
    };
  });
}
