// Builds the Bolna agent. Personalisation arrives per call through user_data.

export const WELCOME = 'Hi, this is Asha, an AI assistant from {{builder_name}}, on a recorded line. Am I speaking with {{customer_name}}?';

export const SYSTEM_PROMPT = `You are Asha, an AI sales assistant for {{builder_name}}, on a live outbound phone call with {{customer_name}}. Understand what they want, recommend the best fit from ALL our projects, and book a site visit if they are keen.

WHAT YOU KNOW
Enquiry note, raw and possibly messy, never read it out: {{enquiry}}
Campaign project: {{campaign_project}}. You still represent every project.
Portfolio: {{portfolio_brief}}
From earlier calls: {{known_so_far}}
Customer record id, pass as lead_id, never say it: {{lead_id}}

HOW YOU TALK
- At most two short sentences plus one question, then stop and listen.
- Never ask "this or that" questions. A "yes" to those tells you nothing.
- Sound like a helpful local consultant, not an advert. No lists.
- Never announce a lookup or booking. A short filler plays by itself.
- Say prices as tools give them, with "starting from".

OPENING
The greeting already asked if this is {{customer_name}}.
- Yes: say why you called in your own words from the enquiry note, or "your home enquiry" if it has no detail. Ask if now is okay for two minutes.
- Busy, or someone else answered: ask when to call, call schedule_callback, then end the call.
- Wrong number: apologise, call update_lead with do_not_call "true" and notes "wrong number", then end the call.
- A recording or voicemail: say goodbye at once.

FIND THE RIGHT HOME
- If the enquiry note or earlier calls give a location or BHK, call search_projects as soon as they agree to talk. Never ask for budget first. Pass "any" for unknowns, never ask just to fill a tool field.
- Give the best match, then add also_consider in one short clause unless they ruled it out.
- No match: say so honestly, then offer the first alternative and why it is close.
- Comparing, or "which is better": call get_project_details, link one or two differences to what they told you, and recommend one.
- Along the way learn BHK, budget, self use or investment, timeline, and whether they are actively looking. One at a time, each once. If they avoid budget, give the starting price and move on.

FACTS
Say only what tools or the portfolio give you. For anything else, such as distance, travel time, taxes, total cost, maintenance, approvals or returns, say the consultant will confirm. Never guess. Never create urgency.

IF YOU MAY HAVE MISHEARD
The transcript comes from a noisy phone line and is often wrong.
- If a reply makes no sense, say you did not catch that and ask again. Never repeat it or guess. After two misses, ask a simple yes or no question.
- Confirm a budget, date or time once before using it, for example "1.7 crore, right?". Always confirm a budget far above our prices.

SITE VISITS
- Offer only times check_slots returns: closest_open_time first, then other_days. Visits are daytime only, so offer the weekend to anyone free only in the evening.
- Say confirmed only if book_visit returns confirmed true. Otherwise offer what it returns.

SITUATIONS
- Robot or real person: "Yes, I'm an AI assistant." Offer a human callback, then carry on.
- Wants a person, discount, lower price, loans or payment details: never agree to a number. You may state the basic payment plan, then offer a consultant callback.
- Brochure, WhatsApp, photos or floor plans: you cannot send anything yourself. Say the consultant will send it to this number, and add it to notes in update_lead.
- Cancelling or moving a visit to another project: offer a consultant callback.
- Annoyed: apologise once, stop selling, offer a human callback or no more calls.
- One-word replies: stop asking open questions and suggest one concrete next step.
- "Don't call me again" or similar: call update_lead right away with do_not_call "true", confirm they will not be called, and end the call.
- Not interested: thank them and end the call. Never push after a clear no.

ENDING THE CALL
Before every goodbye, call update_lead with everything learned. After it returns, restate any booking in one sentence, thank them, and say goodbye.`;

const HINDI_SUFFIX = '\n\nहिंदी में बात करते समय: आसान बोलचाल की हिंदी देवनागरी में बोलें, स्त्रीलिंग क्रियाएँ इस्तेमाल करें, और प्रोजेक्ट के नाम, BHK, lakh और crore Latin script में रखें। टूल में location और budget हमेशा English में भेजें।';

const str = (description) => ({ type: 'string', description });
const leadId = str('The customer record id from your instructions.');

const TOOLS = [
  { name: 'search_projects', pre_call_message: { en: 'Okay.', hi: 'ठीक है।' },
    description: "Search ALL the builder's projects. Call as soon as the customer agrees to talk if a location or BHK is known; whenever location, BHK or budget changes; and when they ask what else is available, or for cheaper, bigger or ready to move. Do not wait for a budget. also_consider in the result is the best cross-project suggestion.",
    params: { lead_id: leadId, location: str('Area in English letters, for example Sarjapur, or "any".'),
      bhk: str('Bedrooms as a digit, for example 3, or "any".'),
      budget: str('Top of their budget in digits and English, for example "1.5 crore" or "90 lakh". Convert spoken or Hindi amounts. "any" if unknown.') } },
  { name: 'get_project_details', pre_call_message: { en: 'Sure.', hi: 'जी।' },
    description: 'Get amenities, sizes, possession, payment plan, parking, RERA, nearby places and FAQs. Call before answering any question on these, and whenever the customer compares projects or asks which is better. For a comparison, pass every project.',
    params: { project_names: str('Project names separated by commas.') } },
  { name: 'check_slots', pre_call_message: { en: 'Let me see.', hi: 'देखती हूँ।' },
    description: 'Get real site visit times for one project on one date. Call before offering or accepting any time.',
    params: { project: str('Project name.'), date: str('YYYY-MM-DD, worked out from the current date. Visits start tomorrow.'),
      time: str('Requested time such as "10 AM" or "6 PM", or "any".') } },
  { name: 'book_visit', pre_call_message: { en: 'Booking it now.', hi: 'बुक कर रही हूँ।' },
    description: 'Reserve a site visit once the customer agrees to a project, a date and a time from check_slots. Booking the same project again moves that visit. It does not cancel a visit to a different project.',
    params: { lead_id: leadId, project: str('Project name.'), date: str('YYYY-MM-DD.'), time: str('Time such as "11:30 AM".') } },
  { name: 'schedule_callback', pre_call_message: { en: 'Noted.', hi: 'नोट कर लिया।' },
    description: 'Arrange a call from a human property consultant when the customer wants a person, asks about discounts, price, loans or payment details, or is busy now.',
    params: { lead_id: leadId, date: str('YYYY-MM-DD.'), time: str('Time such as "6 PM", or "morning", "afternoon" or "evening".'),
      topic: str('What they want to discuss.') } },
  { name: 'update_lead',
    description: 'Save what you learned and the lead status. Call before every goodbye, and immediately if the customer opts out. Safe to call more than once. Pass "unknown" for anything you did not learn.',
    params: { lead_id: leadId,
      status: str('hot = booked a visit, or clear intent and a realistic budget. warm = interested, still comparing. cold = not now, or nothing fits. callback_requested = wants a call at another time. not_interested = clear no to further contact.'),
      do_not_call: str('"true" only if they ask not to be called again or it is a wrong number, otherwise "false".'),
      location: str('Preferred area.'), bhk: str('Preferred BHK.'), budget: str('Budget in digits and English.'),
      purpose: str('"Self use" or "Investment".'), timeline: str('When they plan to buy.'),
      interested_project: str('Project they liked most.'),
      notes: str('Anything the team must do, for example "Send Whitefield Heights brochure on WhatsApp", or "none".') } },
];

// Every parameter stays required. How Bolna fills %(x)s for an omitted optional value is undocumented,
// so "any" and "unknown" carry the blanks, and the server treats them as missing.
export function buildApiTools(publicUrl, toolToken, { multilingual = true } = {}) {
  const tools = [], tools_params = {};
  for (const t of TOOLS) {
    const names = Object.keys(t.params);
    const message = t.pre_call_message && (multilingual ? t.pre_call_message : t.pre_call_message.en);
    tools.push({ name: t.name, description: t.description, key: 'custom_task', ...(message && { pre_call_message: message }),
      parameters: { type: 'object', properties: t.params, required: names } });
    tools_params[t.name] = { method: 'POST', url: `${publicUrl}/tools/${t.name}`, api_token: `Bearer ${toolToken}`,
      headers: { 'Content-Type': 'application/json' },
      param: Object.fromEntries(names.map((n) => [n, `%(${n})s`])) };
  }
  return { tools, tools_params };
}

/** Project and area names bias transcription towards them. Sarvam accepts up to 50 terms. */
export function keywordsFor(projects) {
  const title = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const places = projects.flatMap((p) => [p.name, p.location.split(',')[0], ...p.areas.map(title)]);
  return [...new Set([...places, 'BHK', 'crore', 'lakh', 'RERA', 'EMI'])].slice(0, 50).join(', ');
}

const STT_CONTEXT = 'Phone call between a Bengaluru property sales assistant and a home buyer. The buyer gives areas, bedroom counts such as 3 BHK, budgets such as 1.5 crore or 90 lakh, weekdays and visit times such as after 6 PM.';
const ASHA = { provider: 'sarvam', provider_config: { voice: 'Kavya', voice_id: 'kavya', model: 'bulbul:v3' } };

const voices = (keywords) => ({
  sarvam: {
    transcriber: { provider: 'sarvam', model: 'saaras:v4', language: 'en', stream: true, encoding: 'linear16', sampling_rate: 16000,
      endpointing: 250, keywords, context: STT_CONTEXT },
    synthesizer: { provider: 'sarvam', provider_config: { ...ASHA.provider_config, language: 'en' }, stream: true, buffer_size: 150, audio_format: 'wav' },
    // The English prompt comes from agent_prompts. Switching is automatic, so the prompt stays out of it.
    multilingual_config: {
      enabled: true, active_language: 'en', language_switch_trigger: 'requested_or_auto_detected',
      languages: {
        en: { synthesizer: ASHA },
        hi: { transcriber: { language: 'hi' }, synthesizer: ASHA, system_prompt: SYSTEM_PROMPT + HINDI_SUFFIX,
          handoff_message: 'ठीक है, मैं हिंदी में बात करती हूँ।', agent_name: 'आशा' },
      },
    },
  },
  default: {
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en', stream: true, encoding: 'linear16', sampling_rate: 16000, endpointing: 250 },
    synthesizer: { provider: 'elevenlabs', provider_config: { voice: 'Angelica', voice_id: 'IkSv4tkouLJ6kYsQA7XD', model: 'eleven_turbo_v2_5' }, stream: true, buffer_size: 150, audio_format: 'wav' },
  },
});

export function buildAgent({ publicUrl, toolToken, webhookToken, voiceProfile = 'sarvam', projects = [] }) {
  const all = voices(keywordsFor(projects));
  const voice = all[voiceProfile] ?? all.sarvam;
  return {
    agent_config: {
      agent_name: 'PropReach Sales Executive',
      agent_welcome_message: WELCOME,
      webhook_url: `${publicUrl}/webhooks/bolna?token=${webhookToken}`,
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
          api_tools: buildApiTools(publicUrl, toolToken, { multilingual: Boolean(voice.multilingual_config) }),
        },
        task_config: { call_terminate: 480, hangup_after_silence: 15, hangup_after_LLMCall: true, interruptible_hangup_message: true,
          call_cancellation_prompt: "The call is complete only if the assistant's last message said goodbye, or the assistant has just confirmed the customer will not be called again. If the assistant's last message asked a question, or the customer said they want to stop and the assistant has not replied yet, the call is not complete.",
          incremental_delay: 600, noise_cancellation_level: 85, voicemail: true, backchanneling: false },
      }],
    },
    agent_prompts: { task_1: { system_prompt: SYSTEM_PROMPT } },
  };
}

// Post-call extractions. They catch what the live agent missed, above all an opt-out.
export const DISPOSITIONS = [
  { name: 'Do Not Call', category: 'Lead Outcome', is_objective: true, is_subjective: false,
    question: 'Did the customer ask not to be called again, or say this is a wrong number?',
    objective_options: [
      { value: 'Yes', condition: 'Customer asked to stop calling, to be removed, or said it is the wrong number' },
      { value: 'No', condition: 'Customer made no such request' },
    ] },
  { name: 'Lead Status', category: 'Lead Outcome', is_objective: true, is_subjective: false,
    question: 'How should this lead be classified?',
    objective_options: [
      { value: 'hot', condition: 'Booked a visit, or clear intent and a realistic budget' },
      { value: 'warm', condition: 'Interested, still comparing' },
      { value: 'cold', condition: 'Not now, or nothing fits' },
      { value: 'callback_requested', condition: 'Wants a call at another time' },
      { value: 'not_interested', condition: 'Clear no to further contact' },
    ] },
];
