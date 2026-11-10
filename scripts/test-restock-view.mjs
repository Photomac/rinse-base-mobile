#!/usr/bin/env node
// The Supplies screen's restocking info and the company's counts switch
// (CKS Perfections, Catherine, 2026-10-22: "Can Add counts be hidden from the
// crew ... Mark low should stay front and center", and "the property's
// restocking info ... visible to cleaners AND inspectors while they're
// standing in the home").
//
// Runs the REAL src/lib/restockView.ts under Node's type stripping and checks:
//   • what's already flagged low at the home: by item, this visit's own rows
//     left out, low since the earliest open flag, how many visits, the
//     latest words;
//   • the switch: only an explicit false turns the crew's counts off (a
//     failed read, or a database without the column, keeps them); the
//     office always sees counts;
//   • the reads: the open flags filtered through the property's catalog
//     (needs_restock, !inner on address_inventory) and the switch on its own
//     read; the day pack saves both for cleans AND inspections, and Supplies
//     reads them through lib/suppliesCard under the signed-in company;
//   • the screen: counts and "+ Add counts" only where allowed, Mark low on
//     every consumable regardless, the "Already flagged low here" card and
//     each item's "Flagged low since" line;
//   • the job screen offers Supplies on inspections too;
//   • the two-choice switch (tenants.restock_two_choice, CKS Perfections
//     2026-11-10): only an explicit true turns it on; its own read, saved by
//     the day pack; on, Mark low becomes "Opened the last one" / "Out", both a
//     flag that stores its kind (restock_level), tapping the lit one clears
//     it; off, Mark low as before;
//   • every new string is in English, Spanish and Portuguese;
//   • the web half (when that repo is on this machine): the same column, its
//     migration's grants, the Supplies page switch and the web crew views.
//
// Usage: node scripts/test-restock-view.mjs
//   From a worktree: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-restock-view.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const read = p => readFileSync(join(repo, p), 'utf8')
// restockView imports './jobScope' the way Metro wants it (no extension); Node needs the file.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === './jobScope' && ctx.parentURL?.includes('/src/lib/')) return next(pathToFileURL(join(repo, 'src/lib/jobScope.ts')).href, ctx)
    return next(spec, ctx)
  },
})
const V = await import(pathToFileURL(join(repo, 'src/lib/restockView.ts')).href)

// ── What's flagged low at the home ───────────────────────────────────────────
const rows = [
  { inventory_id: 'tp', job_id: 'J1', created_at: '2026-10-20T15:00:00Z', notes: null },
  { inventory_id: 'tp', job_id: 'J2', created_at: '2026-10-22T15:00:00Z', notes: 'one roll left' },
  { inventory_id: 'soap', job_id: 'J2', created_at: '2026-10-22T15:00:00Z', notes: '  ' },
  { inventory_id: 'det', job_id: 'NOW', created_at: '2026-10-23T15:00:00Z', notes: 'mine' },
  { inventory_id: null, job_id: 'J3', created_at: '2026-10-21T00:00:00Z' },
  null,
]
const open = V.openFlagsByItem(rows, 'NOW')
check('by item; this visit\'s own rows and broken rows left out', Object.keys(open).sort(), ['soap', 'tp'])
check('low since the earliest open flag, how many visits, the latest words', open.tp, { since: '2026-10-20T15:00:00Z', visits: 2, note: 'one roll left' })
check('blank words are no note', open.soap, { since: '2026-10-22T15:00:00Z', visits: 1, note: null })
check('an older note fills in when the latest has none',
  V.openFlagsByItem([{ inventory_id: 'x', job_id: 'a', created_at: '2026-10-01T00:00:00Z', notes: 'old' }, { inventory_id: 'x', job_id: 'b', created_at: '2026-10-05T00:00:00Z', notes: null }], 'z').x.note, 'old')
check('nothing read (offline, nothing saved) is no flags', [V.openFlagsByItem(null, 'x'), V.openFlagsByItem({}, 'x')], [{}, {}])

// ── The switch ───────────────────────────────────────────────────────────────
check('only an explicit false turns the crew\'s counts off', [
  V.crewCountsFrom({ crew_supply_counts: false }, null), V.crewCountsFrom({ crew_supply_counts: true }, null),
  V.crewCountsFrom(null, null), V.crewCountsFrom(null, { code: '42703' }), V.crewCountsFrom({ crew_supply_counts: false }, { message: 'x' }),
], [false, true, true, true, true])
const roles = ['owner', 'manager', 'dispatcher', 'lead_cleaner', 'cleaner', 'trainee', 'inspector', 'maintenance', null]
check('switch off: the office still counts, the crew mark low only', roles.map(r => V.countsAllowed(r, false)), [true, true, true, false, false, false, false, false, false])
check('switch on: everyone counts, as before', roles.map(r => V.countsAllowed(r, true)), roles.map(() => true))
check('two choices only on an explicit true (a failed read, no column, or a saved copy from before: Mark low)', [
  V.twoChoiceFrom({ restock_two_choice: true }, null), V.twoChoiceFrom({ restock_two_choice: false }, null),
  V.twoChoiceFrom({}, null), V.twoChoiceFrom(null, null), V.twoChoiceFrom(undefined, undefined),
  V.twoChoiceFrom(null, { code: '42703' }), V.twoChoiceFrom({ restock_two_choice: true }, { message: 'x' }), V.twoChoiceFrom({ restock_two_choice: 'true' }, null),
], [true, false, false, false, false, false, false, false])

// ── The reads ────────────────────────────────────────────────────────────────
const reads = read('src/lib/jobReads.ts')
const openRead = reads.slice(reads.indexOf('export const openRestockRead'), reads.indexOf('export const supplyCountsTenantRead'))
check('open flags: needs_restock, through the property\'s catalog (!inner), newest first, capped', [
  /\.from\('job_inventory_log'\)/.test(openRead), /address_inventory!job_inventory_log_inventory_id_fkey!inner\(address_id\)/.test(openRead),
  /\.eq\('needs_restock', true\)/.test(openRead), /\.eq\('address_inventory\.address_id', addrId\)/.test(openRead),
  /\.order\('created_at', \{ ascending: false \}\)/.test(openRead), /\.limit\(100\)/.test(openRead), /key: `inv:open:\$\{addrId\}`/.test(openRead),
], [true, true, true, true, true, true, true])
check('the switch: its own read of the one column', /key: `scten:\$\{tenantId\}`[\s\S]{0,120}\.select\('crew_supply_counts'\)\.eq\('id', tenantId\)\.maybeSingle\(\)/.test(reads), true)
check('the two-choice switch: its own read of the one column', /key: `rtcten:\$\{tenantId\}`[\s\S]{0,120}\.select\('restock_two_choice'\)\.eq\('id', tenantId\)\.maybeSingle\(\)/.test(reads), true)
check('the clean\'s lines and the prep card\'s open flags read the kind of low', [
  /key: `inv:log:\$\{jobId\}`[\s\S]{0,400}\.select\('[^']*\bneeds_restock, restock_level\b[^']*'\)/.test(reads),
  /key: `prep:restock:[\s\S]{0,200}\.select\('item_name, restock_level, jobs!inner\(address_id\)'\)/.test(reads),
], [true, true])
check('the day pack saves Supplies, the switches included, for cleans AND inspections',
  /if \(\(!isTask \|\| job\.job_type === 'inspection'\) && addrId\) \{\s*reads\.push\(inventoryItemsRead\(addrId\), inventoryLogRead\(job\.id\), inventoryRoomsRead\(addrId\), linenExtrasRead\(job\.id\),\s*openRestockRead\(addrId\), supplyCountsTenantRead\(user\.tenant_id\), restockTwoChoiceTenantRead\(user\.tenant_id\)\)/.test(reads), true)
const card = read('src/lib/suppliesCard.ts')
check('Supplies reads them through its card, the switches under the signed-in company', [
  /readSoon\(openRestockRead\(addrId\), wait\)/.test(card), /readSoon\(supplyCountsTenantRead\(tenantId\), wait\)/.test(card),
  /open: openFlagsByItem\(open\.data, job\.id\)/.test(card), /crewCounts: crewCountsFrom\(counts\.data, counts\.error\)/.test(card),
  /readSoon\(restockTwoChoiceTenantRead\(tenantId\), wait\)/.test(card), /twoChoice: twoChoiceFrom\(two\?\.data, two\?\.error\)/.test(card),
], [true, true, true, true, true, true])

// ── The screen ───────────────────────────────────────────────────────────────
const screen = read('src/screens/JobInventoryScreen.tsx')
check('the load names the signed-in company', /card\.load\(job, addrId, tenantId\)/.test(screen), true)
check('counts and "+ Add counts" only where allowed', [
  /const countsOk = countsAllowed\(user\?\.role, crewCounts\)/.test(screen), /if \(!countsOk\) return false/.test(screen),
  /\{!showCounts && countsOk && \(/.test(screen),
], [true, true, true])
check('the helper never mentions Add counts where the crew don\'t have it', /t\(countsOk \? 'supplies_helper' : 'supplies_helper_low_only'\)/.test(screen), true)
check('Mark low stays on every consumable, whatever the counts switch', /onPress=\{\(\) => toggleLow\(item\.id\)\}/.test(screen) && !/countsOk[^\n]*toggleLow|toggleLow[^\n]*countsOk/.test(screen), true)
check('"Already flagged low here" (consumables) and each item\'s "Flagged low since"', [
  /const openItems = items\.filter\(i => i\.category !== 'Linens' && open\[i\.id\]\)/.test(screen),
  /\{openItems\.length > 0 && \(/.test(screen), /t\('restock_open_title'\)/.test(screen),
  /\{open\[item\.id\] && \(/.test(screen), /fmtDate\(open\[item\.id\]\.since, localeFor\(lang\)\)/.test(screen),
], [true, true, true, true, true])
const fnText = sig => { const i = screen.indexOf(sig); return i < 0 ? '' : screen.slice(i, screen.indexOf('\n  }\n', i)) }
check('two choices: the switch from the view, the two in order, each a flag with its kind, the lit one clears', [
  /setTwoChoice\(v\.twoChoice === true\)/.test(screen),
  /const RESTOCK_KINDS: RestockLevel\[\] = \['last_one', 'out'\]/.test(screen),
  /last_one: 'restock_last_one', out: 'restock_out'/.test(screen),
  /const lit = row\.needs_restock && row\.restock_level === kind/.test(fnText('function setRestockKind(')),
  /editedRef\.current\.add\(id\)/.test(fnText('function setRestockKind(')),
  /needs_restock: !lit, restock_level: lit \? null : kind/.test(fnText('function setRestockKind(')),
], [true, true, true, true, true, true])
check('two choices on: they take Mark low\'s place; off: Mark low, as before', [
  /\{twoChoice \? \([\s\S]*?RESTOCK_KINDS\.map\([\s\S]*?onPress=\{\(\) => setRestockKind\(item\.id, kind\)\}[\s\S]*?\) : \([\s\S]*?onPress=\{\(\) => toggleLow\(item\.id\)\}/.test(screen),
  /needs_restock: !row\.needs_restock, restock_level: null/.test(fnText('function toggleLow(')),
], [true, true])
check('two choices on: their own helper (Add counts only where allowed), and the kind beside each flagged line', [
  /twoChoice\s*\? t\(countsOk \? 'supplies_helper_two_choice' : 'supplies_helper_two_choice_low_only'\)/.test(screen),
  /const kind = twoChoice \? log\[item\.id\]\?\.restock_level : null/.test(screen),
  /\{kind \? <Text style=\{styles\.noteKind\}>\{` · \$\{t\(RESTOCK_KIND_LABEL\[kind\]\)\}`\}<\/Text> : null\}/.test(screen),
], [true, true, true])
const prep = read('src/components/PrepCard.tsx')
check('the prep card tags each open flag with its kind, Out over the last one', [
  /had === 'out' \|\| kind === 'out' \? 'out' : had \?\? kind/.test(prep),
  /t\(kind === 'out' \? 'restock_tag_out' : 'restock_tag_last_one'\)/.test(prep),
], [true, true])
const detail = read('src/screens/JobDetailScreen.tsx')
// Not on a finished clean the crew only read (lib/finishedClean).
check('the job screen offers Supplies on inspections too', /\{\(!isTask \|\| isInspection\) && !readOnly && \(\s*<TouchableOpacity style=\{styles\.actionChip\} onPress=\{\(\) => setShowInventory\(true\)\}>/.test(detail), true)

// ── Strings ──────────────────────────────────────────────────────────────────
const i18n = read('src/lib/i18n.ts')
const block = lang => { const a = i18n.indexOf(`\n  ${lang}: {`); const rest = i18n.slice(a + 5); const b = rest.search(/\n  [a-z]{2}: \{|\n\}\n/); return rest.slice(0, b) }
const keys = ['restock_open_title', 'restock_open_since', 'restock_open_visits', 'restock_open_hint', 'supplies_helper_low_only',
  'supplies_helper_two_choice', 'supplies_helper_two_choice_low_only', 'restock_last_one', 'restock_out', 'restock_tag_last_one', 'restock_tag_out']
for (const lang of ['en', 'es', 'pt']) {
  const b = block(lang)
  check(`the new strings are in ${lang}`, keys.filter(k => !new RegExp(`\\n\\s+${k}:`).test(b)), [])
  check(`${lang} keeps {date} and {n}`, [/restock_open_since: '[^'\n]*\{date\}/.test(b), /restock_open_visits: '[^'\n]*\{n\}/.test(b)], [true, true])
}

// ── The web half ─────────────────────────────────────────────────────────────
const WEB = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
const migDir = join(WEB, 'supabase/migrations')
const mig = existsSync(migDir) ? readdirSync(migDir).find(f => /_crew_supply_counts\.sql$/.test(f)) : null
if (mig) {
  const sql = readFileSync(join(migDir, mig), 'utf8')
  check('web: the column, default on, NOT NULL, read and written per column by signed-in users', [
    /add column crew_supply_counts boolean not null default true/.test(sql),
    /grant select \(crew_supply_counts\) on public\.tenants to authenticated/.test(sql),
    /grant update \(crew_supply_counts\) on public\.tenants to authenticated/.test(sql), !/to anon/.test(sql),
  ], [true, true, true, true])
  const supplies = readFileSync(join(WEB, 'src/pages/SuppliesPage.tsx'), 'utf8')
  const panel = readFileSync(join(WEB, 'src/components/JobPanel.tsx'), 'utf8')
  const crewPage = readFileSync(join(WEB, 'src/pages/remaining.tsx'), 'utf8')
  check('web: the Supplies page switch reads and writes the same column on its own', [
    /select\('crew_supply_counts'\)\.eq\('id', tenantId\)\.maybeSingle\(\)/.test(supplies), /\.update\(\{ crew_supply_counts: next \}\)/.test(supplies),
  ], [true, true])
  check('web: crew views hide counts with the switch off; the job panel tells crew from office', [
    /const countsOff = crewView && !crewCountsOn/.test(panel), /const showCounts = !countsOff &&/.test(panel),
    /crewView=\{!!effectiveRole && !\['owner', (?:'admin', )?'manager', 'dispatcher'\]\.includes\(effectiveRole\)\}/.test(panel),
    /<InventoryTab [^>]*crewView \/>/.test(crewPage),
  ], [true, true, true, true])
} else {
  console.log(`–  web half skipped (no *_crew_supply_counts.sql under ${migDir})`)
}
const twoMig = existsSync(migDir) ? readdirSync(migDir).find(f => /_restock_two_choice_switch\.sql$/.test(f)) : null
const levelMig = existsSync(migDir) ? readdirSync(migDir).find(f => /_restock_level\.sql$/.test(f)) : null
if (twoMig && levelMig) {
  const sw = readFileSync(join(migDir, twoMig), 'utf8')
  const lv = readFileSync(join(migDir, levelMig), 'utf8')
  check('web: the two-choice switch, off by default, NOT NULL, read per column by signed-in users', [
    /add column restock_two_choice boolean not null default false/.test(sw), /grant select \(restock_two_choice\) on public\.tenants to authenticated/.test(sw),
  ], [true, true])
  check('web: restock_level holds the two kinds this app writes, and no kind without a flag', [
    /add column restock_level text/.test(lv), /check \(restock_level in \('last_one', 'out'\)\)/.test(lv),
    /if new\.needs_restock is not true then\s*new\.restock_level := null/.test(lv),
  ], [true, true, true])
} else {
  console.log(`–  web two-choice half skipped (no *_restock_two_choice_switch.sql / *_restock_level.sql under ${migDir})`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
