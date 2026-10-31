# PropReach AI

An AI sales executive for real estate builders. It phones prospective buyers, talks through the builder's whole portfolio, books real site visits, arranges human callbacks, and hands qualified leads to the sales team.

Built for the Bolna Symphony Buildathon. All projects and sample leads are fictional.

## What makes it different

The agent is not tied to the campaign project. If a buyer called about Whitefield asks about Sarjapur, it searches live portfolio data mid-call, compares the options against what the buyer said, and books the visit. Prices and availability come from tools rather than the prompt, so a project added in the dashboard is available on the next call.

## How it works

```
Dashboard ── launch ──> Bolna ── phone call ──> Buyer
    ^                     │
    │                     ├─ tools mid-call ──> search, details, slots, book, callback, update lead
    └── SQLite <── server ┴─ webhook after call ──> transcript, summary, final lead status
```

- `src/tools.js`: the six tools the agent calls. Booking is enforced by a database constraint, so one slot cannot go to two buyers.
- `src/calls.js`: dialling, consent checks, webhook handling and lead classification.
- `src/agent-config.js`: the agent prompt, voices and tool wiring.
- `public/index.html`: the builder dashboard.

Node 22.13+ with no npm dependencies.

## Try it without a phone

```bash
npm start            # dashboard at http://localhost:3000
npm run simulate     # in a second terminal, replays a full sales call
npm test
```

## Connect real calling

1. Create a key at [platform.bolna.ai](https://platform.bolna.ai) and add wallet credit.
2. `cp .env.example .env` (keep any `TOOL_TOKEN` already there), then set `BOLNA_API_KEY`.
3. Start the server with `npm start`, then expose it: `cloudflared tunnel --url http://localhost:3000`.
4. Set `PUBLIC_URL` in `.env` to the tunnel URL, and set `DASHBOARD_PASSWORD`, since the tunnel is public.
5. `npm run setup-agent`, then restart `npm start`.
6. In the dashboard, add your own number as a lead and press **Call**.

If the tunnel URL changes, update `PUBLIC_URL` and rerun `npm run setup-agent`. If Bolna rejects the voice settings, set `VOICE_PROFILE=default` and rerun.

## Safeguards

- The agent says it is an AI in its first sentence.
- Leads are dialled only with recorded consent. Opt-outs on a call go straight to the do-not-call list.
- Calls are limited to 9 AM to 9 PM recipient time. Confirm this and sender registration against current TRAI rules before calling real prospects.
- Bookings are confirmed to a buyer only after the reservation succeeds.
- Sample leads use numbers that cannot exist and are refused by the dialler.

## Not built yet

Sign-up and multi-builder accounts, brochure ingestion, retry scheduling, and editing existing projects.
