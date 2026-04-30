# Supabase Schema Conventions

## Standard Table Pattern

Every MoJo table follows this exact pattern:

```sql
CREATE TABLE your_table (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  agent_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Your columns below
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  metadata    JSONB DEFAULT '{}'
);

-- Always have updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER your_table_updated_at
  BEFORE UPDATE ON your_table
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

## Row Level Security (RLS)

**Every table MUST have RLS enabled.** No exceptions.

```sql
ALTER TABLE your_table ENABLE ROW LEVEL SECURITY;

-- Agents see only their own rows
CREATE POLICY "Agents see own rows"
  ON your_table FOR ALL
  USING (agent_id = auth.uid());

-- Service role bypasses RLS (use only in server code)
```

## Standard UUID Pattern

Always use `gen_random_uuid()` for IDs. Never use serial integers.

## Soft Deletes

```sql
deleted_at TIMESTAMPTZ,
-- Then in policies:
CREATE POLICY "Agents see non-deleted"
  ON your_table FOR ALL
  USING (agent_id = auth.uid() AND deleted_at IS NULL);
```

## Enums

```sql
CREATE TYPE pipeline_stage AS ENUM (
  'lead', 'contacted', 'initial_consult', 'follow_up',
  'nurture', 'buyer_90_plus', 'showing_hot', 'listing_coming_soon',
  'active_listing', 'pending', 'closed', 'dead'
);
```

## Migrations File Naming

```
supabase/migrations/
  001_initial.sql           -- Base schema
  002_add_foo.sql           -- Additive changes
  003_add_bar_index.sql     -- Performance
  004_dead_column_cleanup.sql  -- Deletions last
```

Run in order. Never edit committed migrations.

## Env Var Names

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...   -- server-only, never expose
```

## Cross-App References

For tables that reference other MoJo apps (e.g. Vendor Network → MoJo Leads):

```sql
-- Use the shared UUID pattern so cross-app joins work
mojo_leads_id UUID REFERENCES mojo_leads(id) ON DELETE SET NULL
```
