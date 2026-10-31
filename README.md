# PropReach AI

An AI sales executive for real estate builders. It phones prospective buyers, talks through the builder's whole portfolio, books real site visits, arranges human callbacks, and hands qualified leads to the sales team.

Built for the Bolna Symphony Buildathon. All projects and sample leads are fictional.

## What makes it different

The agent is not tied to the campaign project. Every search covers the full portfolio and returns the best cross-project suggestion with a computed reason, such as "Sarjapur Residences, 15 lakh less and 140 square feet larger". A buyer called about Whitefield can ask about Sarjapur, compare the two, and book a visit in one call.

Live prices and availability come from tools, so a project added in the dashboard is available on the next call.

## How it works

```
Dashboard ── launch ──> Bolna ── phone call ──> Buyer
    ^                     │
    │                     ├─ tools mid-call ──> search, details, slots, book, callback, update lead
    └── SQLite <── server ┴─ webhook after call ──> transcript, summary, extraction, final lead status
```

| Path | Purpose |
|---|---|
| `src/tools.js` | The six tools the agent calls. A database constraint stops one slot going to two buyers. |
| `src/calls.js` | Dialling guards, webhook handling and lead classification. |
| `src/agent-config.js` | Agent prompt, voices, tool wiring and post-call extractions. |
| `src/parse.js` | Turns spoken input into data: "1 crore 35 lakh", "after 6", "डेढ़ करोड़". |
| `public/index.html` | The builder dashboard. |

Node 22.13+ with no npm dependencies.

## Try it without a phone

```bash
npm start            # dashboard at http://localhost:3000
npm run simulate     # in a second terminal, replays a full sales call
npm test
```

Watch the dashboard during the simulation: a banner shows the live call, a booking alert appears, and the result lands in Call history and Appointments. The transcript is scripted and labelled as simulated. Rerunning it moves Rahul's visit to the next open slot.

**Call** and **Launch campaign** stay disabled until Bolna is connected, and sample leads can never be dialled. Stop the server and run `npm run reset` to restore the sample data.

## Connect real calling

1. Create a key at [platform.bolna.ai](https://platform.bolna.ai) and add wallet credit.
2. Add `BOLNA_API_KEY` and a `DASHBOARD_PASSWORD` of at least 12 characters to `.env`. See `.env.example` for every option. `npm start` already created this file, so add to it rather than copying over it.
3. Start the server with `npm start`, then expose it: `cloudflared tunnel --url http://localhost:3000`.
4. Set `PUBLIC_URL` in `.env` to the tunnel URL.
5. Run `npm run setup-agent`, then restart `npm start`.
6. In the dashboard, add your own number as a lead and press **Call**.

If the tunnel URL changes, update `PUBLIC_URL` and rerun `npm run setup-agent`. If Bolna rejects the voice settings, set `VOICE_PROFILE=default` and rerun.

## Safeguards

- The agent says it is an AI on a recorded line in its first sentence.
- Leads are dialled only with recorded consent, and the server rechecks each lead at the moment of dialling.
- An opt-out goes straight to the do-not-call list and cancels that buyer's appointments. A post-call extraction catches any opt-out the live agent missed.
- Campaigns skip anyone called in the last 24 hours or holding a booking. Launching needs confirming, and a running campaign can be stopped: queued calls are cancelled, while calls already ringing or connected finish.
- People have the final say: the team can correct any lead status or do-not-call decision the AI made.
- A booking is confirmed to a buyer only after the reservation succeeds.
- Sample leads use numbers that cannot exist, and the dialler refuses them.
- Calling hours are set to 9 AM to 9 PM recipient time through Bolna's calling guardrails, which the server relies on rather than enforcing itself. Confirm this and sender registration against current TRAI rules before calling real prospects.

## Security

- Your Bolna key stays on the server. Only the server calls Bolna, and no page or API response contains the key.
- The dashboard password crosses the network once, at sign-in. After that the browser holds a random session id in an `HttpOnly`, `SameSite=Strict` cookie, which expires after 12 hours.
- The server will not start with a public URL and a password under 12 characters. Five wrong passwords lock that visitor out for 15 minutes.
- Bolna serves recordings to anyone holding the URL, so the URL never reaches the browser. Audio streams through a signed-in route.
- Cross-site requests are refused, and only this machine and `PUBLIC_URL` may reach the dashboard. A strict Content Security Policy blocks injected scripts.
- The agent's tools and the webhook use separate secret tokens, so a leaked webhook URL cannot call the tools.
- By default the server listens only on this machine. Set `HOST=0.0.0.0` when hosting.

Secrets live in `.env`, which git ignores. If a key is ever exposed, replace it in `.env` and restart.

## Known limits

- Hindi uses Bolna's automatic language switching. It is configured but not yet proven on a live call.
- Not built yet: sign-up and multi-builder accounts, brochure ingestion, retry scheduling, and editing existing projects.
