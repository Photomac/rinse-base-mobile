#!/usr/bin/env node
// Clock-in only at the property (rinsebase-app migration 20261102190000): a
// clock-in is refused only when the phone is provably outside the fence, and
// every other case lets the punch through and says why. Runs the REAL
// src/lib/clockInGate.ts under Node's type stripping (it is pure), then checks
// the wiring in the screens, the day pack and the strings.
//
// Usage: node scripts/test-clock-in-location.mjs
//   From a worktree: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-clock-in-location.mjs
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

const { runClockInGate, clockInFields, daySites, notCheckedRole, CLOCK_IN_FENCE_M, CLOCK_IN_MAX_ACCURACY_M, CLOCK_IN_MAX_FIX_AGE_MS } =
  await import(join(repo, 'src/lib/clockInGate.ts'))

const NOW = 1_800_000_000_000
const HOUSE = { name: 'Cabin 4', lat: 35.7143, lng: -83.5102, precision: 'exact' }
const north = m => HOUSE.lat + m / 111_195
const fixAt = (m, extra = {}) => ({ lat: north(m), lng: HOUSE.lng, accuracy: 10, at: NOW - 1000, ...extra })
const gate = (over = {}) => runClockInGate({
  sites: () => [HOUSE], permission: () => 'granted', fix: () => fixAt(2000),
  online: () => true, overridden: () => false, now: () => NOW, ...over,
})
const outcome = async over => { const d = await gate(over); return d.allow ? d.check : 'REFUSED' }
const boom = () => { throw new Error('no answer') }

// ── refuse and allow ─────────────────────────────────────────────────────────
check('2 km away, good fix, online: refused', await outcome(), 'REFUSED')
check('at the property: allowed', await outcome({ fix: () => fixAt(20) }), 'inside')
check('outside the fence but within the accuracy: allowed', await outcome({ fix: () => fixAt(CLOCK_IN_FENCE_M + 40, { accuracy: 60 }) }), 'inside')
check('outside by more than the accuracy: refused', await outcome({ fix: () => fixAt(CLOCK_IN_FENCE_M + 80, { accuracy: 60 }) }), 'REFUSED')

// ── every fail-open case ─────────────────────────────────────────────────────
for (const [name, site] of [
  ['no pin', { lat: null, lng: null, precision: 'unmappable' }],
  ['approximate', { lat: 35.7, lng: -83.5, precision: 'approximate' }],
  ['street-level', { lat: 35.7, lng: -83.5, precision: 'street' }],
  ['legacy, no precision', { lat: 35.7, lng: -83.5, precision: null }],
]) check(`no_pin: ${name}`, await outcome({ sites: () => [site] }), 'no_pin')
check('no_pin: the read broke', await outcome({ sites: boom }), 'no_pin')
check('no_permission: denied', await outcome({ permission: () => 'denied' }), 'no_permission')
check('no_permission: asking broke', await outcome({ permission: boom }), 'no_permission')
check('no_fix: none came', await outcome({ fix: () => null }), 'no_fix')
check('no_fix: asking broke', await outcome({ fix: boom }), 'no_fix')
check('no_fix: too old', await outcome({ fix: () => fixAt(2000, { at: NOW - CLOCK_IN_MAX_FIX_AGE_MS - 1 }) }), 'no_fix')
check('weak_accuracy: wider than the limit', await outcome({ fix: () => fixAt(5000, { accuracy: CLOCK_IN_MAX_ACCURACY_M + 1 }) }), 'weak_accuracy')
check('weak_accuracy: none reported', await outcome({ fix: () => fixAt(5000, { accuracy: null }) }), 'weak_accuracy')
check('offline: link down', await outcome({ online: () => false }), 'offline')
check('offline: override read never answered', await outcome({ overridden: boom }), 'offline')
check('override: the office let them in', await outcome({ overridden: () => true }), 'override')

// ── Start my day ─────────────────────────────────────────────────────────────
const ADDR = { client_addresses: { nickname: 'Cabin 4', lat: HOUSE.lat, lng: HOUSE.lng, geocode_precision: 'exact' } }
const OFFICE = { name: null, lat: 35.8, lng: -83.6, precision: 'exact' }
check('Start my day, no office pin: never refused', await outcome({ sites: () => daySites([ADDR], null) }), 'no_pin')
check('Start my day, office pin, away from everything: refused', await outcome({ sites: () => daySites([ADDR], OFFICE) }), 'REFUSED')
check('Start my day, at a clean: allowed', await outcome({ sites: () => daySites([ADDR], OFFICE), fix: () => fixAt(10) }), 'inside')

// ── the entry ────────────────────────────────────────────────────────────────
check('switch off: no extra key on the entry', clockInFields(null), {})
check('a refusal writes no entry fields', clockInFields(await gate()), {})
check('owners and managers aren\'t checked; dispatchers and crew are', ['owner', 'manager', 'dispatcher', 'cleaner'].map(notCheckedRole), [true, true, false, false])

// ── wiring ───────────────────────────────────────────────────────────────────
const job = read('src/screens/JobDetailScreen.tsx')
const home = read('src/screens/DashboardScreen.tsx')
const reads = read('src/lib/jobReads.ts')
const loc = read('src/lib/clockInLocation.ts')
const i18n = read('src/lib/i18n.ts')
const fn = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)))

has('Clock in: the check comes before the note and the punch', fn(job, 'async function handleClockIn()', 'function handleStartDaily'),
  /recordsForOthers[\s\S]*passClockInLocation\(handleClockIn\)[\s\S]*crewNoteNeedsAck/)
has('Clock in: the punch carries the check, and the office mark', fn(job, 'async function clockInAs(', 'function clockInRefused'), /\.\.\.clockInFields\(gate\),\s+\.\.\.officeMark/)
has('a punch the check got no fix for still takes its usual stamp', job, '(gate?.allow ? gate.stamp : null) ?? await quickGpsStamp()')
has('Clock in: desk staff recording for someone aren\'t checked', job, 'const gate = proxy ? null : clockInGate.current')
has('Resume is checked too', fn(job, 'async function handleResume()', 'async function canSignOffAsViewer'), /passClockInLocation\(handleResume\)[\s\S]*\.\.\.clockInFields\(gate\)/)
has('a refusal returns false before any write', fn(job, 'async function passClockInLocation(', '// Daily mode\'s "start"'), /!decision\.allow\)[\s\S]*return false/)
has('Try again re-runs the tap', job, "t('clock_in_try_again'), onPress: () => { void retry() }")
has('Start my day: checked, refused without writing', fn(home, 'async function handleStartDay()', 'async function handleEndDay()'),
  /checkClockIn[\s\S]*!gate\.allow\)[\s\S]*return\n[\s\S]*\.\.\.clockInFields\(gate\)[\s\S]*writeThrough/)
has('the office card is on the stop\'s screen', job, '<ClockInOfficeCard')
has('the office card uses the audited RPC', loc, "supabase.rpc('allow_clock_in_here'")
has('the switch fails to off', loc, /if \(error \|\| !data\?\.clock_in_location_required\) return \{ required: false/)
has('the day pack saves the switch and the property', fn(reads, 'export function jobPackReads(', '\n}\n'), /clockInRuleRead\(user\.tenant_id\),\s+clockInSiteRead\(job\.id\)/)
has('the switch is read on its own', fn(reads, 'export const clockInRuleRead', '})'), "select('clock_in_location_required, lat, lng')")
has('Home\'s rows carry the pin precision', fn(reads, 'export function dashTodayRead(', '\n}\n'), 'lat, lng, geocode_precision')
for (const key of ['clock_in_refused_title', 'clock_in_refused_body', 'day_start_refused_body', 'clock_in_try_again', 'clock_in_call_office', 'clock_in_location_off', 'clock_in_office_title', 'clock_in_office_refused', 'clock_in_office_allow', 'clock_in_office_let_in', 'clock_in_office_allowed', 'clock_in_office_failed']) {
  check(`${key} is in en, es and pt`, (i18n.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length, 3)
}

// ── the same rules on the web ────────────────────────────────────────────────
const web = process.env.RINSEBASE_WEB_REPO || join(repo, '../rinsebase-app')
const webGate = join(web, 'src/lib/clockInGate.ts')
if (existsSync(webGate)) check('clockInGate.ts is the same file as the web\'s', readFileSync(webGate, 'utf8') === read('src/lib/clockInGate.ts'), true)
else console.log('-  web repo not found: skipped the comparison with its clockInGate.ts')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
