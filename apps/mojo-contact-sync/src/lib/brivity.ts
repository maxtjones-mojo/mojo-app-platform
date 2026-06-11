import type { StructuredAddress } from './address'
import { addressKey, isEmptyAddress } from './address'

export interface BrivityPerson {
  id: string
  name: string
  emails: string[]
  phones: string[]
  /** First entry is treated as the current/primary address. */
  addresses: StructuredAddress[]
}

interface BrivityClientOptions {
  apiKey: string
  apiBase: string
}

export class BrivityClient {
  private readonly apiKey: string
  private readonly apiBase: string

  constructor(opts: BrivityClientOptions) {
    this.apiKey = opts.apiKey
    this.apiBase = opts.apiBase.replace(/\/+$/, '')
  }

  private async get(
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<unknown> {
    const url = new URL(`${this.apiBase}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `Brivity API ${res.status} ${res.statusText} for ${url.pathname}\n${body.slice(0, 500)}`,
      )
    }
    return res.json()
  }

  /** Large GET /people requests 500 intermittently (server-side timeout), so retry. */
  private async getWithRetries(
    path: string,
    query: Record<string, string | number>,
    attempts = 5,
  ): Promise<unknown> {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.get(path, query)
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 3000 * (i + 1)))
      }
    }
    throw lastErr
  }

  /** Fetch a few raw records so `--dump-brivity` can reveal real field names. */
  async dumpRawPage(): Promise<unknown> {
    return this.get('/people', { limit: 3 })
  }

  /**
   * List all Brivity people.
   *
   * The /people index ignores page/per_page/offset and every filter or sort
   * param (verified against the real tenant 2026-06-10) — `limit` is the ONLY
   * honored parameter. So pagination is impossible; instead, request a
   * generous limit and grow it until the response comes back shorter than
   * requested, which proves the full dataset was returned.
   */
  async listPeople(): Promise<BrivityPerson[]> {
    const MAX_LIMIT = 60000
    // Find a size the server can actually serve: big requests 500 intermittently,
    // and ~5000+ failed every attempt on the real tenant. Step down rather than die.
    let rows: Record<string, unknown>[] | null = null
    let limit = 0
    for (const candidate of [4500, 3500, 2000]) {
      try {
        rows = extractArray(await this.getWithRetries('/people', { limit: candidate }))
        limit = candidate
        break
      } catch {
        console.error(`Brivity /people?limit=${candidate} kept failing; trying smaller…`)
      }
    }
    if (rows === null) {
      throw new Error('Brivity /people failed at every request size — API unavailable?')
    }
    // Grow until the response is shorter than requested, which proves completeness.
    while (rows.length >= limit && limit < MAX_LIMIT) {
      const nextLimit = Math.min(Math.ceil(limit * 1.5), MAX_LIMIT)
      try {
        const next = extractArray(await this.getWithRetries('/people', { limit: nextLimit }, 3))
        // A shrinking response would mean the API silently capped us; keep the larger set.
        if (next.length < rows.length) break
        rows = next
      } catch {
        // The bigger request kept failing; fall through with what we have.
        break
      }
      limit = nextLimit
    }
    if (rows.length >= limit) {
      console.error(
        `WARNING: Brivity returned exactly ${rows.length} people (the requested cap) and ` +
          `larger requests failed — the list may be TRUNCATED. Plan covers only these records.`,
      )
    }
    return rows.map(mapBrivityPerson)
  }
}

/** Brivity may wrap the list as {data:[]} / {people:[]} / {results:[]} or a bare array. */
function extractArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  const obj = data as Record<string, unknown> | null
  for (const key of ['data', 'people', 'results']) {
    const v = obj?.[key]
    if (Array.isArray(v)) return v as Record<string, unknown>[]
  }
  return []
}

/**
 * Map a raw Brivity person record to our shape.
 *
 * Verified against the real MoJo tenant (GET /api/people, 2026-06-10):
 * one `email_address`, one `phone_number`, and one inline address per record —
 * `street_address` / `city` / `locality` (the STATE, e.g. "MO") / `postal_code`
 * / `country`. No nested emails/phones/addresses arrays; the array fallbacks
 * below are kept for other tenants but are unused on this one.
 */
export function mapBrivityPerson(raw: Record<string, unknown>): BrivityPerson {
  const id = String(raw.id ?? raw.uuid ?? raw.person_id ?? '')
  const name = (
    asString(raw.name) ||
    [asString(raw.first_name), asString(raw.last_name)].filter(Boolean).join(' ') ||
    '(unnamed)'
  )
    .replace(/\s+/g, ' ')
    .trim()

  const emails = collectStrings([
    raw.email_address,
    raw.email,
    raw.primary_email,
    ...arr(raw.emails).map((e) =>
      typeof e === 'string' ? e : asString(rec(e).address ?? rec(e).value ?? rec(e).email),
    ),
  ])

  const phones = collectStrings([
    raw.phone_number,
    raw.phone,
    raw.primary_phone,
    raw.mobile,
    ...arr(raw.phones).map((p) =>
      typeof p === 'string' ? p : asString(rec(p).number ?? rec(p).value ?? rec(p).phone),
    ),
  ])

  const addresses = arr(raw.addresses)
    .map((a) => mapBrivityAddress(rec(a)))
    .filter((a) => !isEmptyAddress(a))

  // Some tenants store a single address inline on the person rather than in an array.
  const inline = mapBrivityAddress(raw)
  if (!isEmptyAddress(inline)) {
    const k = addressKey(inline)
    if (!addresses.some((a) => addressKey(a) === k)) addresses.unshift(inline)
  }

  return { id, name, emails, phones, addresses }
}

function mapBrivityAddress(raw: Record<string, unknown>): StructuredAddress {
  return {
    street: asString(
      raw.street_address ?? raw.street ?? raw.address1 ?? raw.address_line_1 ?? raw.line1,
    ),
    city: asString(raw.city),
    // On this tenant `locality` holds the state ("MO"), not the city.
    region: asString(raw.state ?? raw.region ?? raw.province ?? raw.locality),
    postalCode: asString(raw.postal_code ?? raw.zip ?? raw.zipcode ?? raw.postcode),
    country: asString(raw.country),
    formatted: asString(raw.formatted_address ?? raw.full_address),
  }
}

// ---- small helpers ----

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim()
    return t.length > 0 ? t : undefined
  }
  if (typeof v === 'number') return String(v)
  return undefined
}

function collectStrings(vals: unknown[]): string[] {
  const out = new Set<string>()
  for (const v of vals) {
    const s = asString(v)
    if (s) out.add(s)
  }
  return [...out]
}
