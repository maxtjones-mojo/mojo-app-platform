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

/** A phone number is only a reliable match key once it has enough digits. */
export function isUsablePhone(normalized: string): boolean {
  return normalized.length >= 10
}
