# Intent Hybrid :: API (backend)

The backend for the Intent Hybrid dApp. It does two jobs:

1. Detection tier :: GET /api/resonance computes a resonance index (0 to 100) from
   recent market moves. This is a heuristic, not an LLM. It is a transparent proxy
   you can later swap for your own model.
2. Decision tier :: POST /api/analyze verifies the caller's Privy access token, then
   asks Claude to explain the current signals in plain language.

The Privy App Secret and the Anthropic API key live ONLY here, never in the frontend.

## What you need

- Node.js 18 or newer (uses the built in fetch).
- Your NEW Privy App Secret (the one you just regenerated).
- An Anthropic API key from console.anthropic.com with a little credit.

## Setup

```
npm install
cp .env.example .env
```

Open .env and fill in:

- PRIVY_APP_SECRET :: the new secret you regenerated. Keep it private.
- ANTHROPIC_API_KEY :: your Claude API key.

PRIVY_APP_ID is already set and is public. ANTHROPIC_MODEL defaults to a balanced model.

## Run locally

```
npm run dev
```

You should see: intenthybrid-api listening on http://localhost:8787

Test it (no login needed for these two):

```
curl http://localhost:8787/api/health
curl http://localhost:8787/api/resonance
```

The resonance endpoint pulls live data from a public market API. If you are offline,
it returns a simulated index instead, so it always responds.

The /api/analyze endpoint requires a Privy access token, so it is meant to be called
from the logged in frontend (the AI panel does this for you). It will return 401 if
called without a valid token.

## Connect the frontend

In the frontend project, set VITE_API_URL to this server. For local dev that is the
default already:

```
VITE_API_URL=http://localhost:8787
```

Run both at once: the API with npm run dev here, and the frontend with npm run dev in
its folder. Log in, then use the AI analyst panel. It sends your Privy token to
/api/analyze, the server verifies it, calls Claude, and returns the answer.

## Deploy (Railway or Render)

1. Push this folder to a Git repo (or deploy directly).
2. Build command: npm install && npm run build
3. Start command: npm start
4. Set environment variables in the host dashboard: PRIVY_APP_ID, PRIVY_APP_SECRET,
   ANTHROPIC_API_KEY, and ALLOWED_ORIGIN set to your Netlify URL.
5. After deploy, set VITE_API_URL in the frontend (Netlify env) to the deployed API URL.

## Security notes

- Never put PRIVY_APP_SECRET or ANTHROPIC_API_KEY in the frontend or commit them.
- .env is gitignored. Only .env.example (with placeholders) is committed.
- ALLOWED_ORIGIN restricts which sites may call this API from a browser.

## Endpoints

- GET  /api/health     :: liveness check.
- GET  /api/resonance  :: resonance index and per market changes.
- POST /api/analyze    :: body { "prompt": "..." }, requires Bearer Privy token,
                          returns { text, context, userId }.
