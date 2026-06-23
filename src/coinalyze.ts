// Coinalyze API liquidation provider - the FREE option.
//
// Coinalyze offers a genuinely free API: create a free account at
// https://coinalyze.net/account/api-key/ and generate a key (40 calls/min).
// It aggregates real liquidation data and serves it over plain HTTPS, so it
// works from any region (including where Binance is geo-blocked).
//
// Docs: https://api.coinalyze.net/v1/doc  (base https://api.coinalyze.net/v1)
//   GET /liquidation-history?symbols=BTCUSDT_PERP.A&interval=1hour&from=..&to=..&convert_to_usd=true
//   Response: [{ symbol, history: [{ t (unix sec), l (long usd), s (short usd) }] }]
// Auth: header (or query param) named `api_key`.
//
// Note: Coinalyze gives hourly long/short liquidation TOTALS (and history), but
// not a per-price breakdown - so liquidation "levels" stay empty on this source.

const CAZ_BASE = process.env.COINALYZE_API_BASE || 'https://api.coinalyze.net/v1'
const CAZ_KEY = process.env.COINALYZE_API_KEY || ''
const CAZ_EXCH = process.env.COINALYZE_EXCHANGE_CODE || 'A' // A = Binance
const TTL = Number(process.env.COINALYZE_CACHE_MS) || 12_000

export function cazEnabled(): boolean {
  return !!CAZ_KEY
}

function numv(x: any): number {
  const n = typeof x === 'string' ? parseFloat(x) : x
  return typeof n === 'number' && isFinite(n) ? n : NaN
}

const cache = new Map<string, { t: number; v: any }>()

async function cazGet(path: string, params: Record<string, any>): Promise<{ ok: boolean; status: number; data: any }> {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  const url = CAZ_BASE + path + (qs ? '?' + qs : '')
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 9000)
  try {
    const r = await fetch(url, {
      headers: { api_key: CAZ_KEY, Accept: 'application/json' },
      signal: ctrl.signal as any,
    })
    const j: any = await r.json().catch(() => null)
    return { ok: r.ok, status: r.status, data: j }
  } finally {
    clearTimeout(to)
  }
}

// Full per-token liquidation snapshot (hourly totals + history). Levels are not
// available from Coinalyze, so that array is returned empty.
export async function cazLiquidations(symbol: string): Promise<any | null> {
  if (!cazEnabled()) return null
  const HOUR = 3600000
  const nowH = Math.floor(Date.now() / HOUR) * HOUR
  const c = cache.get(symbol)
  const now = Date.now()
  // Reuse cache only within TTL AND only if it was computed for the current
  // clock-hour. Once the hour rolls over, the cached hour totals are stale, so
  // we recompute immediately (this is what makes 'This hour' reset to 0).
  if (c && now - c.t < TTL && (c.v == null || c.v.hourStartMs === nowH)) return c.v
  const cazSym = symbol.toUpperCase() + '_PERP.' + CAZ_EXCH // e.g. BTCUSDT_PERP.A
  const toSec = Math.floor(Date.now() / 1000)
  const fromSec = toSec - 14 * 3600 // last 14 hours
  let res: any
  try {
    res = await cazGet('/liquidation-history', {
      symbols: cazSym,
      interval: '1hour',
      from: fromSec,
      to: toSec,
      convert_to_usd: 'true',
    })
  } catch {
    return null
  }
  if (!res || !res.ok || !Array.isArray(res.data) || !res.data.length) {
    cache.set(symbol, { t: now, v: null })
    return null
  }
  const histRaw = (res.data[0] && res.data[0].history) || []
  const hours = histRaw
    .map((h: any) => {
      const tms = (numv(h.t) || 0) * 1000
      const long = numv(h.l) || 0
      const short = numv(h.s) || 0
      return { hourMs: tms, long, short, usd: long + short }
    })
    .filter((h: any) => h.hourMs > 0)
    .sort((a: any, b: any) => a.hourMs - b.hourMs)
  if (!hours.length) {
    cache.set(symbol, { t: now, v: null })
    return null
  }
  const hourFloor = (ms: number) => Math.floor(ms / HOUR) * HOUR
  const cur = hours.find((h: any) => hourFloor(h.hourMs) === nowH) || null
  const prev = hours.find((h: any) => hourFloor(h.hourMs) === nowH - HOUR) || null
  // Average liquidations of the COMPLETED hours (exclude the in-progress one),
  // used by the UI to decide when this hour is a notable long/short spike.
  const completed = hours.filter((h: any) => h !== cur)
  const avgHourUsd = completed.length ? completed.reduce((a: number, h: any) => a + h.usd, 0) / completed.length : 0
  const v = {
    available: true,
    source: 'coinalyze',
    symbol,
    hourUsd: cur ? cur.usd : 0,
    prevHourUsd: prev ? prev.usd : 0,
    hourLong: cur ? cur.long : 0,
    hourShort: cur ? cur.short : 0,
    avgHourUsd,
    hourStartMs: nowH,
    nextHourMs: nowH + HOUR,
    levels: [],
    history: hours.slice().reverse().slice(0, 12),
  }
  cache.set(symbol, { t: now, v })
  return v
}
