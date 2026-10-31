// Creates or updates the Bolna agent from src/agent-config.js.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../src/config.js';
import { buildAgent } from '../src/agent-config.js';

const API = 'https://api.bolna.ai';
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!config.bolnaKey) fail('Set BOLNA_API_KEY in .env first.');
if (!/^https:\/\//.test(config.publicUrl)) fail('Set PUBLIC_URL in .env to the public https URL of this server.');

const headers = { Authorization: `Bearer ${config.bolnaKey}`, 'Content-Type': 'application/json' };
const me = await fetch(`${API}/user/me`, { headers });
if (!me.ok) fail(`Bolna rejected the API key (${me.status}).`);
const account = await me.json();
console.log(`Bolna account OK. Wallet: ${account.wallet}. Concurrency: ${account.concurrency?.max}.`);

const health = await fetch(`${config.publicUrl}/healthz`).catch(() => null);
if (!health?.ok) fail(`${config.publicUrl}/healthz is not reachable. Start the server and tunnel first.`);

const body = buildAgent({ publicUrl: config.publicUrl, toolToken: config.toolToken, voiceProfile: config.voiceProfile });
const existing = config.agentId;
const send = (payload) => fetch(existing ? `${API}/v2/agent/${existing}` : `${API}/v2/agent`, {
  method: existing ? 'PUT' : 'POST', headers, body: JSON.stringify(payload),
});
let res = await send(body);
let text = await res.text();
if (res.status === 400 || res.status === 422) {
  // Bolna's schema types `tools` as an array but its description asks for a JSON string.
  const apiTools = body.agent_config.tasks[0].tools_config.api_tools;
  apiTools.tools = JSON.stringify(apiTools.tools);
  console.log(`First attempt rejected (${res.status}): ${text}\nRetrying with tools as a JSON string.`);
  res = await send(body);
  text = await res.text();
}
if (!res.ok) fail(`Bolna rejected the agent (${res.status}): ${text}\nTry VOICE_PROFILE=default in .env if the error names a voice or transcriber.`);

const agentId = existing || JSON.parse(text).agent_id;
if (!existing) {
  const envPath = path.join(ROOT, '.env');
  const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (/^BOLNA_AGENT_ID=.*$/m.test(env)) writeFileSync(envPath, env.replace(/^BOLNA_AGENT_ID=.*$/m, `BOLNA_AGENT_ID=${agentId}`));
  else appendFileSync(envPath, `\nBOLNA_AGENT_ID=${agentId}\n`);
}
console.log(`Agent ${existing ? 'updated' : 'created'}: ${agentId}\nRestart the server so it picks up the agent id.`);
