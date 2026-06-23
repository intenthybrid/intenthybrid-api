// FVG Radar - Fair Value Gap detector built on REAL OHLC candles.
//
// Implements the Smart-Money / ICT concepts: a Fair Value Gap is a 3-candle
// imbalance where price moved so fast it left an untraded gap. We detect them,
// classify strong vs weak (displacement body + gap size vs ATR + structure
// break), flag the premium "post-liquidity-sweep" ones, compute a trend bias,
// and mark each gap's premium/discount location.
//
// Candles come from Binance USD-M futures klines (no key); if that host is
// unreachable, we fall back to Coinalyze OHLCV (same free key as liquidations),
// so the radar still works from regions where Binance is blocked.

const FAPI_BASE = process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com'
const CAZ_BASE = process.env.COINALYZE_API_BASE || 'https://api.coinalyze.net/v1'
const CAZ_KEY = process.env.COINALYZE_API_KEY || ''
const CAZ_EXCH = process.env.COINALYZE_EXCHANGE_CODE || 'A'
const TTL = Number(process.env.FVG_CACHE_MS) || 30_000

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }

function num(x: any): number {
  const n = typeof x === 'string' ? parseFloat(x) : x
  return typeof n === 'number' && isFinite(n) ? n : NaN
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), ms)
  try {
    return await p
  } finally {
    clearTimeout(to)
  }
}

// --- candle sources -------------------------------------------------------
async function binanceKlines(symbol: string, interval: string, limit: number): Promise<Candle[] | null> {
  const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 9000)
  try {
    const r = await fetch(url, { signal: ctrl.signal as any })
    if (!r.ok) return null
    const arr: any = await r.json().catch(() => null)
    if (!Array.isArray(arr) || !arr.length) return null
    return arr
      .map((k: any) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) }))
      .filter((c: Candle) => isFinite(c.h) && isFinite(c.l) && c.h > 0)
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

const CAZ_INT: Record<string, string> = { '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1hour', '4h': '4hour', '12h': '12hour', '1d': 'daily' }
const SEC_PER: Record<string, number> = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '12h': 43200, '1d': 86400 }

async function coinalyzeKlines(symbol: string, interval: string, limit: number): Promise<Candle[] | null> {
  if (!CAZ_KEY) return null
  const cazInt = CAZ_INT[interval] || '1hour'
  const per = SEC_PER[interval] || 3600
  const toSec = Math.floor(Date.now() / 1000)
  const fromSec = toSec - per * (limit + 3)
  const sym = symbol.toUpperCase() + '_PERP.' + CAZ_EXCH
  const url = `${CAZ_BASE}/ohlcv-history?symbols=${encodeURIComponent(sym)}&interval=${cazInt}&from=${fromSec}&to=${toSec}`
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 9000)
  try {
    const r = await fetch(url, { headers: { api_key: CAZ_KEY, Accept: 'application/json' }, signal: ctrl.signal as any })
    if (!r.ok) return null
    const j: any = await r.json().catch(() => null)
    if (!Array.isArray(j) || !j.length) return null
    const hist = (j[0] && j[0].history) || []
    return hist
      .map((h: any) => ({ t: (num(h.t) || 0) * 1000, o: num(h.o), h: num(h.h), l: num(h.l), c: num(h.c), v: num(h.v) || 0 }))
      .filter((c: Candle) => isFinite(c.h) && isFinite(c.l) && c.h > 0)
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

async function getKlines(symbol: string, interval: string, limit: number): Promise<{ candles: Candle[] | null; source: string | null }> {
  let candles = await binanceKlines(symbol, interval, limit).catch(() => null)
  if (candles && candles.length >= 12) return { candles, source: 'binance-futures' }
  candles = await coinalyzeKlines(symbol, interval, limit).catch(() => null)
  if (candles && candles.length >= 12) return { candles, source: 'coinalyze' }
  return { candles: null, source: null }
}

// --- indicators -----------------------------------------------------------
function sma(vals: number[], period: number, endIdx: number): number | null {
  if (endIdx + 1 < period) return null
  let s = 0
  for (let k = endIdx - period + 1; k <= endIdx; k++) s += vals[k]
  return s / period
}
function atr(c: Candle[], period: number): number {
  const n = c.length
  if (n < 2) return 0
  let s = 0
  let cnt = 0
  for (let i = Math.max(1, n - period); i < n; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c))
    s += tr
    cnt++
  }
  return cnt ? s / cnt : 0
}

// Did price sweep beyond the prior swing (took liquidity) just before this gap?
function sweepBefore(c: Candle[], i: number, type: 'bull' | 'bear'): boolean {
  const win = 4
  const lookback = 12
  if (i - win < 1) return false
  const start = Math.max(0, i - win - lookback)
  let minPrior = Infinity
  let maxPrior = -Infinity
  for (let k = start; k < i - win; k++) {
    if (c[k].l < minPrior) minPrior = c[k].l
    if (c[k].h > maxPrior) maxPrior = c[k].h
  }
  if (!isFinite(minPrior) || !isFinite(maxPrior)) return false
  for (let k = i - win; k <= i; k++) {
    if (type === 'bull' && c[k].l < minPrior) return true
    if (type === 'bear' && c[k].h > maxPrior) return true
  }
  return false
}

function trendBias(c: Candle[]): 'bullish' | 'bearish' | 'neutral' {
  const n = c.length
  const closes = c.map((x) => x.c)
  const last = closes[n - 1]
  const s20 = sma(closes, 20, n - 1)
  const s50 = sma(closes, 50, n - 1)
  if (s20 == null || s50 == null) return 'neutral'
  if (last > s20 && s20 > s50) return 'bullish'
  if (last < s20 && s20 < s50) return 'bearish'
  return 'neutral'
}

export type FVG = {
  type: 'bull' | 'bear'
  top: number
  bottom: number
  mid: number
  size: number
  sizePct: number
  strong: boolean
  filled: boolean
  mitigated: boolean
  postSweep: boolean
  zone: 'discount' | 'premium' | 'equilibrium'
  t: number
  idx: number
}

function detectFVGs(c: Candle[], swingHi: number, swingLo: number): FVG[] {
  const n = c.length
  const a = atr(c, 14) || c[n - 1].c * 0.01
  const range = swingHi - swingLo || c[n - 1].c
  const eq = (swingHi + swingLo) / 2
  const band = range * 0.05
  const out: FVG[] = []
  for (let i = 1; i < n - 1; i++) {
    const c1 = c[i - 1]
    const c2 = c[i]
    const c3 = c[i + 1]
    let type: 'bull' | 'bear' | null = null
    let top = 0
    let bottom = 0
    if (c1.h < c3.l) {
      type = 'bull'
      top = c3.l
      bottom = c1.h
    } else if (c1.l > c3.h) {
      type = 'bear'
      top = c1.l
      bottom = c3.h
    }
    if (!type) continue
    const size = top - bottom
    if (size <= 0) continue
    const rng = c2.h - c2.l || size
    const bodyRatio = Math.abs(c2.c - c2.o) / rng
    const gapATR = size / a
    const strong = bodyRatio >= 0.5 && gapATR >= 0.35
    let filled = false
    let mitigated = false
    for (let j = i + 2; j < n; j++) {
      if (type === 'bull') {
        if (c[j].l <= top) mitigated = true
        if (c[j].l <= bottom) {
          filled = true
          break
        }
      } else {
        if (c[j].h >= bottom) mitigated = true
        if (c[j].h >= top) {
          filled = true
          break
        }
      }
    }
    const mid = (top + bottom) / 2
    let zone: 'discount' | 'premium' | 'equilibrium' = 'equilibrium'
    if (mid < eq - band) zone = 'discount'
    else if (mid > eq + band) zone = 'premium'
    out.push({
      type,
      top,
      bottom,
      mid,
      size,
      sizePct: (size / c2.c) * 100,
      strong,
      filled,
      mitigated,
      postSweep: sweepBefore(c, i, type),
      zone,
      t: c2.t,
      idx: i,
    })
  }
  return out
}

const cache = new Map<string, { t: number; v: any }>()

export async function getFVG(symbol: string, interval: string): Promise<any> {
  const key = symbol.toUpperCase() + '|' + interval
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.t < TTL) return hit.v
  const { candles, source } = await getKlines(symbol.toUpperCase(), interval, 160)
  if (!candles) {
    const v = { available: false, reason: 'klines_unavailable', symbol: symbol.toUpperCase(), interval }
    cache.set(key, { t: now, v })
    return v
  }
  const n = candles.length
  const lookN = Math.min(80, n)
  let swingHi = -Infinity
  let swingLo = Infinity
  for (let i = n - lookN; i < n; i++) {
    if (candles[i].h > swingHi) swingHi = candles[i].h
    if (candles[i].l < swingLo) swingLo = candles[i].l
  }
  const eq = (swingHi + swingLo) / 2
  const band = (swingHi - swingLo) * 0.05
  const price = candles[n - 1].c
  let priceZone: 'discount' | 'premium' | 'equilibrium' = 'equilibrium'
  if (price < eq - band) priceZone = 'discount'
  else if (price > eq + band) priceZone = 'premium'

  const all = detectFVGs(candles, swingHi, swingLo)
  const active = all.filter((f) => !f.filled)
  active.sort((a, b) => Number(b.postSweep) - Number(a.postSweep) || Number(b.strong) - Number(a.strong) || b.idx - a.idx)
  const chart = candles.slice(-70).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }))

  const v = {
    available: true,
    source,
    symbol: symbol.toUpperCase(),
    interval,
    price,
    bias: trendBias(candles),
    priceZone,
    swingHi,
    swingLo,
    eq,
    fvgCount: all.length,
    activeCount: active.length,
    fvgs: active.slice(0, 12),
    candles: chart,
  }
  cache.set(key, { t: now, v })
  return v
}
