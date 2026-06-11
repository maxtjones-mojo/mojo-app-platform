import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Minimal .env loader (no dependency). Only sets vars not already present in
 * process.env, so real shell env always wins.
 */
export function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

export type MatchStrategy =
  | 'phone_then_email'
  | 'email_then_phone'
  | 'phone_only'
  | 'email_only'

export const MATCH_STRATEGIES: MatchStrategy[] = [
  'phone_then_email',
  'email_then_phone',
  'phone_only',
  'email_only',
]

export interface Config {
  brivity: { apiKey: string; apiBase: string }
  google: {
    clientId?: string
    clientSecret?: string
    refreshToken?: string
    accessToken?: string
  }
  matchStrategy: MatchStrategy
  addressLabel: string
}

export function loadConfig(): Config {
  loadDotEnv()
  const strategy = (process.env.MATCH_STRATEGY ?? 'phone_then_email').trim() as MatchStrategy
  return {
    brivity: {
      apiKey: process.env.BRIVITY_API_KEY ?? '',
      apiBase: process.env.BRIVITY_API_BASE ?? 'https://api.brivity.com/api/v2',
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      accessToken: process.env.GOOGLE_ACCESS_TOKEN,
    },
    matchStrategy: MATCH_STRATEGIES.includes(strategy) ? strategy : 'phone_then_email',
    addressLabel: process.env.ADDRESS_LABEL || 'Home',
  }
}

export function assertBrivityConfig(c: Config): void {
  if (!c.brivity.apiKey) {
    throw new Error('BRIVITY_API_KEY is not set (shell env or .env file).')
  }
}

export function assertGoogleConfig(c: Config): void {
  const g = c.google
  if (g.accessToken) return
  if (!g.refreshToken || !g.clientId || !g.clientSecret) {
    throw new Error(
      'Google auth requires either GOOGLE_ACCESS_TOKEN, or all of ' +
        'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN.',
    )
  }
}
