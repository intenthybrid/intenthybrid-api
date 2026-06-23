// Fetches a public X (Twitter) profile, including follower/following counts.
//
// X API note (2026): there is no free tier for new developers. User profile
// lookups are pay-per-use (~$0.01 per unique user per UTC day). You must create
// an X developer app, generate an app-only Bearer Token, and load a little credit
// in the Developer Console. Put the token in X_BEARER_TOKEN (backend .env only).
//
// If X_BEARER_TOKEN is not set, this returns { available: false } so the rest of
// the profile still works without follower numbers.

const X_BEARER = process.env.X_BEARER_TOKEN || ''
// X is migrating api.twitter.com -> api.x.com. Default to the long-stable host;
// override with X_API_BASE if needed.
const X_API_BASE = process.env.X_API_BASE || 'https://api.twitter.com'

export type XProfile = {
  available: boolean
  reason?: string
  username?: string
  name?: string
  avatar?: string
  description?: string
  verified?: boolean
  followers?: number | null
  following?: number | null
  tweets?: number | null
}

export async function getXProfile(usernameRaw: string): Promise<XProfile> {
  if (!X_BEARER) return { available: false, reason: 'x_api_not_configured' }
  const username = String(usernameRaw || '').replace(/^@/, '').trim()
  if (!username || !/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    return { available: false, reason: 'invalid_username' }
  }
  const url =
    X_API_BASE +
    '/2/users/by/username/' +
    encodeURIComponent(username) +
    '?user.fields=public_metrics,profile_image_url,description,name,verified'
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + X_BEARER } })
    if (!r.ok) {
      let reason = 'HTTP ' + r.status
      try {
        const j: any = await r.json()
        reason = j?.title || j?.detail || j?.errors?.[0]?.message || reason
      } catch {
        /* ignore */
      }
      return { available: false, reason }
    }
    const j: any = await r.json()
    const d = j?.data
    if (!d) return { available: false, reason: 'not_found' }
    const m = d.public_metrics || {}
    return {
      available: true,
      username: d.username,
      name: d.name,
      avatar: (d.profile_image_url || '').replace('_normal', '_400x400'),
      description: d.description || '',
      verified: !!d.verified,
      followers: m.followers_count ?? null,
      following: m.following_count ?? null,
      tweets: m.tweet_count ?? null,
    }
  } catch (e: any) {
    return { available: false, reason: e?.message || 'request_failed' }
  }
}
