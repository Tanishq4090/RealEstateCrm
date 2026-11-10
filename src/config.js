import { existsSync, appendFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(ROOT, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

if (!process.env.TOOL_TOKEN) {
  process.env.TOOL_TOKEN = randomBytes(24).toString('hex');
  if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
    try { appendFileSync(envPath, `\nTOOL_TOKEN=${process.env.TOOL_TOKEN}\n`, { mode: 0o600 }); } catch {}
  }
}

export const config = {
  get port() { return Number(process.env.PORT || 3000); },
  // Only this machine by default. The tunnel reaches it here, and nobody else on the network can.
  get host() { return process.env.HOST || '127.0.0.1'; },
  get toolToken() { return process.env.TOOL_TOKEN; },
  // Webhook URLs end up in logs, so a leaked one must not also unlock the tools.
  get webhookToken() { return createHash('sha256').update(`webhook:${process.env.TOOL_TOKEN}`).digest('hex'); },
  get bolnaKey() { return process.env.BOLNA_API_KEY || ''; },
  get agentId() { return process.env.BOLNA_AGENT_ID || ''; },
  // Render or Vercel supplies its own address, so a hosted server needs no URL set by hand.
  get publicUrl() {
    const raw = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') || process.env.RENDER_EXTERNAL_URL || '';
    return raw.replace(/\/$/, '');
  },
  get fromNumber() { return process.env.BOLNA_FROM_NUMBER || ''; },
  // The team's own phones. Only these may ring outside calling hours, so a test can run at night.
  get testPhones() { return (process.env.TEST_PHONES || '').split(',').map((p) => p.trim()).filter(Boolean); },
  get dashboardPassword() { return process.env.DASHBOARD_PASSWORD || ''; },
  get voiceProfile() { return process.env.VOICE_PROFILE || 'hinglish'; },
  get dbPath() { return process.env.DB_PATH || (process.env.VERCEL ? '/tmp/propreach.db' : path.join(ROOT, 'propreach.db')); },
};
