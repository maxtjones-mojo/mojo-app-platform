/** A postal address in a source-agnostic shape. */
export interface StructuredAddress {
  street?: string
  city?: string
  region?: string // state / province
  postalCode?: string
  country?: string
  formatted?: string // single-line fallback when structured parts are missing
}

const onlyAlnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Canonical key for equality / dedupe. Prefers structured parts; falls back to
 * the single-line `formatted` value when no structured parts exist.
 */
export function addressKey(a: StructuredAddress): string {
  const structured = [a.street, a.city, a.region, a.postalCode, a.country]
    .filter((p): p is string => !!p && p.trim().length > 0)
    .map(onlyAlnum)
    .join('|')
  if (structured) return structured
  return onlyAlnum(a.formatted ?? '')
}

export function isEmptyAddress(a: StructuredAddress): boolean {
  return addressKey(a).length === 0
}

export function addressesEqual(a: StructuredAddress, b: StructuredAddress): boolean {
  const ka = addressKey(a)
  return ka.length > 0 && ka === addressKey(b)
}

/** True if `list` already contains an address equivalent to `a`. */
export function containsAddress(list: StructuredAddress[], a: StructuredAddress): boolean {
  return list.some((x) => addressesEqual(x, a))
}

export function dedupeAddresses(list: StructuredAddress[]): StructuredAddress[] {
  const seen = new Set<string>()
  const out: StructuredAddress[] = []
  for (const a of list) {
    const k = addressKey(a)
    if (k && !seen.has(k)) {
      seen.add(k)
      out.push(a)
    }
  }
  return out
}

export function formatAddress(a: StructuredAddress): string {
  const parts = [a.street, a.city, a.region, a.postalCode, a.country].filter(
    (p): p is string => !!p && p.trim().length > 0,
  )
  if (parts.length > 0) return parts.join(', ')
  return a.formatted ?? '(empty)'
}
