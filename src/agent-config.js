// Builds the Bolna agent. Personalisation arrives per call through user_data.

export const WELCOME = "Hello {{customer_name}}, this is Asha, an AI assistant calling on behalf of {{builder_name}}. You had enquired about {{enquiry}}. Is this a good time to talk for a couple of minutes?";

export const SYSTEM_PROMPT = `You are Asha, an AI sales assistant for {{builder_name}}, a real estate developer. You are on an outbound phone call with {{customer_name}}, who enquired about {{enquiry}}. This campaign is about {{campaign_project}}, but you represent the builder's whole portfolio.

Customer record id: {{lead_id}}. Always pass this exact value as lead_id. Never say it aloud.

Current portfolio: {{portfolio_brief}}

HOW TO SPEAK
- This is a phone call. Use one or two short sentences, then let them talk. Ask one question at a time.
- Speak English by default. The transcript may show English words in Hindi script, such as "यस" for "yes" or "आफ्टर 6" for "after 6". Treat those as English and reply in English.
- Switch to Hindi only if the customer uses real Hindi sentences or asks for Hindi. If they ask for English, stay in English for the rest of the call.
- If what they said makes no sense, it was probably misheard. Politely ask them to repeat it. Never repeat nonsense back or guess at it.
- Say prices in words, for example "1.2 crore rupees". Never read out lists, symbols or ids.
- Sound like a helpful local consultant, not an advertisement. Do not repeat what they just said.
- If asked, say plainly that you are an AI assistant. Never claim to be human.

GOAL
Understand what they need, suggest what genuinely fits, and move them to a site visit. If they want a person, or ask about discounts, negotiation, loans or detailed payment terms, offer a callback from a property consultant.

Learn these naturally through conversation, never as a questionnaire: location, BHK, budget, self use or investment, purchase timeline, and whether they are actively looking.

TOOLS AND FACTS
- As soon as they mention a location, BHK or budget, call search_projects, and again whenever any of these change. This includes projects other than the campaign project. Pass "any" for what you do not know.
- If search_projects has no matches, say so honestly and offer the closest alternative with its reason.
- Use get_project_details for amenities, possession, payment plans, nearby places, FAQs, and to compare projects.
- Only state facts returned by tools or the portfolio above. If you do not know something, say the consultant will confirm it. Never invent prices, discounts, approvals, dates, or returns on investment. Never promise appreciation.
- When comparing, tie the differences to what they told you. Give a recommendation when asked which is better.

BOOKING
- Convert relative days such as "Saturday" to YYYY-MM-DD using the current date. Visits are bookable from tomorrow.
- Call check_slots before offering a time. If the time is unavailable, offer closest_open_time on the same day first, then other_days. Visits run in the daytime only, and only the open_times returned exist.
- After they agree to a time, call book_visit. Say a booking is confirmed only if the result has confirmed true. If it fails, offer what the result gives you.
- For callbacks, agree a date and time, then call schedule_callback with what they want to discuss.

BEFORE ENDING
This is mandatory on every connected call: call update_lead before you say goodbye, including right after a booking. Include everything learned and a status:
hot = clear intent, realistic budget, and wants a site visit or sales conversation.
warm = interested but still comparing or exploring.
cold = low immediate intent, or needs do not match any project.
callback_requested = wants to talk at another time.
not_interested = declines further contact.

If it is a bad time, ask when to call back, then call schedule_callback and update_lead with callback_requested.
If they say they are not interested once, thank them. If they ask not to be called again, call update_lead with do_not_call "true" and status not_interested, confirm they will not be called, and end politely. Do not push after a clear no.

Only after update_lead has returned, summarise any booking in one sentence, thank them, and say goodbye.`;

const str = (description) => ({ type: 'string', description });
const leadId = str('The customer record id from your instructions.');

const TOOLS = [
  { name: 'search_projects', pre_call_message: 'Let me check that for you.',
    description: "Find the builder's projects by location, BHK and budget, across the whole portfolio. Call when the customer mentions any requirement or asks what is available anywhere.",
    params: { lead_id: leadId, location: str('Area in English letters, for example Sarjapur, or "any".'), bhk: str('Bedroom count such as 3, or "any".'), budget: str('Budget such as "1.5 crore" or "90 lakh", or "any".') } },
  { name: 'get_project_details', pre_call_message: 'One moment.',
    description: 'Get amenities, sizes, possession, payment plan, nearby places and FAQs for one project, or several to compare.',
    params: { project_names: str('One project name, or several separated by commas.') } },
  { name: 'check_slots', pre_call_message: 'Let me look at the available slots.',
    description: 'Check real site visit availability for a project on a date. Call before offering any time.',
    params: { project: str('Project name.'), date: str('Date as YYYY-MM-DD.'), time: str('Preferred time such as "10 AM", or "any".') } },
  { name: 'book_visit', pre_call_message: 'Booking that for you now.',
    description: 'Reserve a site visit after the customer agrees to a specific project, date and time. Also moves an existing visit to that project.',
    params: { lead_id: leadId, project: str('Project name.'), date: str('Date as YYYY-MM-DD.'), time: str('Time such as "11:30 AM".') } },
  { name: 'schedule_callback', pre_call_message: 'Let me arrange that.',
    description: 'Schedule a call from a human property consultant, or a later call if this is a bad time.',
    params: { lead_id: leadId, date: str('Date as YYYY-MM-DD.'), time: str('Time such as "6 PM".'), topic: str('What the customer wants to discuss.') } },
  { name: 'update_lead', pre_call_message: '',
    description: 'Save what you learned and the lead status. Call once before ending every conversation, and immediately if the customer opts out.',
    params: { lead_id: leadId, location: str('Preferred area or "unknown".'), bhk: str('Preferred BHK or "unknown".'), budget: str('Budget or "unknown".'),
      purpose: str('"Self use", "Investment" or "unknown".'), timeline: str('When they plan to buy, or "unknown".'),
      interested_project: str('Project they liked most, or "unknown".'),
      status: str('hot, warm, cold, callback_requested or not_interested.'), do_not_call: str('"true" only if they ask not to be called again, otherwise "false".') } },
];

export function buildApiTools(publicUrl, toolToken) {
  const tools = [], tools_params = {};
  for (const t of TOOLS) {
    const names = Object.keys(t.params);
    tools.push({ name: t.name, description: t.description, key: 'custom_task', pre_call_message: t.pre_call_message,
      parameters: { type: 'object', properties: t.params, required: names } });
    tools_params[t.name] = { method: 'POST', url: `${publicUrl}/tools/${t.name}`, api_token: `Bearer ${toolToken}`,
      headers: { 'Content-Type': 'application/json' },
      param: Object.fromEntries(names.map((n) => [n, `%(${n})s`])) };
  }
  return { tools, tools_params };
}

const KEYWORDS = 'Whitefield, Whitefield Heights, Sarjapur, Sarjapur Residences, Electronic City, Electronic City Homes, BHK, crore, lakh, site visit, ITPL, possession';

const VOICES = {
  sarvam: {
    transcriber: { provider: 'sarvam', model: 'saaras:v4', language: 'en', stream: true, encoding: 'linear16', sampling_rate: 16000, endpointing: 250,
      keywords: KEYWORDS, context: 'Phone call between a Bengaluru real estate sales assistant and a home buyer discussing locations, BHK, budgets in lakh and crore, and site visits.' },
    synthesizer: { provider: 'sarvam', provider_config: { voice: 'Suhani', voice_id: 'suhani', model: 'bulbul:v3', language: 'en' }, stream: true, buffer_size: 250, audio_format: 'wav' },
  },
  default: {
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en', stream: true, encoding: 'linear16', sampling_rate: 16000, endpointing: 250 },
    synthesizer: { provider: 'elevenlabs', provider_config: { voice: 'Angelica', voice_id: 'IkSv4tkouLJ6kYsQA7XD', model: 'eleven_turbo_v2_5' }, stream: true, buffer_size: 250, audio_format: 'wav' },
  },
};

export function buildAgent({ publicUrl, toolToken, voiceProfile = 'sarvam' }) {
  const voice = VOICES[voiceProfile] ?? VOICES.sarvam;
  return {
    agent_config: {
      agent_name: 'PropReach Sales Executive',
      agent_welcome_message: WELCOME,
      webhook_url: `${publicUrl}/webhooks/bolna?token=${toolToken}`,
      call_summary_enabled: true,
      calling_guardrails: { call_start_hour: 9, call_end_hour: 21 },
      tasks: [{
        task_type: 'conversation',
        toolchain: { execution: 'sequential', pipelines: [['transcriber', 'llm', 'synthesizer']] },
        tools_config: {
          llm_agent: { agent_type: 'simple_llm_agent', agent_flow_type: 'streaming',
            llm_config: { provider: 'openai', model: 'gpt-4.1-mini', max_tokens: 300, temperature: 0.3 } },
          ...voice,
          input: { provider: 'plivo', format: 'wav' },
          output: { provider: 'plivo', format: 'wav' },
          api_tools: buildApiTools(publicUrl, toolToken),
        },
        task_config: { call_terminate: 480, hangup_after_silence: 15, hangup_after_LLMCall: true,
          call_cancellation_prompt: 'End the call only after the goodbye has been said by both sides, or the customer clearly wants to stop.',
          voicemail: true, backchanneling: false },
      }],
    },
    agent_prompts: { task_1: { system_prompt: SYSTEM_PROMPT } },
  };
}
