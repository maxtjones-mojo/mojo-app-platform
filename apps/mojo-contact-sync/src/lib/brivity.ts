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

  /** Fetch a small raw page so `--dump-brivity` can reveal real field names. */
  async dumpRawPage(): Promise<unknown> {
    return this.get('/people', { page: 1, per_page: 3 })
  }

  /** List all Brivity people with their addresses, following pagination. */
  async listPeople(): Promise<BrivityPerson[]> {
    const people: BrivityPerson[] = []
    const perPage = 100
    let page = 1
    // Hard cap to avoid an accidental infinite loop on an unexpected response shape.
    for (let guard = 0; guard < 1000; guard++) {
      const data = await this.get('/people', { page, per_page: perPage })
      const rows = extractArray(data)
      if (rows.length === 0) break
      for (const row of rows) people.push(mapBrivityPerson(row))
      if (rows.length < perPage) break
      page++
    }
    return people
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
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE ONE PLACE TO VERIFY AGAINST A REAL BRIVITY PAYLOAD.           │
 * │ Run `npm run dump-brivity` to print real records, then adjust the field   │
 * │ names below if they differ from these (defensive) assumptions.            │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
export function mapBrivityPerson(raw: Record<string, unknown>): BrivityPerson {
  const id = String(raw.id ?? raw.uuid ?? raw.person_id ?? '')
  const name =
    asString(raw.name) ||
    [asString(raw.first_name), asString(raw.last_name)].filter(Boolean).join(' ').trim() ||
    '(unnamed)'

  const emails = collectStrings([
    raw.email,
    raw.primary_email,
    ...arr(raw.emails).map((e) =>
      typeof e === 'string' ? e : asString(rec(e).address ?? rec(e).value ?? rec(e).email),
    ),
  ])

  const phones = collectStrings([
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
      raw.street ?? raw.street_address ?? raw.address1 ?? raw.address_line_1 ?? raw.line1,
    ),
    city: asString(raw.city ?? raw.locality),
    region: asString(raw.state ?? raw.region ?? raw.province),
    postalCode: asString(raw.zip ?? raw.postal_code ?? raw.zipcode ?? raw.postcode),
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
