# OTP Auth Pattern

## Why OTP (not magic links)

iOS PWAs run in a different cookie jar than Safari. Magic links open Safari to click the link, then the PWA can't read the session cookie. OTP solves this by entering a code in-app.

## Files to Create

```
src/app/signin/page.tsx      # Email entry + send OTP
src/app/confirm/page.tsx     # OTP code entry + verify
src/app/layout.tsx            # Auth session provider
src/lib/supabase/
  client.ts                   # Browser Supabase client
  server.ts                   # Service role client
  middleware.ts               # Route protection
```

## Sign-in Page (email → send OTP)

```typescript
// src/app/signin/page.tsx
'use client'
import { createClient } from '@/lib/supabase/client'
import { useState } from 'react'

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true }
    })
    if (!error) setSent(true)
  }

  if (sent) {
    return (
      <div>
        <p>Check {email} for your code</p>
        <a href={`/confirm?email=${encodeURIComponent(email)}`}>
          Enter code
        </a>
      </div>
    )
  }

  return (
    <form onSubmit={handleSendOtp}>
      <input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="your@email.com"
        required
      />
      <button type="submit">Send code</button>
    </form>
  )
}
```

## Confirm Page (OTP → session)

```typescript
// src/app/confirm/page.tsx
'use client'
import { createClient } from '@/lib/supabase/client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function Confirm() {
  const router = useRouter()
  const params = useSearchParams()
  const email = params.get('email') || ''
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    const supabase = createClient()
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email'
    })
    if (!error) router.push('/')
    else setError('Invalid code')
  }

  return (
    <form onSubmit={handleVerify}>
      <p>Enter the 8-digit code sent to {email}</p>
      <input
        type="text"
        value={code}
        onChange={e => setCode(e.target.value.slice(0, 10))}
        maxLength={10}
        placeholder="12345678"
        autoFocus
        required
      />
      <button type="submit">Verify</button>
      {error && <p style={{color:'red'}}>{error}</p>}
    </form>
  )
}
```

## Supabase Client Lib

```typescript
// src/lib/supabase/client.ts
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export function createClient() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true
    }
  })
}
```

## Server Client (service role — API routes only)

```typescript
// src/lib/supabase/server.ts
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Only for use in Server Components and API routes
export function createServerClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false }
  })
}
```

## Route Protection (middleware)

```typescript
// src/middleware.ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({
            request: { headers: request.headers }
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        }
      }
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Protect /dashboard and /app routes
  if (!user && request.nextUrl.pathname.startsWith('/app')) {
    return NextResponse.redirect(new URL('/signin', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/app/:path*', '/dashboard/:path*']
}
```

## Supabase Email Template Setup

In Supabase Dashboard → Authentication → Email Templates:

```
Confirm signup:
{{ .Token }} is your MoJo verification code.
```

This triggers `signInWithOtp` → sends code directly, no email template customization needed beyond the token.
