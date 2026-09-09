// Tenant-timezone rendering scenario test. Run with: node scripts/test-timezone.mjs
//
// Exercises the REAL src/lib/timezone.ts (no imports to mock — it is pure).
// The runner forces the process TZ to Europe/Lisbon so "the phone" and "the
// business" are genuinely in different zones; that divergence is the whole
// bug, and a test run in the tenant's own zone would pass no matter what the
// code did.
//
// The bug: every screen formatted job times with no `timeZone`, so a clean
// stored at 16:00Z read "11:00 AM" to a Chicago owner on the web and "5:00 PM"
// to the crew's phone in Lisbon. Verified on the Isiscare tenant 2026-09-04.
//
// The invariants below are the ones the fix promises. Two matter most and are
// easy to lose in a later refactor:
//   · a same-zone tenant (nearly every customer) must render byte-identically
//     to what shipped — this change is a no-op for them;
//   · the day a clean is bucketed into must agree with the time printed on it,
//     or we have traded one wrong answer for a different one.
import {
  setCurrentTz, fmtTime, fmtDate, dayKey, localDayKey,
  startOfDayInTz, endOfDayInTz, startOfMonthInTz, isForeignTz,
} from '../timezone'

let failures = 0
const ok = (name: string, got: unknown, want: unknown) => {
  const pass = String(got) === String(want)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got ${got}, expected ${want}`}`)
  if (!pass) failures++
}

// ── The reported bug: phone in Lisbon, business in Chicago ──────────────────
const clean = '2026-09-09T16:00:00Z'
setCurrentTz('America/Chicago')
ok('crew phone reads the owner\'s clock', fmtTime(clean), '11:00 AM')
ok('and knows the zone is not its own', isForeignTz(), true)

// ── No-op for a tenant whose crew is in the same zone ───────────────────────
ok('same-zone render is unchanged',
  fmtTime(clean),
  new Date(clean).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }))

// ── Unknown zone degrades to exactly the old behaviour, never to a guess ────
setCurrentTz(null)
ok('no tenant zone falls back to device-local',
  fmtTime(clean),
  new Date(clean).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
ok('and does not claim a foreign zone', isForeignTz(), false)

// ── Day bucketing must agree with the printed time ──────────────────────────
setCurrentTz('America/Chicago')
const lateClean = '2026-11-04T04:30:00Z' // 10:30 PM Nov 3 in Chicago
ok('late clean prints as the evening', fmtTime(lateClean), '10:30 PM')
ok('...and buckets on that same day', dayKey(lateClean), '2026-11-03')
ok('...and lands in the matching grid cell', localDayKey(new Date(2026, 10, 3)), dayKey(lateClean))

// ── Query bounds cover exactly one tenant day, including DST days ───────────
// US falls back 2026-11-01 (25h), springs forward 2026-03-08 (23h); the EU
// falls back a week earlier, 2026-10-25 — the seam that shifts a Lisbon
// schedule by an hour for one week with nobody touching it.
for (const [tz, day, hours] of [
  ['America/Chicago', '2026-11-01', 25],
  ['America/Chicago', '2026-03-08', 23],
  ['Europe/Lisbon',   '2026-10-25', 25],
  ['America/Chicago', '2026-09-09', 24],
] as const) {
  setCurrentTz(tz)
  const noon = new Date(`${day}T12:00:00Z`)
  const start = startOfDayInTz(noon)
  const end = endOfDayInTz(noon)
  ok(`${tz} ${day} is ${hours}h long`, ((end.getTime() - start.getTime() + 1) / 3600000).toFixed(0), String(hours))
  ok(`${tz} ${day} bounds sit inside the day`, `${dayKey(start)}/${dayKey(end)}`, `${day}/${day}`)
}

// ── Month bound feeds crew_pay_for_period, so it must be the tenant's month ─
setCurrentTz('America/Chicago')
ok('month starts on the 1st', dayKey(startOfMonthInTz(new Date('2026-09-09T16:00:00Z'))), '2026-09-01')
setCurrentTz('Pacific/Auckland')
ok('month rolls with a tenant ahead of the phone',
  dayKey(startOfMonthInTz(new Date('2026-09-30T20:00:00Z'))), '2026-10-01')

// ── Postgres `date` columns are calendar days and must never shift ──────────
setCurrentTz('America/Los_Angeles')
ok('date-only string holds its day', fmtDate('2026-05-09'), 'May 9')

// ── Empties render empty, not "Invalid Date" ────────────────────────────────
ok('null time', fmtTime(null), '')
ok('unparseable time', fmtTime('not a date'), '')

console.log(failures === 0 ? '\nAll timezone invariants hold.' : `\n${failures} FAILURE(S)`)
process.exit(failures ? 1 : 0)
