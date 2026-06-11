import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertBrivityConfig,
  assertGoogleConfig,
  loadConfig,
  MATCH_STRATEGIES,
  type MatchStrategy,
} from './config'
import { BrivityClient } from './lib/brivity'
import { GoogleContactsClient, type GoogleContact } from './lib/google'
import { formatAddress } from './lib/address'
import { applyPlan, buildBackup, buildPlan, type Plan, type PlanItem } from './sync'

interface CliOptions {
  confirm: boolean
  dumpBrivity: boolean
  primaryAddressOnly: boolean
  noAddresses: boolean
  noEmails: boolean
  noPhones: boolean
  limit?: number
  label?: string
  strategy?: MatchStrategy
  help: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const has = (flag: string): boolean => argv.includes(flag)
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }

  const limitRaw = valueOf('--limit')
  const limit = limitRaw != null ? Number.parseInt(limitRaw, 10) : undefined
  const strategyRaw = valueOf('--strategy') as MatchStrategy | undefined

  return {
    confirm: has('--confirm'),
    dumpBrivity: has('--dump-brivity'),
    primaryAddressOnly: has('--primary-address-only'),
    noAddresses: has('--no-addresses'),
    noEmails: has('--no-emails'),
    noPhones: has('--no-phones'),
    limit: Number.isFinite(limit) ? limit : undefined,
    label: valueOf('--label'),
    strategy: strategyRaw && MATCH_STRATEGIES.includes(strategyRaw) ? strategyRaw : undefined,
    help: has('--help') || has('-h'),
  }
}

const HELP = `
mojo-contact-sync — add missing Brivity data to your Google Contacts.

Adds missing addresses, emails, and phone numbers from Brivity to the matching
Google contact. Additive only: it never edits or removes an existing value,
only appends a missing one. Dry run by default — nothing is written until
you pass --confirm.

USAGE
  npm run sync                 # preview (dry run): show what would change
  npm run sync -- --confirm    # apply the changes to Google Contacts
  npm run dump-brivity         # print a few raw Brivity records to verify fields

OPTIONS
  --confirm               Actually write to Google Contacts (default is dry run).
  --limit N               On apply, only modify the first N contacts.
  --primary-address-only  Only add the current/primary address (default: all
                          missing addresses).
  --no-addresses          Don't sync addresses.
  --no-emails             Don't sync email addresses.
  --no-phones             Don't sync phone numbers.
  --label TEXT            Label for added addresses (default: "Home").
  --strategy NAME         Match strategy: ${MATCH_STRATEGIES.join(' | ')}
                          (default from MATCH_STRATEGY env, else phone_then_email).
  --dump-brivity          Print raw Brivity records and exit (no Google access).
  -h, --help              Show this help.

Plans and pre-change backups are written to ./out/ (git-ignored — they contain
contact PII).
`

function fmtSummary(plan: Plan): string {
  const s = plan.summary
  return [
    `  contacts to update:    ${s.contacts_to_update}`,
    `    · addresses to add:  ${s.addresses_added}`,
    `    · emails to add:     ${s.emails_added}`,
    `    · phones to add:     ${s.phones_added}`,
    `  already complete:      ${s.skip_present}`,
    `  no Google match:       ${s.skip_no_match}`,
    `  ambiguous (skipped):   ${s.skip_ambiguous}`,
    `  no data in Brivity:    ${s.skip_no_data}`,
  ].join('\n')
}

function printPlanDetail(items: PlanItem[]): void {
  const adds = items.filter((i) => i.action === 'add')
  if (adds.length === 0) {
    console.log('\nNothing to add.')
    return
  }
  console.log(`\nContacts to update (${adds.length}):`)
  for (const i of adds) {
    const a = i.additions!
    console.log(`  • ${i.contactName}  [matched by ${i.matchedBy}]`)
    for (const addr of a.addresses) console.log(`      + address: ${formatAddress(addr)}`)
    for (const e of a.emails) console.log(`      + email:   ${e}`)
    for (const p of a.phones) console.log(`      + phone:   ${p}`)
  }
}

function printAttention(items: PlanItem[]): void {
  const ambiguous = items.filter((i) => i.action === 'skip_ambiguous')
  if (ambiguous.length > 0) {
    console.log(`\nNeeds manual review — ambiguous matches (${ambiguous.length}):`)
    for (const i of ambiguous) {
      console.log(`  • ${i.brivityName} (Brivity ${i.brivityId}) → ${i.candidates?.join('; ')}`)
    }
  }
}

function writeJson(dir: string, name: string, data: unknown): string {
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, name)
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
  return path
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }

  const config = loadConfig()
  const strategy = opts.strategy ?? config.matchStrategy
  const label = opts.label ?? config.addressLabel
  const outDir = resolve(process.cwd(), 'out')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  // --- Brivity-only inspection mode ---
  if (opts.dumpBrivity) {
    assertBrivityConfig(config)
    const brivity = new BrivityClient(config.brivity)
    console.log(JSON.stringify(await brivity.dumpRawPage(), null, 2))
    return
  }

  assertBrivityConfig(config)
  assertGoogleConfig(config)

  const brivity = new BrivityClient(config.brivity)
  const google = new GoogleContactsClient(config.google)

  console.log('Fetching Brivity people and Google contacts…')
  const [people, contacts] = await Promise.all([brivity.listPeople(), google.listContacts()])
  console.log(`  Brivity people:  ${people.length}`)
  console.log(`  Google contacts: ${contacts.length}`)

  const plan = buildPlan(people, contacts, {
    strategy,
    label,
    includeAddresses: !opts.noAddresses,
    includeEmails: !opts.noEmails,
    includePhones: !opts.noPhones,
    primaryAddressOnly: opts.primaryAddressOnly,
  })

  console.log(`\nStrategy: ${strategy}   Address label: "${label}"`)
  console.log('Summary:')
  console.log(fmtSummary(plan))
  printPlanDetail(plan.items)
  printAttention(plan.items)

  const planPath = writeJson(outDir, `plan-${stamp}.json`, plan)
  console.log(`\nFull plan written to ${planPath}`)

  if (!opts.confirm) {
    console.log('\nDRY RUN — no changes were made. Re-run with --confirm to apply.')
    return
  }

  if (plan.summary.contacts_to_update === 0) {
    console.log('\nNothing to apply.')
    return
  }

  const contactByResourceName = new Map<string, GoogleContact>(
    contacts.map((c) => [c.resourceName, c]),
  )

  // Backup existing fields of every contact we are about to touch.
  const backup = buildBackup(plan, contactByResourceName)
  const backupPath = writeJson(outDir, `backup-${stamp}.json`, backup)
  console.log(`\nBacked up existing fields of ${backup.length} contact(s) to ${backupPath}`)

  console.log(`Applying${opts.limit != null ? ` (limit ${opts.limit} contacts)` : ''}…`)
  const result = await applyPlan(plan, google, contactByResourceName, label, opts.limit)

  console.log('\nDone.')
  console.log(`  contacts updated: ${result.succeeded}`)
  console.log(`  failed:           ${result.failed}`)
  if (result.errors.length > 0) {
    console.log('\nErrors:')
    for (const e of result.errors) console.log(`  • ${e.contact}: ${e.error}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
