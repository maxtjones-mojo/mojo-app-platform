# Cross-App Bridging

## MoJo Leads Bridge

Used by other MoJo apps to create leads in MoJo Leads (e.g. Vendor Network referral capture).

### pushLeadToMojoLeads

```typescript
// src/lib/mojo-leads-bridge.ts
interface MojoLeadInput {
  name: string
  email?: string
  phone?: string
  stage?: string        // defaults to 'lead'
  source: string        // e.g. 'vendor_app', 'deal_analyzer'
  notes?: string
  metadata?: Record<string, unknown>
}

export async function pushLeadToMojoLeads(input: MojoLeadInput): Promise<{
  success: boolean
  mojo_leads_id?: string
  error?: string
}> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  if (!serviceKey) {
    return { success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  // Normalize email/phone
  const normalizedEmail = input.email?.toLowerCase().trim() || null
  const normalizedPhone = input.phone?.replace(/\D/g, '') || null

  // Check for existing lead by email or phone
  let existingId: string | null = null
  if (normalizedEmail || normalizedPhone) {
    const queries = []
    if (normalizedEmail) queries.push(`email.ilike.${normalizedEmail}`)
    if (normalizedPhone) queries.push(`phone.ilike.%25${normalizedPhone}%25`)

    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .or(queries.join(','))
      .limit(1)
      .single()

    existingId = existing?.id || null
  }

  if (existingId) {
    // Update existing lead — don't create duplicate
    const { error } = await supabase
      .from('leads')
      .update({
        updated_at: new Date().toISOString(),
        metadata: {
          ...input.metadata,
          last_bridge_source: input.source,
          last_bridged_at: new Date().toISOString()
        }
      })
      .eq('id', existingId)

    return {
      success: !error,
      mojo_leads_id: existingId,
      error: error?.message
    }
  }

  // Create new lead
  const { data, error } = await supabase
    .from('leads')
    .insert({
      name: input.name,
      email: normalizedEmail,
      phone: normalizedPhone,
      stage: input.stage || 'lead',
      source: input.source,
      notes: input.notes || null,
      metadata: {
        ...input.metadata,
        bridged_from: input.source
      }
    })
    .select('id')
    .single()

  return {
    success: !error,
    mojo_leads_id: data?.id,
    error: error?.message
  }
}
```

### Usage in API Route

```typescript
// src/app/api/referrals/route.ts
import { pushLeadToMojoLeads } from '@/lib/mojo-leads-bridge'

export async function POST(request: NextRequest) {
  const { name, email, phone, notes } = await request.json()

  const result = await pushLeadToMojoLeads({
    name,
    email,
    phone,
    source: 'vendor_app',  // identifies the sending app
    notes,
    metadata: { referral_vendor_id: vendorId }
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    mojo_leads_id: result.mojo_leads_id
  })
}
```

## Shared Identity Layer

All MoJo apps should use the same contact normalization:

```typescript
// src/lib/identity.ts
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

export function matchContacts(a: {email?: string, phone?: string}, b: {email?: string, phone?: string}): 'email' | 'phone' | 'both' | null {
  const aEmail = normalizeEmail(a.email || '')
  const bEmail = normalizeEmail(b.email || '')
  const aPhone = normalizePhone(a.phone || '')
  const bPhone = normalizePhone(b.phone || '')

  const emailMatch = aEmail && bEmail && aEmail === bEmail
  const phoneMatch = aPhone && bPhone && aPhone === bPhone && aPhone.length >= 10

  if (emailMatch && phoneMatch) return 'both'
  if (emailMatch) return 'email'
  if (phoneMatch) return 'phone'
  return null
}
```
