#!/usr/bin/env node
// A clean's company settings in one request (2026-11-20).
//
// A clean's screen read a dozen company switches, each in its own tenants
// request, all at once (~10 per open, ~12,000 a day). lib/tenantColumnsCore
// lets reads that start while the company's request is on its way share it,
// and hands each read back the answer its own request gave.
//
// Runs the REAL src/lib/tenantColumnsCore.ts under Node's type stripping
// against a fake request, and checks:
//   • reads started together for one company send one request, naming every
//     listed column; each gets its own columns only, in its old shape (one
//     row, or a list of one), and no row is shared between reads;
//   • nothing is kept: a read after the answer asks again (a switch changed
//     in the office shows on the next load); two companies ask apart;
//   • no signal (status 0, or a thrown fetch) and a server error are every
//     read's answer, with the status, and nothing is kept for a retry;
//   • a database without a column (42703): each read asks for its own
//     columns on its own, as before; only the one naming the missing column
//     fails;
//   • and in lib/jobReads: the twelve settings reads go through it with their
//     own keys and columns, every column they name is listed, the checklist
//     mode keeps its list shape, and no other read there sends one of them.
//
// Usage: node scripts/test-tenant-settings.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const { createTenantColumns, TENANT_SETTING_COLUMNS, unknownColumn } = await import(join(repo, 'src/lib/tenantColumnsCore.ts'))

const ROW = {
  video_walkthroughs_enabled: true, default_checkin_time: '16:00', default_checklist_seed: 'generated', checklist_execution_mode: 'detailed',
  enforce_photo_requirements: true, check_first_required: false, clock_in_location_required: true, lat: 34.8, lng: -111.7,
  home_base_precision: 'exact', home_base_label: 'Office', crew_supply_counts: true, restock_two_choice: false,
  stay_rating_photos_required: 2, stay_rating_at_arrival: false, crew_prep_linens: true,
}

// A fake request: answers after a tick (or when released), records what it was asked.
function fake({ mode = 'ok', missing = [], row = ROW } = {}) {
  const asked = []
  const fetchRow = (columns, tenantId, single) => {
    asked.push({ columns, tenantId, single })
    return new Promise((resolve, reject) => setTimeout(() => {
      if (mode === 'offline') return resolve({ data: null, error: { message: 'Network request failed' }, status: 0 })
      if (mode === 'throws') return reject(new Error('fetch failed'))
      if (mode === 'error') return resolve({ data: null, error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 })
      const gone = missing.find(c => new RegExp(`\\b${c}\\b`).test(columns))
      if (gone) return resolve({ data: null, error: { code: '42703', message: `column tenants.${gone} does not exist` }, status: 400 })
      const pickd = row ? Object.fromEntries(columns.split(', ').map(c => [c, row[c]])) : null
      resolve({ data: single ? pickd : (pickd ? [pickd] : []), error: null, status: 200 })
    }, 5))
  }
  return { asked, tc: createTenantColumns(fetchRow) }
}

// ── One request ─────────────────────────────────────────────────────────────
{
  const f = fake()
  const [a, b, c, d] = await Promise.all([
    f.tc('t1', ['video_walkthroughs_enabled']),
    f.tc('t1', ['clock_in_location_required', 'lat', 'lng', 'home_base_precision', 'home_base_label']),
    f.tc('t1', ['checklist_execution_mode'], 'list'),
    f.tc('t1', ['crew_prep_linens', 'default_checkin_time']),
  ])
  check('four reads at once: one request, for the company, as one row', f.asked.map(x => [x.tenantId, x.single]), [['t1', true]])
  check('…naming every listed column', f.asked[0].columns, TENANT_SETTING_COLUMNS.join(', '))
  check('each read gets its own columns only, as one row', [a.data, b.data, d.data],
    [{ video_walkthroughs_enabled: true }, { clock_in_location_required: true, lat: 34.8, lng: -111.7, home_base_precision: 'exact', home_base_label: 'Office' },
     { crew_prep_linens: true, default_checkin_time: '16:00' }])
  check('the checklist mode keeps its list shape', c.data, [{ checklist_execution_mode: 'detailed' }])
  check('…with the status and no error', [a.error, a.status, c.error, c.status], [null, 200, null, 200])
  a.data.video_walkthroughs_enabled = 'changed'
  check('no row is shared between reads', (await Promise.all([f.tc('t1', ['video_walkthroughs_enabled'])]))[0].data, { video_walkthroughs_enabled: true })
}
{
  const f = fake({ row: null })
  const [a, c] = await Promise.all([f.tc('t9', ['stay_rating_at_arrival']), f.tc('t9', ['checklist_execution_mode'], 'list')])
  check('a company the person can\'t read: null as one row, [] as a list (as maybeSingle and a plain select answered)', [a.data, a.error, c.data, c.error], [null, null, [], null])
}

// ── Nothing kept ────────────────────────────────────────────────────────────
{
  const f = fake()
  await f.tc('t1', ['check_first_required'])
  await f.tc('t1', ['check_first_required'])
  check('a read after the answer asks again (the next load sees a changed switch)', f.asked.length, 2)
  await Promise.all([f.tc('t1', ['restock_two_choice']), f.tc('t2', ['restock_two_choice'])])
  check('two companies ask apart', f.asked.slice(2).map(x => x.tenantId).sort(), ['t1', 't2'])
}

// ── No signal, a server error ───────────────────────────────────────────────
for (const mode of ['offline', 'throws']) {
  const f = fake({ mode })
  const rs = await Promise.all([f.tc('t1', ['crew_supply_counts']), f.tc('t1', ['checklist_execution_mode'], 'list')])
  check(`no signal (${mode === 'offline' ? 'status 0' : 'a thrown fetch'}): every read says status 0 (each falls back to its own saved copy)`,
    rs.map(r => [r.data, !!r.error, r.status]), [[null, true, 0], [null, true, 0]])
  await f.tc('t1', ['crew_supply_counts'])
  check('…and nothing is kept: the next read asks again', f.asked.length, 2)
}
{
  const f = fake({ mode: 'error' })
  const r = await f.tc('t1', ['enforce_photo_requirements'])
  check('a server error is the read\'s answer, with its status (never a saved copy)', [r.data, r.error?.code, r.status], [null, 'PGRST301', 401])
}

// ── A database without a column ─────────────────────────────────────────────
{
  const f = fake({ missing: ['stay_rating_at_arrival'] })
  const [ok1, gone, ok2] = await Promise.all([
    f.tc('t1', ['stay_rating_photos_required']), f.tc('t1', ['stay_rating_at_arrival']), f.tc('t1', ['checklist_execution_mode'], 'list'),
  ])
  check('a database without one column: the shared request is refused, then each read asks for its own, as before',
    f.asked.map(x => x.columns), [TENANT_SETTING_COLUMNS.join(', '), 'stay_rating_photos_required', 'stay_rating_at_arrival', 'checklist_execution_mode'])
  check('…in its own shape', f.asked.slice(1).map(x => x.single), [true, true, false])
  check('…only the read naming the missing column fails', [ok1.data, gone.error?.code, gone.status, ok2.data],
    [{ stay_rating_photos_required: 2 }, '42703', 400, [{ checklist_execution_mode: 'detailed' }]])
  check('the unknown-column test: code 42703, or PostgREST\'s message', [unknownColumn({ code: '42703' }), unknownColumn({ message: 'column tenants.x does not exist' }), unknownColumn({ code: 'PGRST301' }), unknownColumn(null)], [true, true, false, false])
}
{
  const f = fake()
  let refused = null
  await f.tc('t1', ['mileage_rate']).catch(e => { refused = e.message })
  check('a column that isn\'t listed is refused before anything is sent', [/mileage_rate not in TENANT_SETTING_COLUMNS/.test(refused || ''), f.asked.length], [true, 0])
}

// ── In lib/jobReads ─────────────────────────────────────────────────────────
const reads = readFileSync(join(repo, 'src/lib/jobReads.ts'), 'utf8')
const code = reads.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
const uses = [...code.matchAll(/tenantColumns\((?:tenantId|user\.tenant_id), \[([^\]]+)\](?:, '(list)')?\)/g)].map(m => ({ cols: m[1].split(',').map(s => s.trim().replace(/'/g, '')), list: !!m[2] }))
check('the twelve settings reads go through it', uses.length, 12)
check('…naming only listed columns', uses.flatMap(u => u.cols).filter(c => !TENANT_SETTING_COLUMNS.includes(c)), [])
check('…and every listed column is some read\'s (nothing asked that no read wants)', TENANT_SETTING_COLUMNS.filter(c => !uses.some(u => u.cols.includes(c))), [])
check('…the checklist mode as a list, the rest as one row', uses.filter(u => u.list).map(u => u.cols), [['checklist_execution_mode']])
const keyOf = name => (code.match(new RegExp(`${name}[^]*?key: \`([a-z:]+)\\$`)) || [])[1]
check('…each keeps its own offline key', ['tenantVideoRead', 'tenantSeedRead', 'tenantModeRead', 'photoEnforceRead', 'checkFirstTenantRead', 'clockInRuleRead', 'supplyCountsTenantRead', 'restockTwoChoiceTenantRead', 'stayPhotosTenantRead', 'stayAtArrivalTenantRead'].map(keyOf),
  ['tenvideo:', 'tenseed:', 'tenmode:', 'tenphotoreq:', 'cften:', 'cilrule:', 'scten:', 'rtcten:', 'srpten:', 'sraten:'])
const ownTenantReads = [...code.matchAll(/from\('tenants'\)\s*\.select\('([^']+)'\)/g)].map(m => m[1])
// clean_start_needs_day (lib/timeFix) is read only when Start is tapped on a
// day-shift clean, and crew_time_fixes (lib/timeFix timeFixesOn) only at End
// my day and with My week's asks, so both stay off every clean's shared request.
check('no read in jobReads sends a listed column on its own any more (the driver pickup time and the two Fix my times / Start-my-day switches stay their own)', ownTenantReads, ['clean_start_needs_day', 'crew_time_fixes', 'default_checkout_time'])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
