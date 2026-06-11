/**
 * Shared contact-identity normalization.
 *
 * Mirrors the platform's `src/lib/identity.ts` pattern (see
 * references/cross-app.md). Copied — not imported — so this tool stays fully
 * isolated from the MoJo Leads app.
 */

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

/**
 * Comparable phone key: the last 10 digits, so the same number compares equal
 * regardless of formatting or a leading country code (e.g. "+1 816-555-1234"
 * and "8165551234" both key to "8165551234"). Empty when too short to trust.
 */
export function phoneKey(phone: string): string {
  const digits = normalizePhone(phone)
  if (digits.length < 10) return ''
  return digits.slice(-10)
}
