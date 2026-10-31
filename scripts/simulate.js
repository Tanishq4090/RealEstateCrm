// Replays the vision document's conversation against a running server, using
// the same tool and webhook endpoints Bolna calls. No phone or Bolna key needed.
import { config } from '../src/config.js';
import { todayIST, nextWeekday, speakDate } from '../src/parse.js';

const base = process.env.BASE_URL || `http://localhost:${config.port}`;
const tool = async (name, args) => {
  const res = await fetch(`${base}/tools/${name}`, { method: 'POST',
    headers: { Authorization: `Bearer ${config.toolToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const out = await res.json();
  console.log(`\n> ${name} ${JSON.stringify(args)}\n${JSON.stringify(out, null, 1).slice(0, 700)}`);
  return out;
};
const hook = (event) => fetch(`${base}/webhooks/bolna?token=${config.toolToken}`, { method: 'POST', body: JSON.stringify(event) });

const headers = config.dashboardPassword ? { Authorization: `Basic ${Buffer.from(`admin:${config.dashboardPassword}`).toString('base64')}` } : {};
const leads = await (await fetch(`${base}/api/leads`, { headers })).json();
const lead = leads.find((l) => l.phone === '+910000000001');
if (!lead) { console.error('Sample lead Rahul is gone. Delete propreach.db to reseed.'); process.exit(1); }

const id = `sim-${Date.now()}`;
const user_number = lead.phone;
const saturday = nextWeekday(todayIST(), 6);
await hook({ id, status: 'in-progress', user_number });

await tool('search_projects', { location: 'Whitefield', bhk: '3', budget: '1.5 crore' });
await tool('search_projects', { location: 'Sarjapur', bhk: '3', budget: '1.5 crore' });
await tool('get_project_details', { project_names: 'Whitefield Heights, Sarjapur Residences' });
const check = await tool('check_slots', { project: 'Whitefield Heights', date: saturday, time: '10 AM' });
const slot = check.open_times[0];
const booking = await tool('book_visit', { lead_id: String(lead.id), project: 'Whitefield Heights', date: saturday, time: slot.spoken });
await tool('update_lead', { lead_id: String(lead.id), location: 'Whitefield', bhk: '3', budget: '1.5 crore', purpose: 'Self use',
  timeline: 'unknown', interested_project: 'Whitefield Heights', status: 'hot', do_not_call: 'false' });

const transcript = `[Simulated call, not a real conversation]
assistant: Hello Rahul, this is Asha, an AI assistant calling on behalf of ABC Developers. You had enquired about 3 BHK homes. Is this a good time to talk?
user: Yes, I'm looking for a 3 BHK around Whitefield. My budget is about 1.5 crore.
assistant: Whitefield Heights has 3 BHK homes from 1.35 crore rupees. Is this for your family or an investment?
user: For my family. Do you have anything around Sarjapur as well?
assistant: Yes, Sarjapur Residences has 3 BHK homes from 1.2 crore rupees. Whitefield is closer to ITPL, Sarjapur gives you a larger home for less.
user: I'd like to visit Whitefield on Saturday at 10.
assistant: 10 AM on ${speakDate(saturday)} is taken. ${slot.spoken} is open. Shall I book that?
user: Yes please.
assistant: ${booking.message} Thank you, Rahul.`;

await hook({ id, status: 'call-disconnected', user_number });
await hook({ id, status: 'completed', user_number, transcript, conversation_duration: 204, total_cost: 0,
  summary: 'Simulated call. Rahul wants a 3 BHK for family, budget 1.5 crore. Compared Whitefield and Sarjapur, booked a Whitefield Heights visit.' });
console.log(`\nDone. ${booking.message}\nOpen ${base}`);
