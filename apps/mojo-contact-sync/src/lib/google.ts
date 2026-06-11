import type { StructuredAddress } from './address'

export interface GoogleContact {
  resourceName: string
  etag: string
  name: string
  emails: string[]
  phones: string[]
  /** Normalized addresses, used for comparison/dedupe. */
  addresses: StructuredAddress[]
  /** Original People API objects, preserved verbatim on write. */
  rawAddresses: Record<string, unknown>[]
  rawEmails: Record<string, unknown>[]
  rawPhones: Record<string, unknown>[]
}

/** Missing values to append to a single contact. */
export interface ContactFieldAdditions {
  addresses: StructuredAddress[]
  emails: string[]
  phones: string[]
}

interface GoogleClientOptions {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  accessToken?: string
}

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,addresses,metadata'

// Writable subfields per field type (everything else, e.g. `metadata`, is
// output-only and must not be sent back on update).
const WRITABLE_ADDRESS_KEYS = [
  'type',
  'formattedValue',
  'poBox',
  'streetAddress',
  'extendedAddress',
  'city',
  'region',
  'postalCode',
  'country',
  'countryCode',
] as const
const WRITABLE_EMAIL_KEYS = ['value', 'type', 'displayName'] as const
const WRITABLE_PHONE_KEYS = ['value', 'type'] as const

export class GoogleContactsClient {
  private readonly opts: GoogleClientOptions
  private token?: string

  constructor(opts: GoogleClientOptions) {
    this.opts = opts
  }

  private async accessToken(): Promise<string> {
    if (this.token) return this.token
    if (this.opts.accessToken) {
      this.token = this.opts.accessToken
      return this.token
    }
    const { clientId, clientSecret, refreshToken } = this.opts
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Missing Google OAuth credentials for refresh-token exchange.')
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) {
      throw new Error(
        `Google token exchange failed: ${res.status} ${await res.text().catch(() => '')}`,
      )
    }
    const json = (await res.json()) as { access_token?: string }
    if (!json.access_token) throw new Error('Google token exchange returned no access_token.')
    this.token = json.access_token
    return this.token
  }

  private async authed(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken()
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
  }

  /** List all of the authenticated account's contacts, following pagination. */
  async listContacts(): Promise<GoogleContact[]> {
    const contacts: GoogleContact[] = []
    let pageToken: string | undefined
    for (let guard = 0; guard < 1000; guard++) {
      const url = new URL('https://people.googleapis.com/v1/people/me/connections')
      url.searchParams.set('personFields', PERSON_FIELDS)
      url.searchParams.set('pageSize', '1000')
      if (pageToken) url.searchParams.set('pageToken', pageToken)

      const res = await this.authed(url.toString(), { method: 'GET' })
      if (!res.ok) {
        throw new Error(
          `Google connections.list failed: ${res.status} ${await res.text().catch(() => '')}`,
        )
      }
      const json = (await res.json()) as {
        connections?: Record<string, unknown>[]
        nextPageToken?: string
      }
      for (const p of json.connections ?? []) contacts.push(mapGoogleContact(p))
      pageToken = json.nextPageToken
      if (!pageToken) break
    }
    return contacts
  }

  /**
   * Append missing addresses / emails / phones to a contact, preserving every
   * existing value. The People API replaces each updated field wholesale, so we
   * resend existing values (sanitized to writable subfields) plus the new ones,
   * guarded by the contact's `etag`. Only fields with additions are updated.
   */
  async appendFields(
    contact: GoogleContact,
    additions: ContactFieldAdditions,
    addressLabel: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { etag: contact.etag }
    const updateFields: string[] = []

    if (additions.addresses.length > 0) {
      body.addresses = [
        ...contact.rawAddresses.map((a) => sanitize(a, WRITABLE_ADDRESS_KEYS)),
        ...additions.addresses.map((a) => toGoogleAddressBody(a, addressLabel)),
      ]
      updateFields.push('addresses')
    }
    if (additions.emails.length > 0) {
      body.emailAddresses = [
        ...contact.rawEmails.map((e) => sanitize(e, WRITABLE_EMAIL_KEYS)),
        ...additions.emails.map((value) => ({ value })),
      ]
      updateFields.push('emailAddresses')
    }
    if (additions.phones.length > 0) {
      body.phoneNumbers = [
        ...contact.rawPhones.map((p) => sanitize(p, WRITABLE_PHONE_KEYS)),
        ...additions.phones.map((value) => ({ value })),
      ]
      updateFields.push('phoneNumbers')
    }

    if (updateFields.length === 0) return

    const url = new URL(
      `https://people.googleapis.com/v1/${contact.resourceName}:updateContact`,
    )
    url.searchParams.set('updatePersonFields', updateFields.join(','))

    const res = await this.authed(url.toString(), {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(
        `Google updateContact failed for ${contact.resourceName}: ` +
          `${res.status} ${await res.text().catch(() => '')}`,
      )
    }
  }
}

function mapGoogleContact(p: Record<string, unknown>): GoogleContact {
  const names = asArray(p.names)
  const name = asString(rec(names[0]).displayName) ?? '(unnamed)'

  const rawEmails = asArray(p.emailAddresses).map(rec)
  const rawPhones = asArray(p.phoneNumbers).map(rec)
  const rawAddresses = asArray(p.addresses).map(rec)

  const emails = rawEmails.map((e) => asString(e.value)).filter((v): v is string => !!v)
  const phones = rawPhones.map((e) => asString(e.value)).filter((v): v is string => !!v)
  const addresses: StructuredAddress[] = rawAddresses.map((a) => ({
    street: asString(a.streetAddress),
    city: asString(a.city),
    region: asString(a.region),
    postalCode: asString(a.postalCode),
    country: asString(a.country),
    formatted: asString(a.formattedValue),
  }))

  return {
    resourceName: String(p.resourceName ?? ''),
    etag: String(p.etag ?? ''),
    name,
    emails,
    phones,
    addresses,
    rawAddresses,
    rawEmails,
    rawPhones,
  }
}

function sanitize(
  obj: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = obj[k]
    if (v != null && v !== '') out[k] = v
  }
  return out
}

function toGoogleAddressBody(a: StructuredAddress, label: string): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (a.street) body.streetAddress = a.street
  if (a.city) body.city = a.city
  if (a.region) body.region = a.region
  if (a.postalCode) body.postalCode = a.postalCode
  if (a.country) body.country = a.country
  // Only fall back to a single-line value when we have no structured street.
  if (a.formatted && !a.street) body.formattedValue = a.formatted
  if (label) body.type = label
  return body
}

// ---- small helpers ----

function asArray(v: unknown): unknown[] {
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
  return undefined
}
