# mojo-contact-sync

Add **missing data from Brivity** — addresses, emails, and phone numbers — to
your **Google Contacts**, additively.

For each Brivity person it finds the matching Google contact and **appends**
anything Brivity has that the contact is missing. It never edits or removes an
existing value, and it's safe to run repeatedly.

- **Additive only** — appends missing addresses / emails / phones; existing
  values are untouched.
- **Idempotent** — skips anything already present (phones compared on the last
  10 digits, so formatting and country codes don't cause duplicates). Run it a
  few times a year.
- **Preview-first** — dry run by default. Nothing is written until `--confirm`.
- **Isolated** — standalone CLI. Does not touch the MoJo Leads app, its
  database, or Brivity itself (v1 is one-directional: Brivity → Google).

## How it works

1. Pulls all your Google contacts and all Brivity people (addresses, emails,
   phones).
2. Matches each Brivity person to a Google contact — **phone first, then email**
   by default (configurable). Ambiguous matches (more than one contact) are
   skipped and listed for manual review, never guessed.
3. For each match, computes what Brivity has that the contact is missing and
   queues those additions.
4. Prints a report + writes a plan file. With `--confirm`, it backs up the
   touched contacts' existing fields, then appends the new values (one
   updateContact call per contact, guarded by the contact's etag).

## Setup

> Run this on the machine where your keys live (e.g. the Hermes Mac mini), not in
> a cloud session.

```bash
cd apps/mojo-contact-sync
npm install
cp .env.example .env   # then fill in the values
```

### Brivity

```
BRIVITY_API_KEY=...                              # required
BRIVITY_API_BASE=https://api.brivity.com/api/v2  # override only if different
```

> **Verify the Brivity field mapping first.** The read-people endpoint and field
> names are defensively assumed in `src/lib/brivity.ts`. Run `npm run dump-brivity`
> to print a few real records, and adjust `mapBrivityPerson` if the field names
> differ. This is the one spot most likely to need a tweak for your tenant.

### Google Contacts (People API)

You need an OAuth client on the `https://www.googleapis.com/auth/contacts` scope
and a refresh token for the account whose contacts you're updating
(e.g. `maxtjones@gmail.com`):

1. Google Cloud Console → enable the **People API**.
2. Create an **OAuth 2.0 Client ID** (Desktop app is simplest).
3. Get a refresh token (quickest path: [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
   → gear icon → "Use your own OAuth credentials" → authorize the
   `.../auth/contacts` scope → exchange for tokens).

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
# or, to skip the refresh exchange, paste a short-lived token:
GOOGLE_ACCESS_TOKEN=...
```

## Usage

```bash
# 1. Confirm Brivity fields look right
npm run dump-brivity

# 2. Preview (dry run) — shows every proposed add, writes out/plan-*.json
npm run sync

# 3. Apply cautiously to the first 5 contacts
npm run sync -- --confirm --limit 5

# 4. Apply to everyone
npm run sync -- --confirm
```

By default it adds **all** missing addresses, emails, and phone numbers.

### Options

| Flag | Description |
| --- | --- |
| `--confirm` | Actually write to Google Contacts (default is dry run). |
| `--limit N` | On apply, only modify the first N contacts (cautious batch). |
| `--primary-address-only` | Only add the current/primary address (default: all missing addresses). |
| `--no-addresses` | Don't sync addresses. |
| `--no-emails` | Don't sync email addresses. |
| `--no-phones` | Don't sync phone numbers. |
| `--label TEXT` | Label for added addresses (default `Home`). |
| `--strategy NAME` | `phone_then_email` \| `email_then_phone` \| `phone_only` \| `email_only`. |
| `--dump-brivity` | Print raw Brivity records and exit. |
| `-h, --help` | Show help. |

### Output & safety

- `out/plan-<timestamp>.json` — the full plan (every add/skip + reason).
- `out/backup-<timestamp>.json` — existing addresses, emails, and phones of every
  contact touched, written **before** any change, so edits are reversible.
- `out/` is git-ignored (contains contact PII).

## Rolling it out to other agents

Each agent runs against **their own** Google account and Brivity key (the tool
reads them from that user's env), so it's per-user by design. For a click-to-run
experience for less-technical agents, the core logic in `src/sync.ts` is written
to lift into the platform's Next.js "review app" pattern (OTP sign-in + approve
changes in a UI) without a rewrite.

## Future: reverse / bidirectional sync

v1 is intentionally one-way (Brivity → Google). The Brivity and Google clients
are structured as symmetric read/write clients, so a `google → brivity` direction
can be added later. True bidirectional sync additionally needs conflict-resolution
rules (source-of-truth per field, loop prevention, delete handling) — deliberately
out of scope for this additive v1.
