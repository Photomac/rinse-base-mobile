#!/usr/bin/env node
// Where a day started or ended (CKS Perfections, 2026-10-23: day-shift crews'
// Start my day / End my day carried no location, 0 of 146 shifts in two weeks).
//
// Runs the REAL src/lib/stampPlace.ts under Node's type stripping (pure) and
// checks:
//   • "at" a home within 300 m, else miles to the nearest home on the person's
//     list; approximate (town-centre) pins and pinless homes never measured to;
//     no stamp = nothing;
//   • it is the web's src/lib/stampPlace.ts (rinsebase-app, Time logs and
//     Payroll): the same body, and the same answers over a grid of inputs;
// and, in the screens:
//   • the crew's own Start my day / End my day stamp the punch, best effort,
//     keeping the tap as the time (the fix never holds up the punch);
//   • the office's punches from Team today stamp nothing (the office phone is
//     not where the crew member was);
//   • Team today reads the stamps and the homes' pins, and names the place in
//     English, Spanish and Portuguese.
//
// Usage: node scripts/test-stamp-place.mjs
//   From a worktree, point the parity check at the web repo:
//   RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-stamp-place.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const read = f => readFileSync(join(repo, f), 'utf8')

const S = await import(join(repo, 'src/lib/stampPlace.ts'))

// ── The rules (made-up homes around Cottonwood, AZ; 0.001° lat ≈ 111 m) ──────
const SILEX = { lat: 34.74707, lng: -112.02556 }
const north = m => ({ lat: SILEX.lat + m / 111_195, lng: SILEX.lng })
const homes = [
  { name: 'SILEX', lat: SILEX.lat, lng: SILEX.lng, precision: 'exact' },
  { name: 'GENEVA', lat: SILEX.lat + 0.03, lng: SILEX.lng, precision: 'exact' },
]
{
  const a = north(120)
  check('120 m from a home: at it', S.stampPlace(a.lat, a.lng, homes), { kind: 'at', name: 'SILEX', metres: 120 })
  const b = north(1500)
  const p = S.stampPlace(b.lat, b.lng, homes)
  check('1.5 km off: near the nearer home, 0.9 mi', [p.kind, p.name, S.fmtMiles(p.miles)], ['near', 'SILEX', '0.9 mi'])
  check('no stamp: nothing', S.stampPlace(null, null, homes), null)
  check('no homes that day: located, nothing to compare', S.stampPlace(SILEX.lat, SILEX.lng, []), { kind: 'none' })
  check('an approximate pin is never measured to', S.stampPlace(SILEX.lat, SILEX.lng, [{ name: 'TOWN', lat: SILEX.lat, lng: SILEX.lng, precision: 'approximate' }]), { kind: 'none' })
  check('a stamp of 0,0 is a real place', S.stampPlace(0, 0, [])?.kind, 'none')
  check('PostgREST numeric strings are read', S.stampPlace(String(SILEX.lat), String(SILEX.lng), homes)?.kind, 'at')
  check('map link', S.stampMapUrl(34.747071234, -112.025561234), 'https://maps.google.com/?q=34.74707,-112.02556')
}

// ── Parity with the web's copy ────────────────────────────────────────────────
const body = src => src.slice(src.indexOf('export interface StampHome'))
const webRepo = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
let webSrc = null
try {
  webSrc = execFileSync('git', ['-C', webRepo, 'show', 'origin/main:src/lib/stampPlace.ts'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
} catch {
  // Not on the web's main yet (both PRs open): the web checkout's own file.
  try { webSrc = readFileSync(join(webRepo, 'src/lib/stampPlace.ts'), 'utf8') } catch { webSrc = null }
}
if (!webSrc) {
  console.log('–  web parity skipped: no rinsebase-app at', webRepo, '(set RINSEBASE_WEB_REPO)')
} else {
  check("the body is the web's, line for line", body(read('src/lib/stampPlace.ts')) === body(webSrc), true)
  const dir = mkdtempSync(join(tmpdir(), 'stamp-place-web-'))
  try {
    writeFileSync(join(dir, 'stampPlace.ts'), webSrc)
    const W = await import(join(dir, 'stampPlace.ts'))
    let same = 0, diff = 0, firstDiff = null
    const grid = [...homes, { name: 'LEGACY', lat: SILEX.lat - 0.01, lng: SILEX.lng + 0.01, precision: null },
      { name: 'TOWN', lat: SILEX.lat + 0.002, lng: SILEX.lng, precision: 'approximate' }, { name: 'NONE', lat: null, lng: null }]
    for (let dy = -40; dy <= 40; dy += 3) {
      for (let dx = -40; dx <= 40; dx += 3) {
        for (const set of [grid, grid.slice(2), []]) {
          const lat = SILEX.lat + dy * 0.0009, lng = SILEX.lng + dx * 0.0011
          const m = JSON.stringify(S.stampPlace(lat, lng, set)), w = JSON.stringify(W.stampPlace(lat, lng, set))
          const fm = S.fmtMiles(Math.abs(dy) / 3), fw = W.fmtMiles(Math.abs(dy) / 3)
          if (m === w && fm === fw) same++
          else { diff++; firstDiff ??= { lat, lng, m, w, fm, fw } }
        }
      }
    }
    check(`same answers as the web over ${same + diff} stamps`, { diff, firstDiff }, { diff: 0, firstDiff: null })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ── The screens ───────────────────────────────────────────────────────────────
const dash = read('src/screens/DashboardScreen.tsx')
const fnBody = (src, name) => {
  const i = src.indexOf(`async function ${name}(`)
  const j = src.indexOf('\n  async function ', i + 10)
  return i < 0 ? '' : src.slice(i, j < 0 ? undefined : j)
}
const start = fnBody(dash, 'handleStartDay'), end = fnBody(dash, 'handleEndDay')
check('Start my day takes a quick GPS fix', /await quickGpsStamp\(\)/.test(start), true)
check('…written as the shift\'s clock-in stamp', /clock_in_lat: stamp\?\.lat \?\? null, clock_in_lng: stamp\?\.lng \?\? null/.test(start), true)
check('…keeping the tap as the start, not when the fix came back',
  start.indexOf('const startedAt = new Date().toISOString()') > -1
  && start.indexOf('const startedAt = new Date().toISOString()') < start.indexOf('quickGpsStamp()')
  && /clocked_in_at: startedAt/.test(start), true)
check('End my day takes a quick GPS fix while the open shift is read', /const stampP = quickGpsStamp\(\)/.test(end) && end.indexOf('stampP = quickGpsStamp()') < end.indexOf('readOpenShift()'), true)
check('…written as the clock-out stamp', /clock_out_lat: stamp\?\.lat \?\? null, clock_out_lng: stamp\?\.lng \?\? null/.test(end), true)
check('…keeping the tap as the end', end.indexOf('const out = new Date()') > -1 && end.indexOf('const out = new Date()') < end.indexOf('quickGpsStamp()'), true)
const fence = read('src/lib/arrivalGeofence.ts')
check('the fix gives up after 2.5 s and never throws (the entry IS pay)',
  /export async function quickGpsStamp\(timeoutMs = 2500\)/.test(fence) && /catch \{ \/\* no stamp/.test(fence), true)

const team = read('src/screens/TeamTodayScreen.tsx')
const officeStart = team.slice(team.indexOf("entry_type: 'shift'") - 200, team.indexOf("entry_type: 'shift'") + 300)
check("Team today's office start stamps nothing", /clock_in_lat|quickGpsStamp|getCurrentPosition/.test(officeStart), false)
check('Team today takes no GPS fix anywhere', /quickGpsStamp|getCurrentPosition/.test(team), false)
const reads = read('src/lib/teamReads.ts')
check('Team today reads the stamps', /clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng/.test(reads), true)
check("…and the homes' pins", /client_addresses!jobs_address_id_fkey\(nickname, street, lat, lng, geocode_precision\)/.test(reads), true)
check('…and shows both ends of an entry', /\{stampLine\(e, false\)\}/.test(team) && /\{!open && stampLine\(e, true\)\}/.test(team), true)
check('…naming homes only from the day on screen', /dayKey\(at\) === ymd/.test(team), true)

const i18n = read('src/lib/i18n.ts')
for (const key of ['team_stamp_start_at', 'team_stamp_start_near', 'team_stamp_start_map', 'team_stamp_end_at', 'team_stamp_end_near', 'team_stamp_end_map']) {
  const n = (i18n.match(new RegExp(`\\b${key}: '`, 'g')) || []).length
  check(`${key} in English, Spanish and Portuguese`, n, 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
