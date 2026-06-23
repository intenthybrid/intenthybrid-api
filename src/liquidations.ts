// Optional REAL liquidation feed.
//
// Binance does not expose realized liquidations over REST, only over a
// WebSocket stream (!forceOrder@arr = every liquidation, all symbols). This
// module keeps a rolling 1h tally per symbol in memory so /api/market can show
// real liquidation clusters and a 1h total.
//
// It is fully OPTIONAL and fully ISOLATED: if the runtime has no global
// WebSocket (Node < 21) or the stream cannot be reached, nothing here ever
// throws into the request path - getLiq() just returns null and market.ts
// falls back to estimated liquidation bands.
//
// Control with MARKET_LIQ_WS in the backend .env:
//   auto (default) = turn on if a global WebSocket exists
//   on             = force on
//   off            = never connect (always use estimates)

type Ev = { side: 'Long' | 'Short'; price: number; usd: number; t: number }
type Bucket = { events: Ev[]; usd1h: number }

const WINDOW_MS = 6 * 60 * 60 * 1000 // 6 hours of events for liquidation-level clusters
const MAX_EVENTS = 300 // cap memory per symbol
const WS_BASE = process.env.BINANCE_WS_BASE || 'wss://fstream.binance.com/ws'
const MODE = (process.env.MARKET_LIQ_WS || 'auto').toLowerCase()

const store = new Map<string, Bucket>()
let active = false

// Clock-hour buckets (market-wide) for the hourly total + history.
const HOUR_MS = 60 * 60 * 1000
const HISTORY_HOURS = 12
const hourly = new Map<number, { usd: number; count: number }>()
function hourStart(t: number) { return Math.floor(t / HOUR_MS) * HOUR_MS }
function pruneHourly(now: number) {
  const cutoff = hourStart(now) - HISTORY_HOURS * HOUR_MS
  for (const k of Array.from(hourly.keys())) if (k < cutoff) hourly.delete(k)
}

// Per-symbol clock-hour buckets (per-token history + previous-hour totals).
const hourlyBySym = new Map<string, Map<number, { usd: number; count: number }>>()
function pruneHourlyBySym(now: number) {
  const cutoff = hourStart(now) - HISTORY_HOURS * HOUR_MS
  for (const [, m] of hourlyBySym) for (const k of Array.from(m.keys())) if (k < cutoff) m.delete(k)
}
let attempts = 0
let ws: any = null

function wsCtor(): any {
  // Global WebSocket exists in Node 21+ (and in most modern runtimes).
  return (globalThis as any).WebSocket
}

function prune(b: Bucket, now: number) {
  const cut = now - WINDOW_MS
  if (b.events.length && b.events[0].t < cut) {
    b.events = b.events.filter((e) => e.t >= cut)
  }
  if (b.events.length > MAX_EVENTS) b.events = b.events.slice(-MAX_EVENTS)
  const oneH = now - 60 * 60 * 1000
  b.usd1h = b.events.reduce((a, e) => (e.t >= oneH ? a + e.usd : a), 0)
}

function note(symbol: string, S: string, priceStr: string, qtyStr: string, t: number) {
  const price = parseFloat(priceStr)
  const qty = parseFloat(qtyStr)
  if (!isFinite(price) || !isFinite(qty) || price <= 0 || qty <= 0) return
  // A forceOrder with side SELL is a forced sell = a LONG being liquidated.
  const side: 'Long' | 'Short' = S === 'SELL' ? 'Long' : 'Short'
  const usd = price * qty
  let b = store.get(symbol)
  if (!b) {
    b = { events: [], usd1h: 0 }
    store.set(symbol, b)
  }
  const ts = t || Date.now()
  b.events.push({ side, price, usd, t: ts })
  prune(b, Date.now())
  const hs = hourStart(ts)
  const hb = hourly.get(hs) || { usd: 0, count: 0 }
  hb.usd += usd
  hb.count++
  hourly.set(hs, hb)
  let sm = hourlyBySym.get(symbol)
  if (!sm) { sm = new Map(); hourlyBySym.set(symbol, sm) }
  const shb = sm.get(hs) || { usd: 0, count: 0 }
  shb.usd += usd
  shb.count++
  sm.set(hs, shb)
}

function handleMessage(raw: any) {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw
    const items: any[] = Array.isArray(data) ? data : [data]
    for (const m of items) {
      const o = m && m.o ? m.o : null
      if (!o || !o.s) continue
      note(String(o.s), String(o.S || ''), String(o.ap || o.p || '0'), String(o.q || '0'), Number(m.E) || Date.now())
    }
  } catch {
    // ignore malformed frames
  }
}

function scheduleReconnect() {
  const delay = Math.min(60000, 2000 * Math.pow(2, Math.min(attempts, 5)))
  attempts++
  setTimeout(() => {
    try {
      connect()
    } catch {
      scheduleReconnect()
    }
  }, delay)
}

function connect() {
  const WS = wsCtor()
  if (!WS) return
  try {
    ws = new WS(WS_BASE + '/!forceOrder@arr')
    ws.onopen = () => {
      active = true
      attempts = 0
      console.log('[market] liquidation stream connected')
    }
    ws.onmessage = (ev: any) => handleMessage(ev && ev.data != null ? ev.data : ev)
    ws.onerror = () => {
      // onclose will follow and trigger reconnect
    }
    ws.onclose = () => {
      active = false
      ws = null
      scheduleReconnect()
    }
  } catch {
    active = false
    ws = null
    scheduleReconnect()
  }
}

// Boot (once, on import). Never throws.
;(function boot() {
  try {
    if (MODE === 'off') {
      console.log('[market] liquidation stream disabled (MARKET_LIQ_WS=off); using estimates')
      return
    }
    if (!wsCtor()) {
      console.log('[market] no global WebSocket in this Node runtime; liquidation clusters will be estimated. Use Node 21+ for the real feed.')
      return
    }
    connect()
  } catch {
    /* never throw at import time */
  }
})()

export function liqActive(): boolean {
  return active
}

export function getLiq(symbol: string): { usd1h: number; recent: Array<{ side: 'Long' | 'Short'; price: number; size: number }> } | null {
  const b = store.get(symbol)
  if (!b) return null
  prune(b, Date.now())
  if (!b.events.length) return null
  const recent = b.events
    .slice(-6)
    .map((e) => ({ side: e.side, price: e.price, size: +(e.usd / 1e6).toFixed(3) }))
  return { usd1h: b.usd1h, recent }
}

// Rich per-TOKEN snapshot from the live websocket feed: real liquidations of
// this token aggregated into price levels, plus current/previous clock-hour
// totals and an hourly history. Used as the fallback when no provider key is set.
export function getLiqRich(symbol: string): any {
  const now = Date.now()
  pruneHourlyBySym(now)
  const HOUR = HOUR_MS
  const nowH = hourStart(now)
  const b = store.get(symbol)
  if (b) prune(b, now)
  const byKey = new Map<string, { price: number; side: 'Long' | 'Short'; usd: number }>()
  if (b) {
    for (const e of b.events) {
      const bucket = +e.price.toPrecision(4)
      const k = e.side + '|' + bucket
      const x = byKey.get(k) || { price: bucket, side: e.side, usd: 0 }
      x.usd += e.usd
      byKey.set(k, x)
    }
  }
  let levels = Array.from(byKey.values())
    .sort((a, c) => c.usd - a.usd)
    .slice(0, 14)
    .sort((a, c) => c.price - a.price)
  const sm = hourlyBySym.get(symbol)
  const cur = sm && sm.get(nowH)
  const prev = sm && sm.get(nowH - HOUR)
  const history: Array<{ hourMs: number; usd: number; count: number }> = []
  if (sm) {
    for (let i = 0; i < HISTORY_HOURS; i++) {
      const k = nowH - i * HOUR
      const hb = sm.get(k)
      if (hb && hb.usd > 0) history.push({ hourMs: k, usd: hb.usd, count: hb.count })
    }
  }
  let hourLong = 0
  let hourShort = 0
  if (b) {
    for (const e of b.events) {
      if (hourStart(e.t) !== nowH) continue
      if (e.side === 'Long') hourLong += e.usd
      else hourShort += e.usd
    }
  }
  const completedH = history.filter((h) => h.hourMs !== nowH)
  const avgHourUsd = completedH.length ? completedH.reduce((a, h) => a + h.usd, 0) / completedH.length : 0
  return {
    available: active,
    active,
    source: 'binance-ws',
    symbol,
    hourUsd: cur ? cur.usd : 0,
    prevHourUsd: prev ? prev.usd : 0,
    hourLong,
    hourShort,
    avgHourUsd,
    hourStartMs: nowH,
    nextHourMs: nowH + HOUR,
    levels,
    history,
  }
}

// Whole-market real-time summary: total liquidated USD in the last hour across
// every symbol, plus the most recent individual liquidations market-wide.
// Whole-market real-time summary: rolling-1h totals, clock-hour total, and
// per-hour history for the last 12 hours, all from the live feed.
export function getMarketLiq(): {
  active: boolean
  usd1h: number
  recent: Array<{ sym: string; side: 'Long' | 'Short'; price: number; size: number }>
  hourUsd: number
  hourCount: number
  hourStartMs: number
  nextHourMs: number
  history: Array<{ hourMs: number; usd: number; count: number }>
} {
  const now = Date.now()
  pruneHourly(now)
  let usd1h = 0
  const all: Array<{ sym: string; side: 'Long' | 'Short'; price: number; usd: number; t: number }> = []
  for (const [sym, b] of store) {
    prune(b, now)
    usd1h += b.usd1h
    for (const e of b.events) all.push({ sym, side: e.side, price: e.price, usd: e.usd, t: e.t })
  }
  all.sort((a, b) => b.usd - a.usd)
  const recent = all.slice(0, 12).map((e) => ({ sym: e.sym, side: e.side, price: e.price, size: +(e.usd / 1e6).toFixed(3) }))
  const hs = hourStart(now)
  const cur = hourly.get(hs) || { usd: 0, count: 0 }
  const history: Array<{ hourMs: number; usd: number; count: number }> = []
  for (let i = 1; i <= HISTORY_HOURS; i++) {
    const k = hs - i * HOUR_MS
    const hb = hourly.get(k)
    if (hb && hb.usd > 0) history.push({ hourMs: k, usd: hb.usd, count: hb.count })
  }
  return { active, usd1h, recent, hourUsd: cur.usd, hourCount: cur.count, hourStartMs: hs, nextHourMs: hs + HOUR_MS, history }
}
