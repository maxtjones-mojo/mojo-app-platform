# API Route Patterns

## Core Rules

1. **Server-only** — `route.ts` files run on the server. Never import browser client here.
2. **Validate auth** — Check `auth.uid()` before any write.
3. **Service role for writes** — Use `createServerClient()` when you need to bypass RLS (admin ops).
4. **Return consistent shape** — Always return `{ data, error }` or structured response.

## Standard Route Pattern

```typescript
// src/app/api/resource/route.ts
import { createServerClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// GET /api/resource
export async function GET(request: NextRequest) {
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('resource')
    .select('*')
    .eq('agent_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

// POST /api/resource
export async function POST(request: NextRequest) {
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()

  const { data, error } = await supabase
    .from('resource')
    .insert({ ...body, agent_id: user.id })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ data }, { status: 201 })
}
```

## Route with ID Parameter

```typescript
// src/app/api/resource/[id]/route.ts
import { createServerClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('resource')
    .select('*')
    .eq('id', id)
    .eq('agent_id', user.id)  // Enforce ownership
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ data })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()

  const { data, error } = await supabase
    .from('resource')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('agent_id', user.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ data })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { error } = await supabase
    .from('resource')
    .delete()
    .eq('id', id)
    .eq('agent_id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
```

## External API Calls (Brivity, Google, etc.)

```typescript
// Always use server-side env var for API keys
const BRIVITY_API_KEY = process.env.BRIVITY_API_KEY!

export async function pushToBrivity(payload: BrivityLead) {
  const response = await fetch('https://api.brivity.com/api/v2/leads', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BRIVITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    throw new Error(`Brivity API error: ${response.status}`)
  }

  return response.json()
}
```

## Error Handling

```typescript
// Consistent error shape
interface ApiResponse<T> {
  data?: T
  error?: string
  details?: unknown
}

// Always return structured response
return NextResponse.json({ data }, { status: 200 })
return NextResponse.json({ error: 'Not found' }, { status: 404 })
return NextResponse.json({ error: error.message }, { status: 400 })
```
