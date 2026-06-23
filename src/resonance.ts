// Detection tier: a simplified resonance heuristic. This is NOT an LLM.
// It reads recent market moves and measures how synchronized they are.
// When many assets move together (low cross sectional dispersion) during a
// large move, that points to herding, which is the seed of a cascade.
// This is a transparent proxy you can later replace with your own model.

const SYMBOLS = (process.env.RESONANCE_SYMBOLS ||
  'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

type Row = { symbol: string; change: number; price: number }

function mean(a: number[]) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
}

function buildIndex(rows: Row[], source: 'live' | 'simulated') {
  const changes = rows.map((r) => r.change)
  const avg = mean(changes) // the herd move, in percent
  const csad = mean(changes.map((c) => Math.abs(c - avg))) // cross sectional dispersion
  const move = Math.abs(avg)
  // Big move with tight dispersion means strong synchronization.
  const intensity = move / (csad + 0.5)
  const index = Math.round(Math.min(100, intensity * 25 + move * 3))
  const band = index >= 75 ? 'Danger' : index >= 50 ? 'Elevated' : 'Normal'
  return {
    index,
    band,
    source,
    avgChange: Number(avg.toFixed(2)),
    dispersion: Number(csad.toFixed(2)),
    markets: rows.map((r) => ({
      symbol: r.symbol,
      change: Number(r.change.toFixed(2)),
      price: r.price,
    })),
    updatedAt: new Date().toISOString(),
  }
}

export async function computeResonance() {
  try {
    const rows = await Promise.all(
      SYMBOLS.map(async (s) => {
        const r = await fetch(
          'https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=' + s
        )
        if (!r.ok) throw new Error('binance ' + r.status)
        const d: any = await r.json()
        return {
          symbol: s,
          change: parseFloat(d.priceChangePercent),
          price: parseFloat(d.lastPrice),
        } as Row
      })
    )
    return buildIndex(rows, 'live')
  } catch {
    // Fallback so the endpoint always returns something, e.g. when offline.
    const sim: Row[] = SYMBOLS.map((s) => ({
      symbol: s,
      change: Math.random() * 8 - 4,
      price: 0,
    }))
    return buildIndex(sim, 'simulated')
  }
}
