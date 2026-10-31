// Normalises the loose values an LLM passes from a phone conversation.

const MISSING = new Set(['', 'any', 'unknown', 'none', 'null', 'undefined', 'n/a', 'na', 'not specified', 'nil']);

/** Treats sentinels and unsubstituted %(x)s templates as absent. */
export function clean(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (MISSING.has(s.toLowerCase()) || /^%\(\w+\)[sif]$/.test(s)) return null;
  return s;
}

/** "1.5 crore", "90 lakh", "15000000", "₹1.2 cr" -> amount in lakh. */
export function parseBudgetLakh(value) {
  const s = clean(value);
  if (!s) return null;
  const text = s.toLowerCase().replace(/[,₹]/g, '').replace(/rs\.?|rupees?|inr/g, '');
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (/crore|\bcr\b|\d\s*cr/.test(text)) return n * 100;
  if (/lakh|lac|\bl\b|\d\s*l\b/.test(text)) return n;
  if (n >= 100000) return n / 100000;   // plain rupees
  if (n < 20) return n * 100;           // "1.5" said in crores
  return n;                             // "90" said in lakh
}

export function parseBhk(value) {
  const s = clean(value);
  if (!s) return null;
  const m = s.match(/\d/);
  if (m) return Number(m[0]);
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const w = s.toLowerCase().match(/one|two|three|four|five/);
  return w ? words[w[0]] : null;
}

/** "10 AM", "2:30 pm", "14:00" -> "HH:MM". */
export function parseTime(value) {
  const s = clean(value);
  if (!s) return null;
  const m = s.toLowerCase().match(/(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m|p\.?m)?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]?.startsWith('p') && h < 12) h += 12;
  if (m[3]?.startsWith('a') && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseDate(value) {
  const s = clean(value);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 ? s : null;
}

export function todayIST(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function nextWeekday(from, weekday) {
  const d = new Date(`${from}T00:00:00Z`).getUTCDay();
  return addDays(from, ((weekday - d + 7) % 7) || 7);
}

export function speakDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

export function speakTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

export function speakPrice(lakh) {
  if (lakh >= 100) return `${Number((lakh / 100).toFixed(2))} crore rupees`;
  return `${Number(lakh.toFixed(1))} lakh rupees`;
}

/** Returns E.164 or null. Ten-digit numbers are assumed Indian. */
export function normalizePhone(value) {
  const s = String(value ?? '').replace(/[\s()-]/g, '');
  if (/^[6-9]\d{9}$/.test(s)) return `+91${s}`;
  if (/^91[6-9]\d{9}$/.test(s)) return `+${s}`;
  return /^\+\d{10,15}$/.test(s) ? s : null;
}

/** True only for numbers a real person could own. Sample leads fail this. */
export function isDialable(phone) {
  if (!phone) return false;
  if (phone.startsWith('+91')) return /^\+91[6-9]\d{9}$/.test(phone);
  return /^\+[1-9]\d{9,14}$/.test(phone);
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
