#!/usr/bin/env node
// What kind of clean each card on Home and Schedule says it is.
//
// Runs the REAL src/lib/cleanKind.ts under Node's type stripping (it is pure),
// on CKS Perfections' 2026-10-14 day as the database had it, and checks:
//   • an arrival prep, a linen restock and a laundry pickup read as their
//     service ("11:00 AM · Property Prep--Arrival");
//   • a turnover keeps "🏠 Turnover" (and "↔ Back-to-back"), in the crew's
//     language, and never repeats it: a service that already says turnover
//     ("STANDARD TURNOVER") is left off, any other service follows the tag;
//   • a synced turnover with no service, and a row cached before the service
//     was fetched, read exactly as the old card did;
//   • an inspection shows its service; laundry runs and tasks show none
//     (their title names them, as on the job screen);
// and, in the screens, that Home's day read and Schedule's read fetch the
// service through the FK-named embed and that both cards print kindParts().
//
// Usage: node scripts/test-clean-kind.mjs
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
const { kindParts, serviceName, saysTurnover } = await import(join(repo, 'src/lib/cleanKind.ts'))

const EN = { turnover: 'Turnover', backToBack: 'Back-to-back' }
const ES = { turnover: 'Cambio de turno', backToBack: 'Mismo día' }
// Home's line, exactly as DashboardScreen prints it.
const home = (time, job, labels = EN) => [time, ...kindParts(job, labels)].join(' · ')
// Schedule's line under the address (empty = the line isn't rendered).
const sched = (job, labels = EN) => kindParts(job, labels).join('  ·  ')
const svc = name => ({ name })

// CKS Perfections, 2026-10-14 (America/Phoenix), from the jobs table.
const sage = { job_type: 'clean', is_turnover: false, window_minutes: null, service_types: svc('Property Prep--Arrival') }        // #1657
const chuckawalla = { job_type: 'clean', is_turnover: false, window_minutes: null, service_types: svc('Property Prep--Arrival') } // #1656
const hacienda = { job_type: 'clean', is_turnover: false, window_minutes: null, service_types: svc('Property Prep--Arrival') }    // #1658
const cassie = { job_type: 'clean', is_turnover: false, window_minutes: null, service_types: svc('Linen & Restock Items') }       // #1633
const hideaway = { job_type: 'clean', is_turnover: true, window_minutes: 120, service_types: svc('STANDARD TURNOVER') }            // #1110
const eagleStudio = { job_type: 'clean', is_turnover: true, window_minutes: 90, service_types: null }                              // #1411
const ocb415 = { job_type: 'clean', is_turnover: true, window_minutes: null, service_types: null }                                 // #95
const eagleSuite = { job_type: 'clean', is_turnover: false, window_minutes: null, service_types: null }                            // #1655
const pacmanInsp = { job_type: 'inspection', is_turnover: false, window_minutes: null, service_types: svc('Final Inspection') }    // #1661
const laundryPickup = { job_type: 'clean', is_turnover: false, window_minutes: null, service_types: svc('LAUNDRY PICKUP') }        // #1605

check('Sage: the arrival prep says so', home('11:00 AM', sage), '11:00 AM · Property Prep--Arrival')
check('Chuckawalla and Hacienda too', [home('11:30 AM', chuckawalla), home('12:15 PM', hacienda)],
  ['11:30 AM · Property Prep--Arrival', '12:15 PM · Property Prep--Arrival'])
check('Cassie Ln: linen restock', home('7:00 AM', cassie), '7:00 AM · Linen & Restock Items')
check('Office laundry pickup (a clean booked as LAUNDRY PICKUP)', home('8:00 AM', laundryPickup), '8:00 AM · LAUNDRY PICKUP')
check('Hideaway: STANDARD TURNOVER is not printed beside Turnover',
  home('10:00 AM', hideaway), '10:00 AM · 🏠 Turnover · ↔ Back-to-back')
check('Eagle Studio: synced turnover, no service, still Turnover + Back-to-back',
  home('10:00 AM', eagleStudio), '10:00 AM · 🏠 Turnover · ↔ Back-to-back')
check('415 OCB: synced turnover, no service, no window', home('10:00 AM', ocb415), '10:00 AM · 🏠 Turnover')
check('Eagle Suite: a clean with no service shows just the time', home('10:45 AM', eagleSuite), '10:45 AM')
check('PACMAN inspection shows its service', home('12:30 PM', pacmanInsp), '12:30 PM · Final Inspection')

check('Schedule: arrival prep gets a kind line', sched(sage), 'Property Prep--Arrival')
check('Schedule: Hideaway as before', sched(hideaway), '🏠 Turnover  ·  ↔ Back-to-back')
check('Schedule: no service, no turnover → no kind line', sched(eagleSuite), '')

// Other companies' services (prod, last 60 days).
check('a turnover booked as Standard Clean: tag, then the service',
  home('10:00 AM', { is_turnover: true, service_types: svc('Standard Clean') }), '10:00 AM · 🏠 Turnover · Standard Clean')
check('every service that says turnover is left off a turnover',
  ['Standard Turnover', 'STR Turnover', 'Airbnb Turnover', 'Deep Turnover', 'standard turnover 650-900 sq ft', 'Turn-over', 'TURN OVER']
    .map(n => sched({ is_turnover: true, service_types: svc(n) })),
  Array(7).fill('🏠 Turnover'))
check('a non-turnover booked as Standard Turnover says so (no 🏠: it is not one)',
  home('9:00 AM', { is_turnover: false, service_types: svc('Standard Turnover') }), '9:00 AM · Standard Turnover')
check('a clean booked as the inspection service reads as one',
  home('2:45 PM', { job_type: 'clean', service_types: svc('Final Inspection') }), '2:45 PM · Final Inspection')

// Laundry runs and tasks: the title already names them.
check('laundry run: no service on the line',
  home('8:00 AM', { job_type: 'laundry_run', service_types: svc('Linen & Restock') }), '8:00 AM')
check('task: no service on the line',
  home('9:00 AM', { job_type: 'task', service_types: svc('Handyman Dispatch') }), '9:00 AM')

// Spanish.
check('Spanish: the tag is the crew\'s word, the service the office\'s',
  [home('10:00 AM', hideaway, ES), home('11:00 AM', sage, ES)],
  ['10:00 AM · 🏠 Cambio de turno · ↔ Mismo día', '11:00 AM · Property Prep--Arrival'])
check('Spanish: a service named in Spanish that says the tag is left off too',
  sched({ is_turnover: true, service_types: svc('Limpieza cambio de turno') }, ES), '🏠 Cambio de turno')

// Robustness.
check('names are trimmed; blank, missing or non-string read as none',
  [serviceName({ service_types: svc('  Midterm Reset ') }), serviceName({ service_types: svc('   ') }),
   serviceName({ service_types: null }), serviceName({}), serviceName(null), serviceName({ service_types: { name: 7 } })],
  ['Midterm Reset', null, null, null, null, null])
check('saysTurnover: English always; a blank crew label matches nothing extra',
  [saysTurnover('Deep TURNOVER', ''), saysTurnover('Deep Clean', ''), saysTurnover('Deep Clean', 'Turnover')], [true, false, false])

// Before this change the Home card printed exactly this; a row with no
// service (a synced turnover, or a copy cached before the embed) must not move.
const oldHome = (time, job) => `${time}${job.is_turnover ? ' · 🏠 Turnover' : ''}${job.window_minutes != null ? ' · ↔ Back-to-back' : ''}`
const shapes = []
for (const is_turnover of [true, false, null, undefined])
  for (const window_minutes of [null, undefined, 0, 45])
    for (const job_type of ['clean', 'inspection', 'laundry_run', 'task', null])
      shapes.push({ is_turnover, window_minutes, job_type })
check(`no service → the old Home line, all ${shapes.length} shapes`,
  shapes.filter(j => home('10:00 AM', j) !== oldHome('10:00 AM', j)), [])

// ── screens ──────────────────────────────────────────────────────────────────
const SERVICE = 'service_types!jobs_service_id_fkey(name)'
const dash = readFileSync(join(repo, 'src/screens/DashboardScreen.tsx'), 'utf8')
const schedSrc = readFileSync(join(repo, 'src/screens/ScheduleScreen.tsx'), 'utf8')
const reads = readFileSync(join(repo, 'src/lib/jobReads.ts'), 'utf8')
const todayQuery = /cachedRead\(dashTodayRead\(/.test(dash)
  ? reads.slice(reads.indexOf('export function dashTodayRead('), reads.indexOf('export function homeDayRows('))
  : ''
check('Home\'s day read fetches the service through the FK-named embed', todayQuery.includes(SERVICE), true)
check('Schedule\'s read fetches the service through the FK-named embed', schedSrc.includes(SERVICE), true)
// One FK today (jobs_service_id_fkey); a second one would make an unhinted
// embed answer 300 PGRST201, and a column-name hint stops resolving the day
// the FK goes composite. The constraint name survives both.
check('no unhinted or column-hinted service_types embed on these reads',
  /service_types(\(|!service_id)/.test(dash + schedSrc + reads), false)
check('Home\'s card prints the time, then kindParts()',
  dash.includes("{[fmtTime(job.scheduled_start, localeFor(lang)), ...kindParts(job, kindLabels)].join(' · ')}"), true)
check('Schedule\'s card prints kindParts() on the line under the address',
  /const kind = kindParts\(job, kindLabels\)/.test(schedSrc) && schedSrc.includes("{kind.length > 0 && <Text style={styles.kindTag}>{kind.join('  ·  ')}</Text>}"), true)
check('neither card hand-builds the turnover tag any more',
  /is_turnover \? ' · 🏠 '|job\.is_turnover && <Text/.test(dash + schedSrc), false)
check('both screens label with the crew\'s words for Turnover and Back-to-back',
  [dash, schedSrc].map(s => s.includes("const kindLabels = { turnover: t('turnover'), backToBack: t('back_to_back') }")), [true, true])

const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
for (const key of ['turnover', 'back_to_back']) {
  check(`"${key}" in all three languages`, (i18n.match(new RegExp(`[\\s,]${key}: '`, 'g')) || []).length, 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
