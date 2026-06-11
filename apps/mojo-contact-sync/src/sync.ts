import type { MatchStrategy } from './config'
import type { BrivityPerson } from './lib/brivity'
import type { ContactFieldAdditions, GoogleContact, GoogleContactsClient } from './lib/google'
import type { StructuredAddress } from './lib/address'
import { containsAddress, dedupeAddresses, isEmptyAddress } from './lib/address'
import { normalizeEmail, normalizePhone, phoneKey } from './lib/identity'

export type PlanAction =
  | 'add'
  | 'skip_present'
  | 'skip_no_match'
  | 'skip_ambiguous'
  | 'skip_no_data'

export interface PlanItem {
  brivityId: string
  brivityName: string
  action: PlanAction
  matchedBy?: 'phone' | 'email'
  contactResourceName?: string
  contactName?: string
  /** Present on `add`: the missing values to append. */
  additions?: ContactFieldAdditions
  /** Present on `skip_ambiguous`: the conflicting candidate contacts. */
  candidates?: string[]
  reason?: string
}

export interface PlanSummary {
  contacts_to_update: number
  skip_present: number
  skip_no_match: number
  skip_ambiguous: number
  skip_no_data: number
  addresses_added: number
  emails_added: number
  phones_added: number
}

export interface Plan {
  generatedAt: string
  strategy: MatchStrategy
  label: string
  items: PlanItem[]
  summary: PlanSummary
}

export interface BuildPlanOptions {
  strategy: MatchStrategy
  label: string
  includeAddresses: boolean
  includeEmails: boolean
  includePhones: boolean
  /** When true, only consider the current/primary Brivity address. */
  primaryAddressOnly: boolean
}

// ---- matching index ----

interface ContactIndex {
  byPhone: Map<string, GoogleContact[]>
  byEmail: Map<string, GoogleContact[]>
}

function pushMap<T>(m: Map<string, T[]>, key: string, val: T): void {
  const existing = m.get(key)
  if (existing) existing.push(val)
  else m.set(key, [val])
}

function buildIndex(contacts: GoogleContact[]): ContactIndex {
  const byPhone = new Map<string, GoogleContact[]>()
  const byEmail = new Map<string, GoogleContact[]>()
  for (const c of contacts) {
    for (const p of c.phones) {
      const k = phoneKey(p)
      if (k) pushMap(byPhone, k, c)
    }
    for (const e of c.emails) {
      const n = normalizeEmail(e)
      if (n) pushMap(byEmail, n, c)
    }
  }
  return { byPhone, byEmail }
}

function uniqueContacts(
  person: BrivityPerson,
  index: ContactIndex,
  by: 'phone' | 'email',
): GoogleContact[] {
  const found = new Map<string, GoogleContact>()
  if (by === 'phone') {
    for (const p of person.phones) {
      const k = phoneKey(p)
      if (!k) continue
      for (const c of index.byPhone.get(k) ?? []) found.set(c.resourceName, c)
    }
  } else {
    for (const e of person.emails) {
      const n = normalizeEmail(e)
      if (!n) continue
      for (const c of index.byEmail.get(n) ?? []) found.set(c.resourceName, c)
    }
  }
  return [...found.values()]
}

function strategyOrder(strategy: MatchStrategy): Array<'phone' | 'email'> {
  switch (strategy) {
    case 'phone_then_email':
      return ['phone', 'email']
    case 'email_then_phone':
      return ['email', 'phone']
    case 'phone_only':
      return ['phone']
    case 'email_only':
      return ['email']
  }
}

function findCandidates(
  person: BrivityPerson,
  index: ContactIndex,
  strategy: MatchStrategy,
): { contacts: GoogleContact[]; matchedBy?: 'phone' | 'email' } {
  for (const by of strategyOrder(strategy)) {
    const contacts = uniqueContacts(person, index, by)
    if (contacts.length > 0) return { contacts, matchedBy: by }
  }
  return { contacts: [] }
}

function describeStrategy(s: MatchStrategy): string {
  switch (s) {
    case 'phone_then_email':
      return 'phone, then email'
    case 'email_then_phone':
      return 'email, then phone'
    case 'phone_only':
      return 'phone'
    case 'email_only':
      return 'email'
  }
}

// ---- per-field diffs (additive: only what's missing) ----

function missingAddresses(
  brivity: StructuredAddress[],
  existing: StructuredAddress[],
  primaryOnly: boolean,
): StructuredAddress[] {
  const nonEmpty = brivity.filter((a) => !isEmptyAddress(a))
  const source = primaryOnly
    ? nonEmpty.length > 0
      ? [nonEmpty[0] as StructuredAddress]
      : []
    : dedupeAddresses(nonEmpty)
  return source.filter((a) => !containsAddress(existing, a))
}

function missingValues(
  brivity: string[],
  existing: string[],
  keyOf: (s: string) => string,
): string[] {
  const have = new Set(existing.map(keyOf).filter((k) => k.length > 0))
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of brivity) {
    const k = keyOf(raw)
    if (!k || have.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(raw.trim())
  }
  return out
}

function computeAdditions(
  person: BrivityPerson,
  contact: GoogleContact,
  opts: BuildPlanOptions,
): ContactFieldAdditions {
  return {
    addresses: opts.includeAddresses
      ? missingAddresses(person.addresses, contact.addresses, opts.primaryAddressOnly)
      : [],
    emails: opts.includeEmails
      ? missingValues(person.emails, contact.emails, normalizeEmail)
      : [],
    phones: opts.includePhones ? missingValues(person.phones, contact.phones, phoneKey) : [],
  }
}

function additionsCount(a: ContactFieldAdditions): number {
  return a.addresses.length + a.emails.length + a.phones.length
}

function mergeAdditions(a: ContactFieldAdditions, b: ContactFieldAdditions): ContactFieldAdditions {
  return {
    addresses: dedupeAddresses([...a.addresses, ...b.addresses]),
    emails: missingValues([...a.emails, ...b.emails], [], normalizeEmail),
    phones: missingValues([...a.phones, ...b.phones], [], phoneKey),
  }
}

// ---- plan building ----

export function buildPlan(
  people: BrivityPerson[],
  contacts: GoogleContact[],
  opts: BuildPlanOptions,
): Plan {
  const index = buildIndex(contacts)
  const items: PlanItem[] = []

  for (const person of people) {
    const base = { brivityId: person.id, brivityName: person.name }

    const hasData =
      person.addresses.some((a) => !isEmptyAddress(a)) ||
      person.emails.length > 0 ||
      person.phones.length > 0
    if (!hasData) {
      items.push({ ...base, action: 'skip_no_data', reason: 'Brivity record has no syncable data' })
      continue
    }

    const { contacts: candidates, matchedBy } = findCandidates(person, index, opts.strategy)
    if (candidates.length === 0) {
      items.push({
        ...base,
        action: 'skip_no_match',
        reason: `No Google contact matched by ${describeStrategy(opts.strategy)}`,
      })
      continue
    }
    if (candidates.length > 1) {
      items.push({
        ...base,
        action: 'skip_ambiguous',
        matchedBy,
        candidates: candidates.map((c) => `${c.name} <${c.resourceName}>`),
        reason: `${candidates.length} Google contacts matched; skipped to avoid a wrong write`,
      })
      continue
    }

    const contact = candidates[0] as GoogleContact
    const additions = computeAdditions(person, contact, opts)
    const shared = {
      ...base,
      matchedBy,
      contactResourceName: contact.resourceName,
      contactName: contact.name,
    }
    if (additionsCount(additions) === 0) {
      items.push({ ...shared, action: 'skip_present', reason: 'All Brivity data already on contact' })
    } else {
      items.push({ ...shared, action: 'add', additions })
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    strategy: opts.strategy,
    label: opts.label,
    items,
    summary: summarize(items),
  }
}

function summarize(items: PlanItem[]): PlanSummary {
  const s: PlanSummary = {
    contacts_to_update: 0,
    skip_present: 0,
    skip_no_match: 0,
    skip_ambiguous: 0,
    skip_no_data: 0,
    addresses_added: 0,
    emails_added: 0,
    phones_added: 0,
  }
  for (const i of items) {
    switch (i.action) {
      case 'add':
        s.contacts_to_update++
        if (i.additions) {
          s.addresses_added += i.additions.addresses.length
          s.emails_added += i.additions.emails.length
          s.phones_added += i.additions.phones.length
        }
        break
      case 'skip_present':
        s.skip_present++
        break
      case 'skip_no_match':
        s.skip_no_match++
        break
      case 'skip_ambiguous':
        s.skip_ambiguous++
        break
      case 'skip_no_data':
        s.skip_no_data++
        break
    }
  }
  return s
}

// ---- applying ----

export interface ApplyResult {
  attempted: number
  succeeded: number
  failed: number
  errors: Array<{ contact: string; error: string }>
}

/**
 * Apply the `add` items. Additions are merged per contact and written in a
 * single updateContact call, so each contact's etag is used exactly once even
 * when two Brivity people map to the same Google contact (e.g. a couple).
 */
export async function applyPlan(
  plan: Plan,
  google: GoogleContactsClient,
  contactByResourceName: Map<string, GoogleContact>,
  label: string,
  limit?: number,
): Promise<ApplyResult> {
  const byContact = new Map<string, ContactFieldAdditions>()
  for (const item of plan.items) {
    if (item.action !== 'add' || !item.contactResourceName || !item.additions) continue
    const prev = byContact.get(item.contactResourceName)
    byContact.set(
      item.contactResourceName,
      prev ? mergeAdditions(prev, item.additions) : item.additions,
    )
  }

  let entries = [...byContact.entries()]
  if (typeof limit === 'number') entries = entries.slice(0, limit)

  const result: ApplyResult = { attempted: 0, succeeded: 0, failed: 0, errors: [] }
  for (const [resourceName, additions] of entries) {
    const contact = contactByResourceName.get(resourceName)
    if (!contact) {
      result.failed++
      result.errors.push({ contact: resourceName, error: 'contact not found in fetched set' })
      continue
    }
    result.attempted++
    try {
      await google.appendFields(contact, additions, label)
      result.succeeded++
    } catch (e) {
      result.failed++
      result.errors.push({
        contact: `${contact.name} <${resourceName}>`,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return result
}

/** Snapshot of existing fields for every contact the plan would touch. */
export function buildBackup(
  plan: Plan,
  contactByResourceName: Map<string, GoogleContact>,
): Array<{
  resourceName: string
  name: string
  etag: string
  addresses: unknown[]
  emailAddresses: unknown[]
  phoneNumbers: unknown[]
}> {
  const seen = new Set<string>()
  const backup = []
  for (const item of plan.items) {
    if (item.action !== 'add' || !item.contactResourceName) continue
    if (seen.has(item.contactResourceName)) continue
    seen.add(item.contactResourceName)
    const c = contactByResourceName.get(item.contactResourceName)
    if (c) {
      backup.push({
        resourceName: c.resourceName,
        name: c.name,
        etag: c.etag,
        addresses: c.rawAddresses,
        emailAddresses: c.rawEmails,
        phoneNumbers: c.rawPhones,
      })
    }
  }
  return backup
}
