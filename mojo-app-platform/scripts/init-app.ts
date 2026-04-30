#!/usr/bin/env node
/**
 * mojo-app-platform: init-app.ts
 *
 * Scaffolds a new MoJo app with the full platform plumbing pre-wired:
 * - Next.js 15.5 + React 19 + TypeScript
 * - Supabase client + server libs
 * - OTP auth UI (signin + confirm pages)
 * - Standard folder structure
 * - Env vars configured
 * - Vercel-ready
 *
 * Usage:
 *   node scripts/init-app.ts [app-name]
 *   node scripts/init-app.ts deal-analyzer
 *
 * The app lands at apps/mojo-[app-name]/
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../') // workspace root
const APPS_DIR = join(ROOT, 'apps')

const name = process.argv[2]?.toLowerCase().replace(/[^a-z0-9-]/g, '-')

if (!name) {
  console.error('Usage: node scripts/init-app.ts [app-name]')
  console.error('Example: node scripts/init-app.ts deal-analyzer')
  process.exit(1)
}

const APP_DIR = join(APPS_DIR, `mojo-${name}`)

if (existsSync(APP_DIR)) {
  console.error(`Error: apps/mojo-${name} already exists`)
  process.exit(1)
}

// ─── Step 1: Create Next.js app ───────────────────────────────────────────
console.log(`\n🔧 Creating Next.js app: mojo-${name}`)
execSync(
  `npx --yes create-next-app@latest mojo-${name} ` +
  `--typescript --tailwind --eslint --app --src-dir ` +
  `--import-alias "@/*" --no-git --yes`,
  { cwd: APPS_DIR }
)

// ─── Step 2: Install Supabase dependencies ─────────────────────────────────
console.log('📦 Installing Supabase dependencies')
execSync('npm install @supabase/supabase-js @supabase/ssr', { cwd: APP_DIR })

// ─── Step 3: Create standard folder structure ──────────────────────────────
console.log('📁 Creating standard folder structure')
const dirs = [
  'src/lib/supabase',
  'src/app/signin',
  'src/app/confirm',
  'src/app/(auth)',
  'src/app/(main)',
  'src/components',
  'src/hooks',
  'supabase/migrations',
]
dirs.forEach(d => mkdirSync(join(APP_DIR, d), { recursive: true }))

// ─── Step 4: Write Supabase client libs ───────────────────────────────────
writeFileSync(join(APP_DIR, 'src/lib/supabase/client.ts'), `\
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export function createClient() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  })
}
`)

writeFileSync(join(APP_DIR, 'src/lib/supabase/server.ts'), `\
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Server-side only — never expose to browser
export function createServerClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  })
}
`)

writeFileSync(join(APP_DIR, 'src/lib/supabase/middleware.ts'), `\
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
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
            request: { headers: request.headers },
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Protect /app routes
  if (!user && request.nextUrl.pathname.startsWith('/app')) {
    return NextResponse.redirect(new URL('/signin', request.url))
  }

  return supabaseResponse
}
`)

// ─── Step 5: Write middleware.ts ────────────────────────────────────────────
writeFileSync(join(APP_DIR, 'src/middleware.ts'), `\
import { updateSession } from '@/lib/supabase/middleware'
import { type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: ['/app/:path*', '/dashboard/:path*'],
}
`)

// ─── Step 6: Write OTP auth pages ───────────────────────────────────────────
writeFileSync(join(APP_DIR, 'src/app/signin/page.tsx'), `\
'use client'

import { createClient } from '@/lib/supabase/client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function SignIn() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    })
    if (error) {
      setError(error.message)
    } else {
      setSent(true)
    }
  }

  if (sent) {
    return (
      <div style={{ padding: '2rem', maxWidth: '400px', margin: 'auto' }}>
        <h2>Check your email</h2>
        <p>Sent a code to <strong>{email}</strong></p>
        <a href={\`/confirm?email=\${encodeURIComponent(email)}\`}>
          Enter code →
        </a>
      </div>
    )
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '400px', margin: 'auto' }}>
      <h1>Sign in to MoJo</h1>
      <form onSubmit={handleSendOtp}>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          style={{ width: '100%', padding: '0.75rem', marginBottom: '1rem' }}
        />
        <button type="submit" style={{ width: '100%', padding: '0.75rem' }}>
          Send code
        </button>
        {error && <p style={{ color: 'red', marginTop: '1rem' }}>{error}</p>}
      </form>
    </div>
  )
}
`)

writeFileSync(join(APP_DIR, 'src/app/confirm/page.tsx'), `\
'use client'

import { createClient } from '@/lib/supabase/client'
import { useState } from 'react'
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
      type: 'email',
    })
    if (error) {
      setError('Invalid code. Try again or request a new one.')
    } else {
      router.push('/app')
    }
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '400px', margin: 'auto' }}>
      <h1>Enter your code</h1>
      <p>Sent to <strong>{email}</strong></p>
      <form onSubmit={handleVerify}>
        <input
          type="text"
          value={code}
          onChange={e => setCode(e.target.value.slice(0, 10))}
          maxLength={10}
          placeholder="12345678"
          autoFocus
          required
          style={{ width: '100%', padding: '0.75rem', marginBottom: '1rem', fontSize: '1.5rem', letterSpacing: '0.2em', textAlign: 'center' }}
        />
        <button type="submit" style={{ width: '100%', padding: '0.75rem' }}>
          Verify
        </button>
        {error && <p style={{ color: 'red', marginTop: '1rem' }}>{error}</p>}
      </form>
    </div>
  )
}
`)

// ─── Step 7: Write types.ts ─────────────────────────────────────────────────
writeFileSync(join(APP_DIR, 'src/lib/types.ts'), `\
// Shared types for mojo-${name}
export interface BaseEntity {
  id: string
  created_at: string
  updated_at: string
  agent_id: string
}

export interface ApiResponse<T> {
  data?: T
  error?: string
  details?: unknown
}
`)

// ─── Step 8: Write .env.local ────────────────────────────────────────────────
writeFileSync(join(APP_DIR, '.env.local'), `\
# Supabase — copy values from MoJo Leads .env.local or Vercel project
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Server-only (never expose to browser)
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# External APIs
BRIVITY_API_KEY=your-brivity-api-key
`)

// ─── Step 9: Write next.config.ts (ensure it's compatible) ──────────────────
const nextConfigPath = join(APP_DIR, 'next.config.ts')
if (existsSync(nextConfigPath)) {
  // Already created by create-next-app, leave it
}

// ─── Step 10: Write initial migration ────────────────────────────────────────
writeFileSync(join(APP_DIR, 'supabase/migrations/001_initial.sql'), `\
-- mojo-${name}: initial schema
-- Run this in Supabase SQL Editor after first deploy

CREATE TABLE IF NOT EXISTS items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  agent_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  notes       TEXT,
  metadata    JSONB DEFAULT '{}'
);

ALTER TABLE items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents manage own items"
  ON items FOR ALL
  USING (agent_id = auth.uid());

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER items_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`)

// ─── Step 11: Git init + first commit ───────────────────────────────────────
console.log('📦 Initializing git + pushing to GitHub')
execSync('git init', { cwd: APP_DIR })
execSync('git add .', { cwd: APP_DIR })
execSync('git commit -m "Initial scaffold: mojo-${name} with MoJo platform plumbing"', { cwd: APP_DIR })
execSync(`gh repo create maxtjones-mojo/mojo-${name} --public --push`, { cwd: APP_DIR })

// ─── Done ───────────────────────────────────────────────────────────────────
console.log(`
✅ mojo-${name} scaffolded and pushed to GitHub!

Location: apps/mojo-${name}/
Repo:     https://github.com/maxtjones-mojo/mojo-${name}

Next steps:
1. Add env vars to Vercel project:
   - NEXT_PUBLIC_SUPABASE_URL
   - NEXT_PUBLIC_SUPABASE_ANON_KEY
   - SUPABASE_SERVICE_ROLE_KEY (Production only)
   - BRIVITY_API_KEY

2. Run initial migration in Supabase SQL Editor:
   ${APP_DIR}/supabase/migrations/001_initial.sql

3. Link Vercel: vercel link --project mojo-${name}
   Then push to main → auto-deploys

4. Describe the concept → we build features on top of the base layer!
`)
