import type { MatchStrategy } from './config'
import type { BrivityPerson } from './lib/brivity'
import type { GoogleContact, GoogleContactsClient } from './lib/google'
import type { StructuredAddress } from './lib/address'
import { addressKey, containsAddress, dedupeAddresses, formatAddress, isEmptyAddress } from './lib/address'
import { isUsablePhone, normalizeEmail, normalizePhone } from './lib/identity'

export type PlanAction =
  | 'add'
  | 'skip_present'
  | 'skip_no_match'
  | 'skip_ambiguous'
  | 'skip_no_address'

export interface PlanItem {
  brivityId: string
  brivityName: string
  action: PlanAction
  matchedBy?: 'phone' | 'email'
  contactResourceName?: string
  contactName?: string
  address?: StructuredAddress
  addressText?: string
  candidates?: string[]
  reason?: string
}

export interface Plan {
  generatedAt: string
  strategy: MatchStrategy
  label: string
  items: PlanItem[]
  summary: Record<PlanAction, number>
}

export interface BuildPlanOptions {
  strategy: MatchStrategy
  label: string
  /** When true, queue every Brivity address missing from the contact, not just the primary. */
  allAddresses: boolean
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
      const n = normalizePhone(p)
      if (isUsablePhone(n)) pushMap(byPhone, n, c)
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
      const n = normalizePhone(p)
      if (!isUsablePhone(n)) continue
      for (const c of index.byPhone.get(n) ?? []) found.set(c.resourceName, c)
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

/** Pick which Brivity addresses to consider. First address = current/primary. */
function selectAddresses(person: BrivityPerson, all: boolean): StructuredAddress[] {
  const nonEmpty = person.addresses.filter((a) => !isEmptyAddress(a))
  if (nonEmpty.length === 0) return []
  if (all) return dedupeAddresses(nonEmpty)
  return [nonEmpty[0] as StructuredAddress]
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

    const addresses = selectAddresses(person, opts.allAddresses)
    if (addresses.length === 0) {
      items.push({ ...base, action: 'skip_no_address', reason: 'Brivity record has no address' })
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
    for (const address of addresses) {
      const shared = {
        ...base,
        matchedBy,
        contactResourceName: contact.resourceName,
        contactName: contact.name,
        address,
        addressText: formatAddress(address),
      }
      if (containsAddress(contact.addresses, address)) {
        items.push({ ...shared, action: 'skip_present', reason: 'Address already on contact' })
      } else {
        items.push({ ...shared, action: 'add' })
      }
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

function summarize(items: PlanItem[]): Record<PlanAction, number> {
  const s: Record<PlanAction, number> = {
    add: 0,
    skip_present: 0,
    skip_no_match: 0,
    skip_ambiguous: 0,
    skip_no_address: 0,
  }
  for (const i of items) s[i.action]++
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
 * Apply the `add` items. Additions are grouped per contact and written in a
 * single updateContact call, so each contact's etag is used exactly once
 * (avoids stale-etag failures when a contact gets multiple addresses).
 */
export async function applyPlan(
  plan: Plan,
  google: GoogleContactsClient,
  contactByResourceName: Map<string, GoogleContact>,
  label: string,
  limit?: number,
): Promise<ApplyResult> {
  const byContact = new Map<string, StructuredAddress[]>()
  for (const item of plan.items) {
    if (item.action !== 'add' || !item.contactResourceName || !item.address) continue
    pushMap(byContact, item.contactResourceName, item.address)
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
      await google.appendAddresses(contact, additions, label)
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

/** Snapshot of the existing addresses for every contact the plan would touch. */
export function buildBackup(
  plan: Plan,
  contactByResourceName: Map<string, GoogleContact>,
): Array<{ resourceName: string; name: string; etag: string; addresses: unknown[] }> {
  const seen = new Set<string>()
  const backup: Array<{ resourceName: string; name: string; etag: string; addresses: unknown[] }> = []
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
      })
    }
  }
  return backup
}

// Re-exported for callers that want to dedupe/compare outside the planner.
export { addressKey }
