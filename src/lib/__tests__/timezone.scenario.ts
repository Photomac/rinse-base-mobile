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
  setCurrentTz, setMultiMarket, clockOf, fmtTimeAt, fmtTimeRangeAt, fmtClockAt, zoneTag, sameClock, noteDayCleans, dayClocksOf, deviceTz, fmtDateTime, clockInTz, wallTimeInTz, fmtTime, fmtDate, fmtDatePart, dayKey, localDayKey,
  startOfDayInTz, endOfDayInTz, startOfMonthInTz, isForeignTz,
} from '../timezone'
import type { DatePart } from '../timezone'

// The phone's own zone, for the scenarios about it. Node re-reads TZ when it's set.
const phoneIn = (tz: string) => { (globalThis as any).process.env.TZ = tz }

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

// ── A date tile shows one part per line ─────────────────────────────────────
// The Open jobs tile asked fmtDate for { weekday }, { day }, { month } and got
// "Thu, Oct 22" / "Oct 22" / "Oct 22": fmtDate always adds month and day.
// fmtDatePart renders exactly one, in the tenant's zone and the app language.
const PARTS: DatePart[] = ['weekday', 'day', 'month']
const tile = (input: string, locale?: string) => PARTS.map(p => fmtDatePart(input, p, locale)).join(' / ')
setCurrentTz('America/Chicago')
const thu = '2026-10-22T15:00:00Z' // Thu Oct 22, 10:00 AM in Chicago
ok('tile weekday', fmtDatePart(thu, 'weekday'), 'Thu')
ok('tile day', fmtDatePart(thu, 'day'), '22')
ok('tile month', fmtDatePart(thu, 'month'), 'Oct')
ok('tile in Spanish', tile(thu, 'es-MX'), 'jue / 22 / oct')
ok('tile in Portuguese', tile(thu, 'pt-BR'), 'qui. / 22 / out.')
// 11:30 PM Oct 31 in Chicago is already Sun Nov 1 on the Lisbon phone: every
// part of the tile has to come from the tenant's day, not the phone's.
const halloween = '2026-11-01T04:30:00Z'
ok('tile parts follow the tenant day across a month seam', tile(halloween), 'Sat / 31 / Oct')
setCurrentTz('America/Los_Angeles')
ok('tile from a date-only string holds its day', tile('2026-05-09'), 'Sat / 9 / May')
ok('empty tile part', fmtDatePart(null, 'day'), '')
// ...and fmtDate keeps its defaults: Home's "still open since" shift line asks
// for { weekday } alone and relies on getting the date with it.
setCurrentTz('America/Chicago')
ok('fmtDate still adds month and day', fmtDate(thu, 'en-US', { weekday: 'short' }), 'Thu, Oct 22')

// ── Empties render empty, not "Invalid Date" ────────────────────────────────
ok('null time', fmtTime(null), '')
ok('unparseable time', fmtTime('not a date'), '')

// ── A clean on its property's clock ─────────────────────────────────────────
// A Chicago company with an Atlanta property. 16:00Z on Nov 3 is 10:00 in Chicago
// and 11:00 in Atlanta, and the crew in Atlanta has to read 11:00.
const nov3 = '2026-11-03T16:00:00Z'
const nov3End = '2026-11-03T19:00:00Z'
const atlanta = { timezone: 'America/New_York' }
setCurrentTz('America/Chicago')

setMultiMarket(false)
ok('switch off: the company clock, whatever the property holds', clockOf(atlanta), 'America/Chicago')
ok('switch off: reads exactly what fmtTime reads', fmtTimeAt(nov3, atlanta), fmtTime(nov3))
ok('switch off: a range names no zone', fmtTimeRangeAt(nov3, nov3End, atlanta), '10:00 AM – 1:00 PM')

setMultiMarket(true)
phoneIn('America/Chicago')
ok('switch on: the property clock', clockOf(atlanta), 'America/New_York')
ok('switch on: reads the home\'s time and names it', fmtTimeAt(nov3, atlanta), '11:00 AM EST')
ok('switch on: a range names the zone once', fmtTimeRangeAt(nov3, nov3End, atlanta), '11:00 AM – 2:00 PM EST')
ok('switch on, no zone on the row: the company clock, unnamed', fmtTimeAt(nov3, { timezone: null }), '10:00 AM')
ok('switch on, no address at all: the company clock', fmtTimeAt(nov3, null), '10:00 AM')
ok('switch on, a zone Intl can\'t name: the company clock, no throw', fmtTimeAt(nov3, { timezone: 'Mars/Olympus' }), '10:00 AM')
ok('a blank time stays blank', fmtTimeAt(null, atlanta), '')

setCurrentTz('America/New_York')
phoneIn('America/New_York')
ok('Detroit on a New York company is one clock: names nothing', fmtTimeAt(nov3, { timezone: 'America/Detroit' }), '11:00 AM')
phoneIn('America/Chicago')
setCurrentTz('America/Chicago')

const home = 'America/New_York'
ok('the day and the hour can be read on the property\'s clock', [dayKey('2026-11-04T04:30:00Z', home), clockInTz(nov3, home).h], ['2026-11-03', 11])
ok('and an hour typed on it lands on the right instant', wallTimeInTz('2026-11-03', 11, 0, home).toISOString(), '2026-11-03T16:00:00.000Z')
ok('with no zone passed these stay on the company clock', [dayKey('2026-11-04T04:30:00Z'), clockInTz(nov3).h, wallTimeInTz('2026-11-03', 10, 0).toISOString()], ['2026-11-03', 10, '2026-11-03T16:00:00.000Z'])
setMultiMarket(false)
phoneIn('Europe/Lisbon')

// ── A crew member who crosses a zone line ───────────────────────────────────
// Five Star Hospitality: a Chicago company with crew crossing the Central/Eastern
// line several times a day. Michigan City IN is Central; New Buffalo MI and South
// Bend IN are Eastern. The wrong answer this holds off, from PR #233 as first
// written: 10:30 AM EST, 10:00 AM, 11:00 AM EST, 12:00 PM EST, 11:30 AM. The bare
// ones are Central, and nothing on the screen said so.
const michiganCity = { timezone: 'America/Chicago' }
const michiganCityKnox = { timezone: 'America/Indiana/Knox' } // the same clock, another name
const newBuffalo = { timezone: 'America/Detroit' }
const southBend = { timezone: 'America/Indiana/Indianapolis' }
const noPin = { timezone: null }
const row = (at: string, address: any, status = 'scheduled') => ({ scheduled_start: at, status, client_addresses: address })

// One crossing day, in the order they're worked. A fresh start each time.
const winter = [
  row('2026-11-04T15:30:00Z', newBuffalo),
  row('2026-11-04T16:00:00Z', michiganCity),
  row('2026-11-04T16:00:00Z', southBend),
  row('2026-11-04T17:00:00Z', newBuffalo),
  row('2026-11-04T17:30:00Z', michiganCity),
]
const summer = [
  row('2026-07-15T14:30:00Z', newBuffalo),
  row('2026-07-15T15:00:00Z', michiganCity),
  row('2026-07-15T15:00:00Z', southBend),
  row('2026-07-15T16:00:00Z', newBuffalo),
  row('2026-07-15T16:30:00Z', michiganCity),
]
const reads = (rows: any[], days?: any) => rows.map(r => fmtTimeAt(r.scheduled_start, r.client_addresses, 'en-US', days)).join(' | ')
const start = (company: string, phone: string, multi = true) => {
  setMultiMarket(false) // forgets the days
  setMultiMarket(multi)
  setCurrentTz(company)
  phoneIn(phone)
}

start('America/Chicago', 'America/Chicago')
ok('the phone\'s zone is what the test says it is', deviceTz(), 'America/Chicago')
noteDayCleans(winter)
const namedWinter = '10:30 AM EST | 10:00 AM CST | 11:00 AM EST | 12:00 PM EST | 11:30 AM CST'
ok('a crossing day names every clean, Central ones too', reads(winter), namedWinter)
ok('a range names it once', fmtTimeRangeAt('2026-11-04T16:00:00Z', '2026-11-04T19:00:00Z', michiganCity), '10:00 AM – 1:00 PM CST')
ok('a company-clock time on that day says which clock', fmtTime('2026-11-04T16:00:00Z'), '10:00 AM CST')
ok('and with a date', fmtDateTime('2026-11-04T16:00:00Z'), 'Nov 4, 10:00 AM CST')
ok('another language keeps the zone\'s short name', fmtTimeAt('2026-11-04T16:00:00Z', michiganCity, 'es-MX').replace(/[  ]/g, ' '), '10:00 a.m. CST')
ok('a cell can have the time and the zone apart', [fmtClockAt('2026-11-04T15:30:00Z', newBuffalo), zoneTag(newBuffalo, '2026-11-04T15:30:00Z')], ['10:30 AM', 'EST'])

start('America/Chicago', 'America/Detroit')
noteDayCleans(winter)
ok('the same day on a phone already over the line reads the same', reads(winter), namedWinter)

start('America/Chicago', 'America/Chicago')
noteDayCleans(summer)
ok('summer: CDT and EDT', reads(summer), '10:30 AM EDT | 10:00 AM CDT | 11:00 AM EDT | 12:00 PM EDT | 11:30 AM CDT')

// A day on one clock, with the phone on it: as it has always read.
start('America/Chicago', 'America/Chicago')
noteDayCleans([row('2026-11-05T16:00:00Z', michiganCity), row('2026-11-05T18:00:00Z', michiganCityKnox)])
ok('a one-clock day on its own phone names nothing', [fmtTimeAt('2026-11-05T16:00:00Z', michiganCity), fmtTimeAt('2026-11-05T18:00:00Z', michiganCityKnox)], ['10:00 AM', '12:00 PM'])
ok('Knox and Chicago are one clock by wall time', sameClock('America/Indiana/Knox', 'America/Chicago', new Date('2026-11-05T16:00:00Z')), true)
ok('and the day beside it has its own answer', [fmtTimeAt('2026-11-04T16:00:00Z', michiganCity)], ['10:00 AM'])
noteDayCleans(winter)
ok('a crossing Wednesday leaves a one-clock Thursday alone', [fmtTimeAt('2026-11-04T16:00:00Z', michiganCity), fmtTimeAt('2026-11-05T16:00:00Z', michiganCity)], ['10:00 AM CST', '10:00 AM'])

// The phone is the other thing that makes a bare time a guess.
start('America/Chicago', 'America/Detroit')
noteDayCleans([row('2026-11-05T16:00:00Z', michiganCity)])
ok('a one-clock Central day on a phone over the line names it', fmtTimeAt('2026-11-05T16:00:00Z', michiganCity), '10:00 AM CST')
start('America/New_York', 'America/Chicago')
ok('a phone behind its New York company names the company\'s own clock', fmtTimeAt('2026-11-05T16:00:00Z', { timezone: 'America/Detroit' }), '11:00 AM EST')
start('America/Chicago', 'America/Chicago')
noteDayCleans([row('2026-11-05T16:00:00Z', newBuffalo)])
ok('all-Eastern day, phone in Chicago: named', fmtTimeAt('2026-11-05T16:00:00Z', newBuffalo), '11:00 AM EST')
start('America/Chicago', 'America/Detroit')
noteDayCleans([row('2026-11-05T16:00:00Z', newBuffalo)])
ok('all-Eastern day, phone in Michigan: off the company\'s clock, so still named', fmtTimeAt('2026-11-05T16:00:00Z', newBuffalo), '11:00 AM EST')

// A property with no pin has no zone: it reads the company clock, and says so.
start('America/Chicago', 'America/Chicago')
noteDayCleans([row('2026-11-05T16:00:00Z', noPin)])
ok('no pin, alone, phone on the company clock: as it always read', fmtTimeAt('2026-11-05T16:00:00Z', noPin), '10:00 AM')
noteDayCleans([...winter, row('2026-11-04T18:00:00Z', noPin)])
ok('no pin on a crossing day names the clock it was read on', fmtTimeAt('2026-11-04T18:00:00Z', noPin), '12:00 PM CST')
ok('no address at all, the same', fmtTimeAt('2026-11-04T18:00:00Z', null), '12:00 PM CST')
start('America/Chicago', 'America/Detroit')
ok('no pin, phone over the line: named', fmtTimeAt('2026-11-05T16:00:00Z', noPin), '10:00 AM CST')
start('America/Chicago', 'America/Chicago')
noteDayCleans([row('2026-11-05T16:00:00Z', noPin), row('2026-11-05T18:00:00Z', michiganCity)])
ok('no pin beside a Central clean is one clock', fmtTimeAt('2026-11-05T16:00:00Z', noPin), '10:00 AM')

// By wall clock, never by name.
start('America/New_York', 'America/New_York')
noteDayCleans([row('2026-11-05T16:00:00Z', { timezone: 'America/Detroit' }), row('2026-11-05T18:00:00Z', { timezone: 'America/New_York' })])
ok('Detroit on a New York company, New York phone: names nothing', [fmtTimeAt('2026-11-05T16:00:00Z', { timezone: 'America/Detroit' }), fmtTimeAt('2026-11-05T18:00:00Z', { timezone: 'America/New_York' })], ['11:00 AM', '1:00 PM'])
start('America/New_York', 'America/Detroit')
ok('and on a Detroit phone', fmtTimeAt('2026-11-05T16:00:00Z', { timezone: 'America/New_York' }), '11:00 AM')
start('America/Denver', 'America/Denver')
noteDayCleans([row('2026-01-14T17:00:00Z', { timezone: 'America/Phoenix' }), row('2026-01-14T19:00:00Z', { timezone: 'America/Denver' })])
ok('Phoenix beside Denver in winter is one clock', fmtTimeAt('2026-01-14T19:00:00Z', { timezone: 'America/Denver' }), '12:00 PM')
noteDayCleans([row('2026-07-15T17:00:00Z', { timezone: 'America/Phoenix' }), row('2026-07-15T19:00:00Z', { timezone: 'America/Denver' })])
ok('and two in summer', [fmtTimeAt('2026-07-15T17:00:00Z', { timezone: 'America/Phoenix' }), fmtTimeAt('2026-07-15T19:00:00Z', { timezone: 'America/Denver' })], ['10:00 AM MST', '1:00 PM MDT'])

// A cancelled clean isn't happening, and shouldn't start naming the rest.
start('America/Chicago', 'America/Chicago')
noteDayCleans([row('2026-11-05T16:00:00Z', michiganCity), row('2026-11-05T18:00:00Z', newBuffalo, 'cancelled')])
ok('a cancelled Eastern clean doesn\'t name a Central day', fmtTimeAt('2026-11-05T16:00:00Z', michiganCity), '10:00 AM')

// A board spans the company, so it speaks only for its own cards.
start('America/Chicago', 'America/Chicago')
noteDayCleans([row('2026-11-05T16:00:00Z', michiganCity)])
const board = dayClocksOf([row('2026-11-05T16:00:00Z', michiganCity), row('2026-11-05T17:00:00Z', newBuffalo)])
ok('a mixed board day names its cards', reads([row('2026-11-05T16:00:00Z', michiganCity), row('2026-11-05T17:00:00Z', newBuffalo)], board), '10:00 AM CST | 12:00 PM EST')
ok('and leaves this person\'s own one-clock day as it read', fmtTimeAt('2026-11-05T16:00:00Z', michiganCity), '10:00 AM')

// A clean opened from a crossing list reads the same on its own screen, with no list handed to it.
start('America/Chicago', 'America/Chicago')
ok('before the day is read there\'s nothing to go on', fmtTimeAt('2026-11-04T16:00:00Z', michiganCity), '10:00 AM')
noteDayCleans(winter)
ok('after it, the job\'s own screen agrees with the list', fmtTimeRangeAt('2026-11-04T16:00:00Z', '2026-11-04T19:00:00Z', michiganCity), '10:00 AM – 1:00 PM CST')
const mid = new Date('2026-11-04T16:00:00Z')

// The switch off, and a single-clock company: today's look, on any phone.
start('America/Chicago', 'America/Detroit', false)
noteDayCleans(winter)
ok('switch off: no name on a crossing day, with the phone over the line', reads(winter), '9:30 AM | 10:00 AM | 10:00 AM | 11:00 AM | 11:30 AM')
ok('switch off: fmtTime is bare', fmtTime(mid), '10:00 AM')
ok('switch off: a bare date and time', fmtDateTime(mid), 'Nov 4, 10:00 AM')
ok('switch off: the helper has nothing to say', zoneTag(newBuffalo, mid), '')
ok('switch off: no days kept', dayClocksOf(winter).size, 0)

// Signing out forgets the days.
start('America/Chicago', 'America/Chicago')
noteDayCleans(winter)
setMultiMarket(false)
setMultiMarket(true)
ok('a shared phone: the last person\'s day is gone', fmtTimeAt('2026-11-04T16:00:00Z', michiganCity), '10:00 AM')

setMultiMarket(false)
phoneIn('Europe/Lisbon')

console.log(failures === 0 ? '\nAll timezone invariants hold.' : `\n${failures} FAILURE(S)`)
process.exit(failures ? 1 : 0)
