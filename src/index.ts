import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { requireAuth } from './privy'
import { analyze, complete } from './claude'
import { computeResonance } from './resonance'
import { getXProfile } from './xprofile'
import { getHoldings } from './holdings'
import { getMarket } from './market'
import { getLiqRich } from './liquidations'
import { cazEnabled, cazLiquidations } from './coinalyze'
import { getFVG } from './fvg'
import { getSymbolReal } from './symbolreal'

const app = express()
app.use(express.json())

// For the prototype we allow any origin so the single file dApp works however it
// is opened (file://, localhost, etc.). For production, restrict this to your
// own domain(s), for example: cors({ origin: process.env.ALLOWED_ORIGIN }).
app.use(cors())

// Health check (no auth) so you can confirm the server is running.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'intenthybrid-api' })
})

// Detection tier: resonance index from market data. No login required (read only).
app.get('/api/resonance', async (_req, res) => {
  try {
    res.json(await computeResonance())
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'resonance failed' })
  }
})

// Live market data (Binance USD-M Futures, proxied). No login required: this is
// public market data and carries no API cost. Returns { available:false, ... }
// if Binance cannot be reached from the server, so the dApp can fall back to its
// built-in simulated market without breaking.
app.get('/api/market', async (_req, res) => {
  try {
    res.json(await getMarket())
  } catch (e: any) {
    res.status(500).json({ available: false, reason: e?.message || 'market failed' })
  }
})

// Per-token liquidations: real amount per price level, current + previous hour
// totals, and an hourly history. Prefers Coinalyze when its API key is set;
// otherwise falls back to the websocket aggregation.
app.get('/api/liquidations', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase()
    if (cazEnabled()) {
      const cz = await cazLiquidations(symbol).catch(() => null)
      if (cz) return res.json(cz)
    }
    return res.json(getLiqRich(symbol))
  } catch (e: any) {
    res.status(500).json({ available: false, reason: e?.message || 'liquidations failed' })
  }
})

// FVG Radar: detects real Fair Value Gaps on OHLC candles for a symbol, with
// strength, post-sweep flag, trend bias and premium/discount zones. Open (no auth).
app.get('/api/fvg', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase()
    const interval = String(req.query.interval || '1h')
    res.json(await getFVG(symbol, interval))
  } catch (e: any) {
    res.status(500).json({ available: false, reason: e?.message || 'fvg failed' })
  }
})

// Real per-symbol metrics (Resonance / Crowding / Order-flow / Agent-activity)
// for the market-detail view. Binance first, Coinalyze fallback. Open (no auth).
app.get('/api/symbol', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase()
    res.json(await getSymbolReal(symbol))
  } catch (e: any) {
    res.status(500).json({ available: false, reason: e?.message || 'symbol failed' })
  }
})

// Decision tier: the LLM explanation. Requires a valid Privy access token.
app.post('/api/analyze', requireAuth, async (req, res) => {
  try {
    const prompt = (req.body?.prompt || '').toString().slice(0, 2000)
    // Feed the latest resonance signals to the model as context.
    let context: any = null
    try {
      context = await computeResonance()
    } catch {
      context = null
    }
    const text = await analyze(
      prompt || 'Give a short resonance summary for the market.',
      context
    )
    res.json({ text, context, userId: (req as any).privyUserId })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'analyze failed' })
  }
})

// Raw Claude proxy used by the dApp. Requires a valid Privy access token so only
// logged in users can spend AI credits. The prompt already contains its own
// instructions, so we forward it as is and keep the API key on the server.
app.post('/api/claude', requireAuth, async (req, res) => {
  try {
    const prompt = (req.body?.prompt || '').toString().slice(0, 6000)
    if (!prompt) {
      res.status(400).json({ error: 'missing prompt' })
      return
    }
    const text = await complete(prompt)
    res.json({ text })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'claude failed' })
  }
})

// X (Twitter) public profile for the logged in user's handle (followers etc).
// Auth-gated so only logged in users can spend the X API credit. Degrades to
// { available: false } when X_BEARER_TOKEN is not configured.
app.get('/api/x-profile', requireAuth, async (req, res) => {
  try {
    const username = (req.query.username || '').toString()
    res.json(await getXProfile(username))
  } catch (e: any) {
    res.status(500).json({ available: false, reason: e?.message || 'x profile failed' })
  }
})

// On-chain wallet holdings (native + ERC-20) via Alchemy. Auth-gated.
app.get('/api/holdings', requireAuth, async (req, res) => {
  try {
    const address = (req.query.address || '').toString()
    res.json(await getHoldings(address))
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'holdings failed' })
  }
})

const port = Number(process.env.PORT || 8787)
app.listen(port, () => {
  console.log('intenthybrid-api listening on http://localhost:' + port)
})
