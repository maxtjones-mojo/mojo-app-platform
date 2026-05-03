# Vercel + GitHub Deployment

## Initial Setup

### 1. Create GitHub Repo

```bash
cd apps/mojo-[name]
gh repo create maxtjones-mojo/mojo-[name] --private --push
```

Use `--public` only for intentionally shareable scaffold packages with no real environment files, tokens, client data, lead data, or private logs.

### 2. Link to Vercel

```bash
npm i -g vercel
vercel link [project-name]
```

Or via dashboard: Vercel → New Project → Import from GitHub → select repo.

### 3. Add Environment Variables

In Vercel dashboard → Project → Settings → Environment Variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...   (set for Production only, NOT preview)
BRIVITY_API_KEY=xxx               (server-only)
```

**Critical:** `SUPABASE_SERVICE_ROLE_KEY` must NOT be in `NEXT_PUBLIC_` and must be production-only (not exposed to preview deploys).

### 4. Add .gitignore

```gitignore
# Supabase
.env
.env.local
.env.*.local

# Vercel
.vercel

# Build
.next
out
dist

# OS
.DS_Store
Thumbs.db
```

## Standard CI/CD Flow

1. Push to `main` branch → Vercel auto-deploys to production
2. Open a PR → Vercel creates preview deployment

No manual deploys needed after initial setup.

## Custom Domain (optional)

In Vercel dashboard → Domains → Add: `leads.mojokc.com`

DNS: Add `CNAME` record pointing to `cname.vercel-dns.com`

## Supabase Migration on Deploy

Migrations run manually via Supabase dashboard or CI script:

```bash
# In deploy pipeline or post-deploy hook
npx supabase db push --project-ref your-ref
```

Or via the Supabase CLI in CI:

```bash
npx supabase login --token $SUPABASE_ACCESS_TOKEN
npx supabase db push --project-ref $SUPABASE_PROJECT_REF
```

Store `SUPABASE_ACCESS_TOKEN` in Vercel env vars (not `NEXT_PUBLIC_`).

## Rollback

Vercel dashboard → Deployments → find last working deployment → "..." → Promote to Production.

## Adding a New Env Var

1. Add to Vercel dashboard (all environments or specific)
2. Redeploy (or Vercel auto-redeploys on next push if using Preview)

## Health Check

```typescript
// src/app/api/health/route.ts
import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({ status: 'ok', ts: Date.now() })
}
```
