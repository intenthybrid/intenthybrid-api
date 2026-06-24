// Live market data from Binance USD-M Futures, proxied through the backend so
// the browser never hits Binance directly (avoids CORS and lets you move this
// to a server in an allowed region if your location is geo-blocked). No API key
// is required - these are all public endpoints.
//
// Two bulk calls cover price / 24h change / volume / funding for EVERY pair.
// A focused subset (MARKET_SYMBOLS) additionally gets positioning, order flow
// and open interest so we can compute the real Resonance / Crowding /
// Order-flow / Agent-activity indices. Liquidation clusters come from the live
// WebSocket feed when available (see liquidations.ts), otherwise estimated.
//
// .env knobs (all optional):
//   BINANCE_FAPI_BASE   default https://fapi.binance.com  (swap to a mirror/proxy if blocked)
//   MARKET_SYMBOLS      comma list for the heavy per-symbol metrics
//   MARKET_CACHE_MS     default 20000
//   ALCHEMY_TIMEOUT_MS  (shared) per-call timeout, default 6000

import { liqActive, getLiq, getMarketLiq } from './liquidations'

export const BASE = (process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com').replace(/\/+$/, '')
const CACHE_MS = Number(process.env.MARKET_CACHE_MS || 20000)
const CALL_TIMEOUT_MS = Number(process.env.ALCHEMY_TIMEOUT_MS || 6000)
// Rolling positioning poller knobs (all optional via .env):
const POS_POLL_GAP_MS = Number(process.env.POS_POLL_GAP_MS || 500)     // pacing between per-symbol positioning fetches (~500ms -> full board in ~5min)
const POS_MAX_AGE_MS = Number(process.env.POS_MAX_AGE_MS || 1200000)   // drop positioning older than this (20 min) and fall back to the estimate
let rateLimitedUntil = 0 // set when Binance returns 429/418; the poller backs off until then

const DEFAULT_SUBSET = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TRXUSDT', 'SUIUSDT', 'ARBUSDT',
  'OPUSDT', 'WIFUSDT', '1000PEPEUSDT', 'FETUSDT'
]
function subset(): string[] {
  const env = (process.env.MARKET_SYMBOLS || '').trim()
  if (!env) return DEFAULT_SUBSET
  return env.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
}

function num(x: any): number {
  const n = parseFloat(x)
  return isFinite(n) ? n : NaN
}
function clampV(x: number): number {
  return Math.max(5, Math.min(96, Math.round(x)))
}
function c01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!r.ok) {
      if (r.status === 429 || r.status === 418) rateLimitedUntil = Date.now() + 60000
      throw new Error('HTTP ' + r.status)
    }
    return await r.json()
  } finally {
    clearTimeout(to)
  }
}

// Per-symbol positioning / flow / OI (best-effort: any missing piece -> null).
export async function symbolStats(sym: string): Promise<any> {
  const q = '?symbol=' + encodeURIComponent(sym) + '&period=5m'
  const [lsR, topR, tkR, oiR] = await Promise.allSettled([
    fetchJson(BASE + '/futures/data/globalLongShortAccountRatio' + q + '&limit=2'),
    fetchJson(BASE + '/futures/data/topLongShortPositionRatio' + q + '&limit=1'),
    fetchJson(BASE + '/futures/data/takerlongshortRatio' + q + '&limit=1'),
    fetchJson(BASE + '/futures/data/openInterestHist' + q + '&limit=7'),
  ])
  const last = (s: any) => (s.status === 'fulfilled' && Array.isArray(s.value) && s.value.length ? s.value[s.value.length - 1] : null)
  const first = (s: any) => (s.status === 'fulfilled' && Array.isArray(s.value) && s.value.length ? s.value[0] : null)
  const ls = last(lsR)
  const top = last(topR)
  const tk = last(tkR)
  const oiLast = last(oiR)
  const oiFirst = first(oiR)

  const longAccount = ls ? c01(num(ls.longAccount)) : NaN
  const taker = tk ? num(tk.buyVol) / (num(tk.buyVol) + num(tk.sellVol)) : NaN
  const topPos = top ? num(top.longShortRatio) : NaN
  let oiUsd = oiLast ? num(oiLast.sumOpenInterestValue) : NaN
  let oiChange = 0
  if (oiFirst && oiLast) {
    const a = num(oiFirst.sumOpenInterest)
    const b = num(oiLast.sumOpenInterest)
    if (isFinite(a) && a > 0 && isFinite(b)) oiChange = (b - a) / a
  }
  return { longAccount, taker, topPos, oiUsd: isFinite(oiUsd) ? oiUsd : NaN, oiChange }
}

// Combine a ticker + funding + (optional) positioning into the dApp's pair shape.
export function buildPair(sym: string, t: any, pi: any, ss: any | null): any {
  const px = num(t.lastPrice)
  const ch = num(t.priceChangePercent)
  const hi = num(t.highPrice)
  const lo = num(t.lowPrice)
  const vol = num(t.quoteVolume)
  const fundingPct = pi ? num(pi.lastFundingRate) * 100 : NaN

  const longAccount = ss ? ss.longAccount : NaN
  const taker = ss ? ss.taker : NaN
  const topPos = ss ? ss.topPos : NaN
  const oiUsd = ss ? ss.oiUsd : NaN
  const oiChange = ss ? ss.oiChange : 0
  const hasPos = isFinite(longAccount)
  const hasFlow = isFinite(taker)

  const skew = hasPos ? Math.abs(longAccount - 0.5) : 0
  const fAbs = isFinite(fundingPct) ? Math.abs(fundingPct) : 0

  const crowd = clampV(
    (hasPos ? skew * 220 : 28) +
      c01(fAbs / 0.05) * 14 +
      (hasFlow ? c01(Math.abs(taker - 0.5) / 0.25) * 12 : 0) +
      c01(Math.abs(oiChange) / 0.06) * 8
  )
  const conc = clampV((hasPos ? skew * 240 : 24) + (isFinite(topPos) ? c01(Math.abs(topPos - 1) / 1.0) * 22 : 0))

  const dir = hasPos ? (longAccount - 0.5 >= 0 ? 1 : -1) : (fundingPct >= 0 ? 1 : -1)
  let ag = 0
  let agN = 0
  if (isFinite(fundingPct)) { agN++; if (Math.sign(fundingPct) === dir) ag++ }
  if (hasFlow) { agN++; if ((taker - 0.5) * dir > 0) ag++ }
  if (isFinite(topPos)) { agN++; if ((topPos - 1) * dir > 0) ag++ }
  if (oiChange !== 0) { agN++; if (oiChange * dir > 0) ag++ }
  const align = clampV(35 + (agN ? ag / agN : 0.5) * 45 + skew * 40)
  const exits = clampV(crowd * 0.7 + c01(Math.max(0, -oiChange) / 0.05) * 30 + c01(fAbs / 0.06) * 10)

  const turnover = isFinite(vol) && isFinite(oiUsd) && oiUsd > 0 ? c01(vol / oiUsd / 40) : 0
  const agents = Math.round(120 + turnover * 1800 + c01(Math.abs(oiChange) / 0.05) * 900)

  // liquidation clusters: REAL liquidations from the live WS feed only.
  // No synthetic/estimated bands - if the feed has no data we send nothing.
  let liq: Array<{ side: string; price: number; size: number }> = []
  let liqSource = 'none'
  let oneHourLiqUsd: number | null = null
  const live = liqActive() ? getLiq(sym) : null
  if (live && live.recent.length) {
    liq = live.recent.slice().sort((a, b) => b.price - a.price)
    liqSource = 'live'
    oneHourLiqUsd = live.usd1h
  }

  return {
    px: isFinite(px) ? px : null,
    ch: isFinite(ch) ? ch : null,
    hi: isFinite(hi) ? hi : null,
    lo: isFinite(lo) ? lo : null,
    vol: isFinite(vol) ? vol : null,
    fund: isFinite(fundingPct) ? +fundingPct.toFixed(4) : null,
    oi: isFinite(oiUsd) ? oiUsd : null,
    longPct: hasPos ? Math.round(longAccount * 100) : null,
    crowd,
    buyPct: hasFlow ? Math.round(taker * 100) : null,
    align,
    exits,
    conc,
    agents,
    liq,
    liqSource,
    oneHourLiqUsd,
    full: hasPos || hasFlow,
  }
}

// ---- Bulk layer: price/change/volume/funding for EVERY pair. Fast (2 calls). ----
async function buildBulk(): Promise<{ tickers: Record<string, any>; tickMap: Map<string, any>; premMap: Map<string, any> }> {
  const [tickArr, premArr] = await Promise.all([
    fetchJson(BASE + '/fapi/v1/ticker/24hr'),
    fetchJson(BASE + '/fapi/v1/premiumIndex'),
  ])
  if (!Array.isArray(tickArr)) throw new Error('bad ticker response')
  const tickMap = new Map<string, any>()
  for (const t of tickArr) if (t && t.symbol) tickMap.set(t.symbol, t)
  const premMap = new Map<string, any>()
  if (Array.isArray(premArr)) for (const p of premArr) if (p && p.symbol) premMap.set(p.symbol, p)

  // Light ticker map for every USDT pair (price/change/volume/funding).
  const tickers: Record<string, any> = {}
  for (const [sym, t] of tickMap) {
    if (!sym.endsWith('USDT')) continue
    const pi = premMap.get(sym)
    const px = num(t.lastPrice)
    const ch = num(t.priceChangePercent)
    const vol = num(t.quoteVolume)
    const fund = pi ? num(pi.lastFundingRate) * 100 : NaN
    // Crowding + breakdown DERIVED FROM REAL bulk data (funding rate, 24h move,
    // quote volume) for EVERY pair - no simulation. The focused subset overrides
    // these with richer positioning-based values in the background pairs layer.
    const fAbs = isFinite(fund) ? Math.abs(fund) : 0
    const chAbs = isFinite(ch) ? Math.abs(ch) : 0
    const crowd = clampV(26 + c01(fAbs / 0.05) * 34 + c01(chAbs / 10) * 22)
    const align = clampV(crowd * 0.7 + c01(fAbs / 0.04) * 18)
    const exits = clampV(crowd * 0.6 + c01(chAbs / 8) * 22)
    const conc = clampV(crowd * 0.55 + c01(fAbs / 0.05) * 20)
    const agents = Math.round(60 + c01((isFinite(vol) ? vol : 0) / 3e9) * 900 + crowd * 4)
    const buyPct = isFinite(ch) ? Math.max(22, Math.min(78, Math.round(50 + ch * 1.5))) : 50
    const longPct = isFinite(fund) ? Math.max(25, Math.min(75, Math.round(50 + fund * 400))) : 50
    tickers[sym] = {
      px: isFinite(px) ? px : null,
      ch: isFinite(ch) ? ch : null,
      hi: isFinite(num(t.highPrice)) ? num(t.highPrice) : null,
      lo: isFinite(num(t.lowPrice)) ? num(t.lowPrice) : null,
      vol: isFinite(vol) ? vol : null,
      fund: isFinite(fund) ? +fund.toFixed(4) : null,
      crowd, align, exits, conc, agents, buyPct, longPct,
    }
  }
  return { tickers, tickMap, premMap }
}

// ---- Heavy layer is now a rolling background poller (see below getMarket). ----

// The bulk layer (price/change/volume/funding for EVERY pair) gates the HTTP
// response. A background round-robin poller fetches REAL positioning / order-flow
// / OI for ONE symbol at a time, cycling through every USDT perp, so over one
// cycle (~5 min) the whole board has real data. The /futures/data endpoints are
// weight 0 with a 1000-req/5min/IP cap, and one cycle is ~645 calls/endpoint, so
// this stays comfortably under the limit on a single IP.
let bulk: { ts: number; tickers: Record<string, any>; tickMap: Map<string, any> | null; premMap: Map<string, any> | null } = { ts: 0, tickers: {}, tickMap: null, premMap: null }
let bulkInflight: Promise<any> | null = null

// Rolling positioning cache: latest REAL positioning per symbol (never fabricated).
const posCache = new Map<string, { ss: any; ts: number }>()
let symList: string[] = []
let cursor = 0
let pollStarted = false
let pollTimer: any = null

// Rotation order: priority subset (env MARKET_SYMBOLS or defaults) first so the
// most-watched pairs get real data within seconds, then every other USDT perp.
function buildSymList(tm: Map<string, any>): string[] {
  const all = Array.from(tm.keys()).filter((sym) => sym.endsWith('USDT'))
  const pri = subset().filter((sym) => tm.has(sym))
  const priSet = new Set(pri)
  return pri.concat(all.filter((sym) => !priSet.has(sym)))
}

function schedulePoll(ms: number): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(runPollStep, ms)
}

// One step: fetch positioning for the next symbol, store if real, then schedule next.
async function runPollStep(): Promise<void> {
  try {
    if (Date.now() < rateLimitedUntil) { schedulePoll(Math.max(2000, rateLimitedUntil - Date.now())); return }
    const tm = bulk.tickMap
    if (!tm) { schedulePoll(1500); return }
    if (cursor >= symList.length) {
      symList = buildSymList(tm)
      cursor = 0
      if (!symList.length) { schedulePoll(3000); return }
    }
    const sym = symList[cursor++]
    if (sym && tm.has(sym)) {
      try {
        const ss = await symbolStats(sym)
        // Store only when Binance actually returned positioning. Symbols with no
        // long/short or taker data are left to the bulk estimate (never faked).
        if (ss && (isFinite(ss.longAccount) || isFinite(ss.taker))) posCache.set(sym, { ss, ts: Date.now() })
      } catch (e) { /* single-symbol error: skip, keep rotating */ }
    }
  } catch (e) { /* never let the loop die */ }
  schedulePoll(POS_POLL_GAP_MS)
}

function startPoller(): void {
  if (pollStarted) return
  pollStarted = true
  schedulePoll(0)
}

// Build the dApp pair objects fresh each call from the rolling positioning cache.
// Only pairs with fresh, real positioning are included; the rest fall through to
// the bulk ticker estimate on the client.
function assemblePairs(): Record<string, any> {
  const out: Record<string, any> = {}
  const tm = bulk.tickMap
  if (!tm) return out
  const now = Date.now()
  for (const [sym, ent] of posCache) {
    if (now - ent.ts > POS_MAX_AGE_MS) continue
    const t = tm.get(sym)
    if (!t) continue
    out[sym] = buildPair(sym, t, bulk.premMap ? bulk.premMap.get(sym) : null, ent.ss)
  }
  return out
}

export async function getMarket(): Promise<any> {
  const now = Date.now()

  // 1. Refresh the bulk layer if stale. The response waits ONLY for this.
  if (!bulk.tickMap || now - bulk.ts > CACHE_MS) {
    if (!bulkInflight) {
      bulkInflight = buildBulk()
        .then((b) => {
          bulk = { ts: Date.now(), tickers: b.tickers, tickMap: b.tickMap, premMap: b.premMap }
          bulkInflight = null
          return b
        })
        .catch((e) => {
          bulkInflight = null
          throw e
        })
    }
    try {
      await bulkInflight
    } catch (e: any) {
      if (!bulk.tickMap) {
        return { available: false, reason: e?.message || 'binance_unreachable', source: 'binance-futures' }
      }
    }
  }

  // 2. Kick off the rolling positioning poller once bulk data exists (runs forever).
  if (bulk.tickMap) startPoller()

  // 3. Return immediately: all tickers, plus every pair that has real positioning so far.
  return {
    available: true,
    source: 'binance-futures',
    liveLiquidations: liqActive(),
    marketLiq: getMarketLiq(),
    ts: Date.now(),
    pairs: assemblePairs(),
    tickers: bulk.tickers,
    posCount: posCache.size,
  }
}
