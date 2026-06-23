// Reads on-chain wallet holdings (native + ERC-20 tokens) across multiple EVM
// chains via Alchemy, in parallel, with per-call timeouts so the request can
// never hang (a slow or not-enabled network is skipped, not blocking).
//
// Put the key in ALCHEMY_API_KEY (backend .env only). Limit chains with
// HOLDINGS_CHAINS (comma separated). Missing key -> { error:'alchemy_not_configured' }.

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || ''
const CALL_TIMEOUT_MS = Number(process.env.ALCHEMY_TIMEOUT_MS || 6000)
const HOLD_CACHE_MS = Number(process.env.HOLDINGS_CACHE_MS || 45000)

type ChainCfg = { id: string; label: string; base: string; native: string }

const ALL_CHAINS: ChainCfg[] = [
  { id: 'ethereum', label: 'Ethereum', base: 'https://eth-mainnet.g.alchemy.com/v2/', native: 'ETH' },
  { id: 'base', label: 'Base', base: 'https://base-mainnet.g.alchemy.com/v2/', native: 'ETH' },
  { id: 'arbitrum', label: 'Arbitrum', base: 'https://arb-mainnet.g.alchemy.com/v2/', native: 'ETH' },
  { id: 'optimism', label: 'Optimism', base: 'https://opt-mainnet.g.alchemy.com/v2/', native: 'ETH' },
  { id: 'polygon', label: 'Polygon', base: 'https://polygon-mainnet.g.alchemy.com/v2/', native: 'POL' },
]

function selectedChains(): ChainCfg[] {
  const env = (process.env.HOLDINGS_CHAINS || '').trim()
  if (!env) return ALL_CHAINS
  const want = env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const sel = ALL_CHAINS.filter((c) => want.includes(c.id))
  return sel.length ? sel : ALL_CHAINS
}

async function rpc(base: string, method: string, params: any[]): Promise<any> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS)
  try {
    const r = await fetch(base + ALCHEMY_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    })
    const j: any = await r.json()
    if (j && j.error) throw new Error(j.error.message || 'rpc error')
    return j ? j.result : null
  } finally {
    clearTimeout(to)
  }
}

type Native = { chain: string; label: string; symbol: string; balance: number | null }
type Token = { chain: string; label: string; contract: string; symbol: string; name: string; balance: number | null; logo: string }

async function chainHoldings(c: ChainCfg, address: string): Promise<{ native: Native; tokens: Token[] }> {
  const native: Native = { chain: c.id, label: c.label, symbol: c.native, balance: null }
  let tokens: Token[] = []
  // Native balance and token balances run in parallel (one round trip, not two).
  const [weiR, balR] = await Promise.allSettled([
    rpc(c.base, 'eth_getBalance', [address, 'latest']),
    rpc(c.base, 'alchemy_getTokenBalances', [address]),
  ])
  try {
    const wei = weiR.status === 'fulfilled' ? weiR.value : null
    if (wei) native.balance = Number(BigInt(wei)) / 1e18
  } catch {
    /* keep null */
  }
  try {
    const res = balR.status === 'fulfilled' ? balR.value : null
    const bals = ((res && res.tokenBalances) || [])
      .filter((b: any) => {
        try {
          return b && b.tokenBalance && b.tokenBalance !== '0x' && BigInt(b.tokenBalance) > 0n
        } catch {
          return false
        }
      })
      .slice(0, 10)
    tokens = await Promise.all(
      bals.map(async (b: any): Promise<Token> => {
        let meta: any = null
        try {
          meta = await rpc(c.base, 'alchemy_getTokenMetadata', [b.contractAddress])
        } catch {
          /* ignore */
        }
        const dec = meta && meta.decimals != null ? meta.decimals : 18
        let bal: number | null = null
        try {
          bal = Number(BigInt(b.tokenBalance)) / Math.pow(10, dec)
        } catch {
          bal = null
        }
        return {
          chain: c.id,
          label: c.label,
          contract: b.contractAddress,
          symbol: (meta && meta.symbol) || '?',
          name: (meta && meta.name) || '',
          balance: bal,
          logo: (meta && meta.logo) || '',
        }
      })
    )
    tokens.sort((a, b) => (b.balance || 0) - (a.balance || 0))
  } catch {
    /* native only */
  }
  return { native, tokens }
}

export type Holdings = {
  error?: string
  address?: string
  natives?: Native[]
  tokens?: Token[]
  chains?: string[]
}

const holdCache = new Map<string, { ts: number; data: Holdings }>()

export async function getHoldings(addressRaw: string): Promise<Holdings> {
  if (!ALCHEMY_KEY) return { error: 'alchemy_not_configured' }
  const address = String(addressRaw || '').trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return { error: 'invalid_address' }
  const key = address.toLowerCase()
  const hit = holdCache.get(key)
  if (hit && Date.now() - hit.ts < HOLD_CACHE_MS) return hit.data
  const chains = selectedChains()
  const results = await Promise.all(
    chains.map((c) =>
      chainHoldings(c, address).catch(() => ({
        native: { chain: c.id, label: c.label, symbol: c.native, balance: null } as Native,
        tokens: [] as Token[],
      }))
    )
  )
  const natives = results.map((r) => r.native)
  const tokens = results.flatMap((r) => r.tokens)
  const out: Holdings = { address, natives, tokens, chains: chains.map((c) => c.label) }
  holdCache.set(key, { ts: Date.now(), data: out })
  return out
}
