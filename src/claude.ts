import Anthropic from '@anthropic-ai/sdk'

// The Anthropic API key lives ONLY here, on the server.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

const SYSTEM = [
  'You are the AI analyst for Intent Hybrid, a system that watches the collective',
  'behavior of DeFi bots to detect algorithmic resonance: synchronized exits that',
  'can trigger liquidation cascades. Tagline: See the herd before it stampedes.',
  'Explain clearly and briefly for a trader, in plain language.',
  'You do not give financial advice; you describe risk and reasoning.',
  'When given a resonance index from 0 to 100, read it as: 0 to 49 Normal,',
  '50 to 74 Elevated, 75 to 100 Danger. Keep answers concise.',
].join(' ')

// Raw passthrough to Claude. The caller supplies the full prompt (used by the
// single file dApp, whose own prompts already contain their instructions).
export async function complete(prompt: string): Promise<string> {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim()
}

export async function analyze(prompt: string, context?: any): Promise<string> {
  const ctx = context ? '\n\nCurrent signals (JSON):\n' + JSON.stringify(context) : ''
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt + ctx }],
  })
  return msg.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim()
}
