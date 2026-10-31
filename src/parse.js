// Normalises the loose values an LLM passes from a phone conversation.

const MISSING = new Set([
  '', 'any', 'anywhere', 'unknown', 'none', 'null', 'undefined', 'n/a', 'na', 'nil',
  'not specified', 'no preference', 'not sure', 'not mentioned', 'not provided',
]);

/** Treats sentinels and unsubstituted %(x)s templates as absent. */
export function clean(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (MISSING.has(s.toLowerCase()) || /^%\(\w+\)[sif]$/.test(s)) return null;
  return s;
}

const ONES = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const TENS_RE = new RegExp(`\\b(${Object.keys(TENS).join('|')})(?:[ -](${Object.keys(ONES).slice(0, 9).join('|')}))?\\b`, 'g');
const ONES_RE = new RegExp(`\\b(${Object.keys(ONES).join('|')})\\b( and a half)?`, 'g');

const asciiDigits = (s) => s.replace(/[०-९]/g, (d) => d.charCodeAt(0) - 0x966);

/** Spoken numbers to digits: "one and a half", "ninety five", "dedh", "one point five". */
const wordsToDigits = (text) => text
  .replace(/\b(?:dedh|derh)\b|डेढ़?/g, '1.5').replace(/\b(?:dhai|adhai)\b|ढाई/g, '2.5')
  .replace(TENS_RE, (_, tens, ones) => TENS[tens] + (ONES[ones] ?? 0))
  .replace(ONES_RE, (_, word, half) => ONES[word] + (half ? 0.5 : 0))
  .replace(/(\d+)\s+point\s+(\d+)/g, '$1.$2');

/** "1.5 crore", "1 crore 35 lakh", "80 to 90 lakh", "१.५ करोड़" -> top of the stated budget, in lakh. */
export function parseBudgetLakh(value) {
  const s = clean(value);
  if (!s) return null;
  const text = wordsToDigits(asciiDigits(s.normalize('NFC')).toLowerCase()
    .replace(/[,₹]/g, '').replace(/\b(?:rs\.?|rupees?|inr)(?=\s|\d|$)/g, ' ')
    .replace(/करोड़?/g, 'crore').replace(/लाख/g, 'lakh'));
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(crores?|crs?|lakhs?|lacs?|l)?\b/g)]
    .map((m) => ({ n: Number(m[1]), unit: m[2]?.[0] }));
  if (!parts.length) return null;
  const last = parts.at(-1), prev = parts.at(-2);
  if (prev?.unit === 'c' && last.unit !== 'c') return prev.n * 100 + last.n; // 1 crore 20 lakh
  if (last.unit === 'c') return last.n * 100;                                // 1 to 1.5 crore
  if (last.unit === 'l') return last.n;                                      // 80 to 90 lakh
  if (last.n >= 100000) return last.n / 100000;                              // plain rupees
  return last.n < 20 ? last.n * 100 : last.n;                                // "1.5" means crore, "90" means lakh
}

export function parseBhk(value) {
  const s = clean(value);
  if (!s) return null;
  const m = asciiDigits(s).match(/\d/);
  if (m) return Number(m[0]);
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5 };
  const w = s.toLowerCase().match(/\b(?:one|two|three|four|five)\b|एक|दो|तीन|चार|पांच|पाँच/);
  return w ? words[w[0]] : null;
}

const DAY_PARTS = { morning: '10:00', 'सुबह': '10:00', afternoon: '14:00', 'दोपहर': '14:00', noon: '12:00', evening: '18:00', 'शाम': '18:00' };

/** "10 AM", "2:30 pm", "14:00", "after 6", "evening" -> "HH:MM". */
export function parseTime(value) {
  const s = clean(value);
  if (!s) return null;
  const text = wordsToDigits(asciiDigits(s).toLowerCase());
  const m = text.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m|p\.?m)?/);
  if (!m) {
    const word = Object.keys(DAY_PARTS).find((k) => text.includes(k));
    return word ? DAY_PARTS[word] : null;
  }
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const pm = m[3]?.startsWith('p') || /evening|afternoon|night|sha+m|शाम|दोपहर|रात/.test(text);
  const am = m[3]?.startsWith('a') || /morning|subah|सुबह/.test(text);
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (!pm && !am && m[1].length === 1 && h >= 1 && h <= 7) h += 12; // "after 6" never means 6 AM
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
  if (lakh < 100) return `${Number(lakh.toFixed(1))} lakh`;
  const crore = Math.floor(lakh / 100), rest = Number((lakh - crore * 100).toFixed(1));
  return rest ? `${crore} crore ${rest} lakh` : `${crore} crore`;
}

/** Returns E.164 or null. Ten-digit numbers are assumed Indian. */
export function normalizePhone(value) {
  const s = String(value ?? '').replace(/[\s()-]/g, '').replace(/^0(?=[6-9]\d{9}$)/, '');
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

const CSV_ALIASES = {
  phone_number: 'phone', mobile: 'phone', mobile_number: 'phone', contact_number: 'phone',
  full_name: 'name', customer_name: 'name',
};

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
  const keys = header.map((h) => {
    const key = h.trim().toLowerCase().replace(/\s+/g, '_');
    return CSV_ALIASES[key] ?? key;
  });
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
