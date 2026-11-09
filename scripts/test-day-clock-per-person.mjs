#!/usr/bin/env node
// The day clock person by person (iClean, 2026-11-09; rinsebase-app migrations
// 20261109153021-153126). iClean's drivers and warehouse staff clock in for
// the day while its cleaners clock per clean, and a driver's day can be limited
// to the company location the office placed. Runs the REAL src/lib/dayClock.ts
// and src/lib/clockInGate.ts under Node's type stripping (both pure), then
// checks the wiring in App.tsx, Home, the background tracker, the arrival
// auto clock-in and the strings, and that dayClock.ts is the web's file.
//
// Usage: node scripts/test-day-clock-per-person.mjs
//   From a worktree: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-day-clock-per-person.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(repo, p), 'utf8')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const has = (name, text, needle) => check(name, typeof needle === 'string' ? text.includes(needle) : needle.test(text), true)
const lacks = (name, text, needle) => check(name, typeof needle === 'string' ? text.includes(needle) : needle.test(text), false)
const fn = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)))

const { runClockInGate, daySites } = await import(join(repo, 'src/lib/clockInGate.ts'))
const { effectiveTimeMode, dayClockAtOffice, companyLocationSite, dayStartSites, dayEndChecked, dayEndSites, dayEndDecision, dayEndFields, DAY_END_GATE } =
  await import(join(repo, 'src/lib/dayClock.ts'))

// ── whose clock ──────────────────────────────────────────────────────────────
check('a driver at a per-clean company clocks in for the day', effectiveTimeMode('daily', 'per_job'), 'daily')
check('a cleaner at a day-clock company clocks per clean', effectiveTimeMode('per_job', 'daily'), 'per_job')
check('no setting: the company\'s', [effectiveTimeMode(null, 'daily'), effectiveTimeMode(undefined, 'per_job'), effectiveTimeMode(null, null)], ['daily', 'per_job', 'per_job'])
check('where: unknown values are no limit', [dayClockAtOffice('start'), dayClockAtOffice('start_and_end'), dayClockAtOffice('x'), dayClockAtOffice(null)], ['start', 'start_and_end', null, null])
check('only start-and-end judges the end', [dayEndChecked('start_and_end'), dayEndChecked('start'), dayEndChecked(null)], [true, false, false])

// ── start and end against the warehouse ──────────────────────────────────────
const NOW = 1_800_000_000_000
const WAREHOUSE = companyLocationSite({ lat: 53.2938, lng: -8.9876, home_base_precision: 'exact', home_base_label: 'Warehouse' })
const CENTROID = companyLocationSite({ lat: 53.2744122, lng: -9.0490601, home_base_precision: null })
const north = m => 53.2938 + m / 111_195
const fixAt = (m, extra = {}) => ({ lat: north(m), lng: -8.9876, accuracy: 10, at: NOW - 1000, ...extra })
const HOME = { client_addresses: { nickname: 'Kirwan Court', lat: 53.2709, lng: -9.0627, geocode_precision: 'exact' } }
const start = async (sites, m, over = {}) => {
  const d = await runClockInGate({ sites: () => sites, permission: () => 'granted', fix: () => fixAt(m), online: () => true, overridden: () => false, now: () => NOW, ...over })
  return d.allow ? d.check : 'REFUSED'
}
const driver = dayStartSites({ atOffice: 'start', companyRequired: false, office: WAREHOUSE, companySites: () => daySites([HOME], WAREHOUSE) })
check('driver at the warehouse: started', await start(driver, 20), 'inside')
check('driver 2 km away: refused, with the company switch off', await start(driver, 2000), 'REFUSED')
check('the cron\'s pin (maybe a town centre) never refuses', await start(dayStartSites({ atOffice: 'start', companyRequired: false, office: CENTROID, companySites: () => [] }), 2000), 'no_pin')
check('no limit, switch on: properties and the company location', dayStartSites({ atOffice: null, companyRequired: true, office: WAREHOUSE, companySites: () => daySites([HOME], WAREHOUSE) }).length, 2)
check('no limit, switch off: not checked', dayStartSites({ atOffice: null, companyRequired: false, office: WAREHOUSE, companySites: () => [] }), null)
const end = async (place, m, over = {}) => dayEndDecision(await runClockInGate({
  sites: () => dayEndSites(place), permission: () => 'granted', fix: () => fixAt(m), now: () => NOW, ...over, ...DAY_END_GATE,
}))
const away = await end(WAREHOUSE, 4000)
check('ended 4 km away: away with the distance, never refused', [away.away, away.check, Math.abs(away.distanceM - 4000) < 5], [true, 'away', true])
check('ended at the warehouse: inside', (await end(WAREHOUSE, 30)).check, 'inside')
check('no signal: still judged', (await end(WAREHOUSE, 4000, { online: () => false })).check, 'away')
check('location off / the cron\'s pin: not checked', [(await end(WAREHOUSE, 4000, { permission: () => 'denied' })).check, (await end(CENTROID, 4000)).check], ['no_permission', 'no_pin'])
check('the entry carries it', dayEndFields(away).clock_out_check, 'away')
check('not judged: nothing extra', dayEndFields(null), {})

// ── wiring ───────────────────────────────────────────────────────────────────
const app = read('App.tsx')
const home = read('src/screens/DashboardScreen.tsx')
const loc = read('src/lib/clockInLocation.ts')
const geo = read('src/lib/arrivalGeofence.ts')
const tracker = read('src/lib/locationTracker.ts')
const i18n = read('src/lib/i18n.ts')
const startDay = fn(home, 'async function handleStartDay()', 'async function handleEndDay()')
const endDay = fn(home, 'async function handleEndDay()', 'const now = new Date()')

has('App: the person\'s clock is its own read (the profile read is unchanged)', app, "select('time_tracking_mode, day_clock_at_office').eq('id', userId).maybeSingle()")
lacks('App: the profile\'s users read doesn\'t name the new columns', fn(app, 'async function loadUser(', 'const data: any'), /time_tracking_mode|day_clock_at_office/)
has('App: _timeMode is the person\'s over the company\'s', app, 'data._timeMode = effectiveTimeMode(personal.mode, data._companyTimeMode)')
has('App: unreadable keeps this person\'s last good copy', app, /if \(!personal\) \{[\s\S]{0,120}prev && prev\.id === data\.id/)
has('App: an old saved copy\'s _timeMode is read as the company\'s', app, "_companyTimeMode: p._companyTimeMode ?? p._timeMode ?? 'per_job'")
has('Start my day: where comes from dayStartSites', startDay, 'dayStartSites({ atOffice, companyRequired: rule.required, office: rule.office, companySites: () => daySites(dayRows, rule.office) })')
has('Start my day: a refusal returns before any write', startDay, /if \(gate && !gate\.allow\) \{[\s\S]{0,600}return\n[\s\S]*writeThrough/)
has('Start my day: a day limited to the company location names it', startDay, "t('day_start_office_refused_body')")
has('End my day: judged only for start-and-end, never for the office', endDay, 'dayEndChecked(user._dayClockAtOffice) && !notCheckedRole(user.role)')
has('End my day: away asks first, before the write', endDay, /end\.away[\s\S]*Alert\.alert\([\s\S]*if \(!endHere\) return[\s\S]*writeThrough/)
has('End my day: the end is the tap, taken before the check', endDay, /const out = new Date\(\)[\s\S]*checkDayEnd/)
has('End my day: the entry carries where it ended', endDay, '...dayEndFields(end)')
has('the day-end check never asks for location (an end must not wait on a prompt)', fn(loc, 'export async function checkDayEnd(', '\n}\n'), "(await getForegroundLocationStatus()) === 'granted' ? 'granted' : 'denied'")
has('Home names where the day starts', home, "ti(t('day_starts_at'), { place: dayPlace || t('company_location') })")
has('the rule read hands back the company location with the switch off', loc, 'return { required: !!data.clock_in_location_required, office: companyLocationSite(data) }')
has('arrival auto clock-in: never a per-clean entry for someone on the day clock', geo, /effectiveTimeMode\(\(mine as any\)\?\.time_tracking_mode, tenant\?\.time_tracking_mode\) === 'daily'[\s\S]{0,80}if \(tenant\?\.auto_clock_in && !daily && windowOpen\)/)
has('background tracker: a relaunch with no profile reads the person\'s clock too', tracker, "return effectiveTimeMode(mine, (data as any)?.time_tracking_mode) === 'daily'")
for (const key of ['company_location', 'day_start_office_refused_body', 'day_end_away_title', 'day_end_away_body', 'day_end_here', 'day_starts_at']) {
  check(`${key} is in en, es and pt`, (i18n.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length, 3)
}
check('dayClock.ts imports types only (loads under Node and Metro as it is)', [...read('src/lib/dayClock.ts').matchAll(/^import (?!type )/gm)].length, 0)

// ── the same rules on the web ────────────────────────────────────────────────
const web = process.env.RINSEBASE_WEB_REPO || join(repo, '../rinsebase-app')
const webDayClock = join(web, 'src/lib/dayClock.ts')
if (existsSync(webDayClock)) check('dayClock.ts is the same file as the web\'s', readFileSync(webDayClock, 'utf8') === read('src/lib/dayClock.ts'), true)
else console.log('-  web repo not found: skipped the comparison with its dayClock.ts')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
