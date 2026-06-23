// Real per-symbol metrics for the market-detail view (Resonance / Crowding /
// Order-flow / Agent-activity). Everything here is computed from REAL exchange
// data with deterministic formulas - no random, no simulation.
//
// Source order:
//   1) Binance USD-M futures (ticker + premiumIndex + positioning/flow/OI).
//   2) Coinalyze fallback (funding, open interest + change, long/short ratio,
//      taker volume) - reachable from regions where Binance is geo-blocked.
// If neither source returns usable data we report { available:false } so the UI
// can say "live data unavailable" instead of inventing numbers.

import { BASE, fetchJson, symbolStats, buildPair } from './market'

const CAZ_BASE = process.env.COINALYZE_API_BASE || 'https://api.coinalyze.net/v1'
const CAZ_KEY = process.env.COINALYZE_API_KEY || ''
const CAZ_EXCH = process.env.COINALYZE_EXCHANGE_CODE || 'A'
const TTL = Number(process.env.SYMBOL_CACHE_MS) || 20_000

function num(x: any): number {
  const n = typeof x === 'string' ? parseFloat(x) : x
  return typeof n === 'number' && isFinite(n) ? n : NaN
}

async function cazGet(path: string, params: Record<string, any>): Promise<any> {
  if (!CAZ_KEY) return null
  const qs = Object.keys(params)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])))
    .join('&')
  const url = CAZ_BASE + path + (qs ? '?' + qs : '')
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 9000)
  try {
    const r = await fetch(url, { headers: { api_key: CAZ_KEY, accept: 'application/json' }, signal: ctrl.signal as any })
    if (!r.ok) return null
    return await r.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

function lastHist(arr: any): any {
  if (!Array.isArray(arr) || !arr.length) return null
  const h = arr[0] && arr[0].history
  return Array.isArray(h) && h.length ? h[h.length - 1] : null
}
function firstHist(arr: any): any {
  if (!Array.isArray(arr) || !arr.length) return null
  const h = arr[0] && arr[0].history
  return Array.isArray(h) && h.length ? h[0] : null
}
function curVal(arr: any): number {
  if (!Array.isArray(arr) || !arr.length) return NaN
  const o = arr[0]
  return num(o && (o.value !== undefined ? o.value : o.v))
}

// Build the same metric object as Binance, but from Coinalyze fields.
async function cazSymbolReal(sym: string): Promise<any | null> {
  if (!CAZ_KEY) return null
  const cs = sym.toUpperCase() + '_PERP.' + CAZ_EXCH
  const toSec = Math.floor(Date.now() / 1000)
  const fromSec = toSec - 3600
  const [fund, oi, oiHist, lsHist, ohlc] = await Promise.all([
    cazGet('/funding-rate', { symbols: cs }),
    cazGet('/open-interest', { symbols: cs, convert_to_usd: 'true' }),
    cazGet('/open-interest-history', { symbols: cs, interval: '5min', from: fromSec, to: toSec, convert_to_usd: 'true' }),
    cazGet('/long-short-ratio-history', { symbols: cs, interval: '5min', from: fromSec, to: toSec }),
    cazGet('/ohlcv-history', { symbols: cs, interval: '5min', from: fromSec, to: toSec }),
  ])

  // funding (decimal) -> premiumIndex-shaped object for buildPair
  const fundingVal = curVal(fund)
  // open interest (USD)
  let oiUsd = curVal(oi)
  // OI change over the last hour
  let oiChange = 0
  const oiL = lastHist(oiHist)
  const oiF = firstHist(oiHist)
  if (oiL && oiF) {
    const a = num(oiF.c)
    const b = num(oiL.c)
    if (isFinite(a) && a > 0 && isFinite(b)) oiChange = (b - a) / a
    if (!isFinite(oiUsd)) oiUsd = num(oiL.c)
  }
  // long/short accounts -> long fraction
  let longAccount = NaN
  const ls = lastHist(lsHist)
  if (ls) {
    const l = num(ls.l)
    const sh = num(ls.s)
    const r = num(ls.r)
    if (isFinite(l) && isFinite(sh) && l + sh > 0) longAccount = l / (l + sh)
    else if (isFinite(r) && r > 0) longAccount = r / (1 + r)
  }
  // taker buy ratio from OHLCV buy volume (bv) vs total (v)
  let taker = NaN
  const cd = lastHist(ohlc)
  if (cd) {
    const bv = num(cd.bv)
    const v = num(cd.v)
    if (isFinite(bv) && isFinite(v) && v > 0) taker = bv / v
  }

  const hasAny = isFinite(longAccount) || isFinite(fundingVal) || isFinite(oiUsd)
  if (!hasAny) return null

  // Reuse the exact Binance formula set via buildPair.
  const t = { lastPrice: NaN, priceChangePercent: NaN, highPrice: NaN, lowPrice: NaN, quoteVolume: NaN }
  const pi = isFinite(fundingVal) ? { lastFundingRate: fundingVal } : null
  const ss = { longAccount, taker, topPos: NaN, oiUsd: isFinite(oiUsd) ? oiUsd : NaN, oiChange }
  const pair = buildPair(sym.toUpperCase(), t, pi, ss)
  return { available: true, source: 'coinalyze', symbol: sym.toUpperCase(), ...pair }
}

async function binanceSymbolReal(sym: string): Promise<any | null> {
  try {
    const [t, pi, ss] = await Promise.all([
      fetchJson(BASE + '/fapi/v1/ticker/24hr?symbol=' + encodeURIComponent(sym)).catch(() => null),
      fetchJson(BASE + '/fapi/v1/premiumIndex?symbol=' + encodeURIComponent(sym)).catch(() => null),
      symbolStats(sym).catch(() => null),
    ])
    if (!t || !t.symbol) return null
    const pair = buildPair(sym, t, pi && pi.symbol ? pi : null, ss)
    return { available: true, source: 'binance-futures', symbol: sym.toUpperCase(), ...pair }
  } catch {
    return null
  }
}

const cache = new Map<string, { t: number; v: any }>()

export async function getSymbolReal(symbol: string): Promise<any> {
  const sym = (symbol || '').toUpperCase()
  if (!sym) return { available: false, reason: 'no_symbol' }
  const now = Date.now()
  const hit = cache.get(sym)
  if (hit && now - hit.t < TTL) return hit.v
  let v = await binanceSymbolReal(sym)
  if (!v) v = await cazSymbolReal(sym)
  if (!v) v = { available: false, symbol: sym, reason: 'symbol_data_unavailable' }
  cache.set(sym, { t: now, v })
  return v
}
