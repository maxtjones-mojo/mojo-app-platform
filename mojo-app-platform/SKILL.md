---
name: mojo-app-platform
description: Bootstrap a new MoJo real estate app from concept to production. Triggers when Max says "new app", "build an app for MoJo", "spin up an app", "add a feature to the platform", or any request that implies building a new Next.js + Supabase application. Covers: project scaffolding, shared Supabase schema patterns, OTP auth, API routes, cross-app linking to MoJo Leads, and Vercel deployment wiring.
---

# MoJo App Platform

## Public Sharing Note

This skill is intentionally safe to share as a public scaffold. It should contain reusable patterns, placeholder env var names, and setup guidance only. Never commit real `.env` files, service-role keys, API keys, OAuth tokens, customer data, lead data, or private operational logs into this skill repo.

## What This Skill Does

Turns a concept into a production-ready Next.js 15 + TypeScript + Supabase app with the full MoJo plumbing already wired — auth, database, API routes, env vars, and deployment.

## Core Workflow

```
1. Concept → Scaffold (init-app.ts)
2. Data model → Supabase schema (references/schema.md)
3. Auth → OTP pattern (references/auth.md)
4. API routes → Standard patterns (references/api-routes.md)
5. Deployment → Vercel + GitHub (references/deployment.md)
6. Feature build → On top of solid base layer
```

## When to Use

- Max wants to build a new MoJo app
- Max describes a feature that needs a new app or new table/API
- Any greenfield web app request for the MoJo team

## Project Structure

Every MoJo app follows this structure:

```
apps/
  mojo-[name]/
    src/
      app/              # Next.js App Router pages
        (auth)/         # Auth routes (signin, confirm)
        api/            # API routes (server-only)
          leads/
          vendors/
        (main)/         # Protected app routes
      components/        # React components
      lib/
        supabase/
          client.ts     # Browser client (public anon key)
          server.ts    # Server client (service role)
          middleware.ts # Auth middleware
        types.ts
        identity.ts    # Shared contact dedupe logic
      hooks/            # Custom React hooks
    supabase/
      migrations/       # SQL migrations
      schema.sql        # Full schema reference
    public/
    .env.local
    next.config.ts
```

## Scaffolding a New App

```bash
node skills/mojo-app-platform/scripts/init-app.ts [app-name]

# Example:
node skills/mojo-app-platform/scripts/init-app.ts deal-analyzer
```

This creates `apps/mojo-deal-analyzer/` with:
- Next.js 15.5 + React 19 + TypeScript
- Supabase client/server libs pre-wired to MoJo's project
- OTP auth UI (sign-in page + confirm page)
- Standard folder structure
- Env vars configured
- Vercel-ready

## Supabase Schema Conventions

**Always use RLS.** Every table has `agent_id = auth.uid()` row policies.

Standard columns on every table:
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
created_at  TIMESTAMPTZ DEFAULT NOW(),
updated_at  TIMESTAMPTZ DEFAULT NOW(),
agent_id    UUID REFERENCES auth.users(id) -- RLS enforcement
```

See `references/schema.md` for full patterns.

## Auth

OTP-only. No magic links. No passwords.

Flow: email → OTP code → verify → session cookie.

See `references/auth.md` for the complete implementation pattern.

## API Routes

Always server-only (`route.ts` files). Never expose service role key to browser.

Standard patterns in `references/api-routes.md`.

## Deployment

GitHub repo → Vercel auto-deploy. Env vars via Vercel dashboard.

See `references/deployment.md` for wiring steps.

## Cross-App Linking

To push leads/referrals to MoJo Leads from another app:

```typescript
// In your API route
import { pushLeadToMojoLeads } from '@/lib/mojo-leads-bridge'

await pushLeadToMojoLeads({
  name, email, phone, stage: 'lead',
  source: 'vendor_app' // tracks origin
})
```

See `references/cross-app.md` for full bridge API.

## Key Constraints

- **No magic links** — iOS PWA + magic link = broken auth
- **Service role = server only** — never in browser code
- **RLS on every table** — even in dev
- **Env vars in Vercel** — not in code
- **Migrations over schema edits** — `supabase/migrations/` always
