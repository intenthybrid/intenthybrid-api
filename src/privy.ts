import { PrivyClient } from '@privy-io/server-auth'
import type { Request, Response, NextFunction } from 'express'

const appId = process.env.PRIVY_APP_ID || ''
const appSecret = process.env.PRIVY_APP_SECRET || ''

// The App Secret lives ONLY here, on the server, loaded from the environment.
export const privy = new PrivyClient(appId, appSecret)

// Express middleware: require a valid Privy access token on protected routes.
// The frontend sends it as `Authorization: Bearer <token>` using getAccessToken().
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' })
    return
  }
  const token = header.slice(7)
  try {
    const claims = await privy.verifyAuthToken(token)
    // claims.userId is the Privy user DID (e.g. did:privy:...)
    ;(req as any).privyUserId = claims.userId
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
