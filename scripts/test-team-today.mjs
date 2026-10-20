#!/usr/bin/env node
// "Team today", the office's clock roster on the phone (CKS Perfections,
// 2026-10-19: "who's in and out, like the Homebase tab, without Safari").
//
// Runs the REAL src/lib/teamDay.ts, src/lib/endDay.ts and src/lib/timezone.ts
// under Node's type stripping (all pure) and checks:
//   • the roster on a day shaped like CKS's (America/Phoenix): one row per
//     person by first clock-in, "on the clock" with time so far, "clocked out"
//     with first in, last out and the total; a start / end / start slip is one
//     row; overlapping entries count once (as payroll pays them); a day nobody
//     ended yesterday shows today; inactive people are never "not in"; people on
//     the day's schedule come first among those not in;
//   • per-job tracking: a person's work entries add up the same way;
//   • the end/start rules match the web's (rinsebase-app src/lib/endDay.ts):
//     the same cases, and, when the web repo is on this machine, the same
//     answers as the web's own code over a grid of inputs;
//   • typing a time ("8:21", "821p", "14:05") and the company-clock instant;
//   • who sees it (office), who fixes (owner only), where it goes (Mileage's
//     tab slot for a day-shift office);
// and, in the screens: no pay read or shown anywhere on it, every fix goes
// through the outbox, every string it uses exists in English, Spanish and
// Portuguese.
//
// Usage: node scripts/test-team-today.mjs
//   From a worktree, point the parity check at the web repo:
//   RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-team-today.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
// teamDay imports './jobScope' the way Metro wants it (no extension); Node needs the file.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === './jobScope' && ctx.parentURL?.includes('/src/lib/')) {
      return next(pathToFileURL(join(repo, 'src/lib/jobScope.ts')).href, ctx)
    }
    return next(spec, ctx)
  },
})
const T = await import(join(repo, 'src/lib/teamDay.ts'))
const E = await import(join(repo, 'src/lib/endDay.ts'))
const Z = await import(join(repo, 'src/lib/timezone.ts'))
Z.setCurrentTz('America/Phoenix')

// ── A CKS-shaped Tuesday (UTC-7 all year). Names are made up. ───────────────
const DAY = '2026-10-20'
const at = (hm, ymd = DAY) => Date.parse(`${ymd}T${hm}:00-07:00`)
const iso = (hm, ymd) => new Date(at(hm, ymd)).toISOString()
const dayStart = at('00:00'), dayEnd = at('00:00', '2026-10-21')
const NOW = at('16:03')
const P = (id, full_name, extra = {}) => ({ id, full_name, role: 'cleaner', is_active: true, ...extra })
const people = [
  P('owner', 'Carla Keane', { role: 'owner' }),
  P('mgr', 'NORA WESTFIELD', { role: 'manager' }),
  P('ali', 'Ana Lopez'), P('jen', 'JENNIFER C.'), P('mia', 'Mia Torres'), P('lil', 'Lilly Evans'),
  P('bri', 'Bree Lane', { role: 'lead_cleaner' }), P('eve', 'Eva Ruiz'), P('kat', 'Kat Moss'),
  P('nologin', 'Tara Quinn'), P('maint', 'Cole Fixit', { role: 'maintenance' }),
  P('gone', 'Old Hand', { is_active: false }), P('removed', 'Left Already', { removed_at: '2026-09-01T00:00:00Z' }),
]
let n = 0
const shift = (user_id, inHm, outHm, extra = {}) => ({
  id: `e${++n}`, user_id, job_id: null, entry_type: 'shift',
  clocked_in_at: iso(inHm, extra.inDay), clocked_out_at: outHm ? iso(outHm, extra.outDay ?? extra.inDay) : null, ...extra,
})
const entries = [
  shift('ali', '08:21', null),                                   // on the clock
  shift('jen', '07:30', '13:38'),                                // out: 6 hr 8 min
  shift('owner', '08:38', '08:38'), shift('owner', '08:39', null), // start / end / start slip
  shift('mia', '07:28', '15:38'),
  shift('bri', '16:40', null, { inDay: '2026-10-19' }),          // nobody ended her day yesterday
  shift('lil', '07:18', '11:00'), shift('lil', '10:30', '15:00'), // overlap: 7 h 42 min, not 8 h 12 min
  shift('gone', '09:00', '12:00'),                               // inactive, but worked: still listed
  shift('eve', '09:00', '17:00', { inDay: '2026-10-19' }),       // yesterday's: not today's
  shift('kat', '06:00', '07:00', { inDay: '2026-10-21' }),       // tomorrow's (a next start): not today's
]
const clean = (id, hm, crew, extra = {}) => ({ id, status: 'scheduled', scheduled_start: iso(hm), scheduled_end: iso(hm), crew, label: id, ...extra })
const cleans = [
  clean('SAGE', '10:00', ['eve']), clean('EAGLE', '09:00', ['eve', 'kat']),
  clean('PACMAN', '11:00', ['nologin']), clean('GONE', '09:00', ['kat'], { status: 'cancelled' }),
  clean('CASSIE', '08:00', ['jen'], { status: 'completed', completed_at: iso('13:10'), completed_by_user_id: 'jen' }),
]
const roster = T.buildRoster({ people, entries, cleans, dayStartMs: dayStart, dayEndMs: dayEnd, nowMs: NOW, isToday: true })
const row = id => roster.rows.find(r => r.personId === id)
const hm = (ms, running) => { const x = T.hoursMinutes(ms, running); return `${x.h}h ${x.m}m` }

check('rows by first clock-in (yesterday\'s open day first)', roster.rows.map(r => r.personId),
  ['bri', 'lil', 'mia', 'jen', 'ali', 'owner', 'gone'])
check('Ana: on the clock since 8:21, 7 hr 42 min so far at 4:03 PM',
  [Z.fmtTime(new Date(Date.parse(row('ali').open.clocked_in_at))), hm(row('ali').workedMs, true)], ['8:21 AM', '7h 42m'])
check('JENNIFER C.: clocked out, 7:30 AM to 1:38 PM, 6 hr 8 min',
  [Z.fmtTime(new Date(row('jen').firstInMs)), Z.fmtTime(new Date(row('jen').lastOutMs)), hm(row('jen').workedMs, false), row('jen').open], ['7:30 AM', '1:38 PM', '6h 8m', null])
check('a start / end / start slip is ONE row, on the clock from the second start',
  [row('owner').entries.length, Z.fmtTime(new Date(Date.parse(row('owner').open.clocked_in_at))), Z.fmtTime(new Date(row('owner').firstInMs))], [3 - 1, '8:39 AM', '8:38 AM'])
check('overlapping entries count once: 7:18 to 3:00 is 7 hr 42 min', hm(row('lil').workedMs, false), '7h 42m')
check('a day nobody ended yesterday shows today, flagged', [!!row('bri').open, row('bri').openFromEarlierDay], [true, true])
check('…but not on a past day\'s view', T.buildRoster({ people, entries, cleans, dayStartMs: dayStart, dayEndMs: dayEnd, nowMs: NOW, isToday: false }).rows.some(r => r.personId === 'bri'), false)
check('an inactive person who worked is listed', !!row('gone'), true)
check('yesterday\'s and tomorrow\'s entries are not today\'s', [!!row('eve'), !!row('kat')], [false, false])
check('not in: on the schedule first (by first clean), then by name; inactive and removed never',
  roster.notIn.map(x => [x.personId, x.cleans]),
  [['eve', 2], ['kat', 1], ['nologin', 1], ['maint', 0], ['mgr', 0]])
check('a cancelled clean doesn\'t put anyone on the schedule', roster.notIn.find(x => x.personId === 'kat').cleans, 1)
check('first clean time for Eva is 9:00', Z.fmtTime(new Date(roster.notIn[0].firstCleanMs)), '9:00 AM')
check('a running clock never reads ahead: 59.9 s is 0 min', T.hoursMinutes(59_900, true), { h: 0, m: 0 })
check('a finished span rounds as duration_minutes does', T.hoursMinutes(90_000, false), { h: 0, m: 2 })
check('initials', ['Ana Lopez', 'JENNIFER C.', 'Lilly', '  ', '(Mia) Torres', 'José Ñúñez'].map(T.initials), ['AL', 'JC', 'L', '?', 'MT', 'JÑ'])

// Per-job tracking: work rows per clean add up per person.
const work = (id, user_id, job_id, a, b) => ({ id, user_id, job_id, entry_type: 'work', clocked_in_at: iso(a), clocked_out_at: b ? iso(b) : null })
const pj = T.buildRoster({
  people, cleans: [], dayStartMs: dayStart, dayEndMs: dayEnd, nowMs: NOW, isToday: true,
  entries: [work('w1', 'mia', 'J1', '09:00', '10:30'), work('w2', 'mia', 'J2', '11:00', '12:15'), work('w3', 'mia', 'J3', '13:00', null),
    work('w4', 'jen', 'J1', '09:00', '10:30'), work('w5', 'jen', 'J1i', '09:05', '10:00')],
})
check('per-job: Mia 1h30 + 1h15 + running 3h03 = 5 hr 48 min so far', hm(pj.rows.find(r => r.personId === 'mia').workedMs, true), '5h 48m')
check('per-job: a clean and its inspection at once count once (Nichole, 9/2026)', hm(pj.rows.find(r => r.personId === 'jen').workedMs, false), '1h 30m')
const mia = pj.rows.find(r => r.personId === 'mia')
check('per-job: next start bounds the same job only', [T.nextStartAfter(mia.entries[0], mia.entries), T.nextStartAfter(work('w0', 'mia', 'J1', '08:00', '08:30'), [...mia.entries, work('w9', 'mia', 'J1', '12:00', null)])], [null, at('09:00')])
check('day shift: next start is their next day shift', T.nextStartAfter(entries.find(e => e.user_id === 'eve'), entries), null)
check('day shift: Lilly\'s first shift is bounded by her second', T.nextStartAfter(row('lil').entries[0], entries), at('10:30'))

// suggestEnd's cleans for one person: on their crew, or completed by them.
check('cleansFor', T.cleansFor('jen', cleans), [{ id: 'CASSIE', status: 'completed', completedAt: iso('13:10'), completedById: 'jen', assigned: true }])

// ── The rules, as the web has them ─────────────────────────────────────────
const S = at('07:30')
check('W end: before the start', E.validateEnd({ kind: 'shift', startMs: S, endMs: at('07:00'), nowMs: NOW })?.code, 'before_start')
check('W end: zero length', E.validateEnd({ kind: 'shift', startMs: S, endMs: S, nowMs: NOW })?.code, 'zero_length')
check('W end: in the future', E.validateEnd({ kind: 'shift', startMs: S, endMs: NOW + 61_000, nowMs: NOW })?.code, 'future')
check('W end: inside the one-minute grace is fine', E.validateEnd({ kind: 'shift', startMs: S, endMs: NOW + 59_000, nowMs: NOW }), null)
check('W end: past their next day\'s start', E.validateEnd({ kind: 'shift', startMs: S, endMs: at('11:00'), nowMs: NOW, nextStartMs: at('10:30') })?.code, 'after_next')
check('W end: at the next start is fine', E.validateEnd({ kind: 'shift', startMs: S, endMs: at('10:30'), nowMs: NOW, nextStartMs: at('10:30') }), null)
check('W end: unreadable', E.validateEnd({ kind: 'shift', startMs: S, endMs: NaN, nowMs: NOW })?.code, 'no_time')
const now19 = Date.parse('2026-10-19T16:30:00Z')
check('O1 a start this morning is fine', E.validateOfficeStart({ startMs: Date.parse('2026-10-19T15:15:00Z'), nowMs: now19 }), null)
check('O2 "now" is fine', E.validateOfficeStart({ startMs: now19, nowMs: now19 }), null)
check('O3 one 5-minute step ahead is fine', E.validateOfficeStart({ startMs: now19 + 5 * 60_000, nowMs: now19 }), null)
check('O4 six minutes ahead is the future', E.validateOfficeStart({ startMs: now19 + 6 * 60_000, nowMs: now19 })?.code, 'future')
check('O5 16 hours back is fine', E.validateOfficeStart({ startMs: now19 - 16 * 3600_000, nowMs: now19 }), null)
check('O6 a minute more is too old', E.validateOfficeStart({ startMs: now19 - 16 * 3600_000 - 60_000, nowMs: now19 })?.code, 'too_old')
check('O7 unreadable', E.validateOfficeStart({ startMs: NaN, nowMs: now19 })?.code, 'no_time')
check('fix in, closed: after the clock-out', E.validateStartFix({ kind: 'shift', startMs: at('14:00'), endMs: at('13:38'), nowMs: NOW })?.code, 'after_end')
check('fix in, closed: equal to it', E.validateStartFix({ kind: 'shift', startMs: at('13:38'), endMs: at('13:38'), nowMs: NOW })?.code, 'zero_length')
check('fix in, closed: earlier is fine (overlap or not)', E.validateStartFix({ kind: 'shift', startMs: at('07:00'), endMs: at('13:38'), nowMs: NOW }), null)
check('fix in, running: the office-start rule', [
  E.validateStartFix({ kind: 'shift', startMs: NOW - 17 * 3600_000, endMs: null, nowMs: NOW })?.code,
  E.validateStartFix({ kind: 'shift', startMs: NOW + 10 * 60_000, endMs: null, nowMs: NOW })?.code,
  E.validateStartFix({ kind: 'shift', startMs: at('07:00'), endMs: null, nowMs: NOW })], ['too_old', 'future', null])
// suggestEnd (the web's cases, CKS 9/2026: Brittany's day)
const done = (id, t, by, assigned = true) => ({ id, status: 'completed', completedAt: new Date(at(t)).toISOString(), completedById: by, assigned })
check('S1 her own last completion', E.suggestEnd({ kind: 'shift', startMs: S, nowMs: NOW, personId: 'bri', cleans: [done('a', '11:00', 'bri'), done('b', '13:20', 'bri'), done('c', '15:00', 'owner')] }), { ms: at('13:20'), reason: 'own_completion', cleanId: 'b' })
check('S2 none of her own: her crew\'s last, flagged', E.suggestEnd({ kind: 'shift', startMs: S, nowMs: NOW, personId: 'bri', cleans: [done('c', '15:00', 'owner')] }), { ms: at('15:00'), reason: 'crew_completion', cleanId: 'c' })
check('S3 a completion before the start doesn\'t count', E.suggestEnd({ kind: 'shift', startMs: S, nowMs: NOW, personId: 'bri', cleans: [done('a', '07:00', 'bri')] }), { ms: NOW, reason: 'now' })
check('S4 nothing completed and 16 h passed: the cap', E.suggestEnd({ kind: 'shift', startMs: S, nowMs: S + 20 * 3600_000, personId: 'bri', cleans: [] }), { ms: S + 16 * 3600_000, reason: 'shift_cap' })
check('S5 their next day began first', E.suggestEnd({ kind: 'shift', startMs: S, nowMs: NOW, nextStartMs: at('12:00'), personId: 'bri', cleans: [] }), { ms: at('12:00'), reason: 'next_start' })
check('S6 per-job: the scheduled length', E.suggestEnd({ kind: 'job', startMs: at('09:00'), nowMs: NOW, personId: 'bri', jobScheduledStart: iso('09:00'), jobScheduledEnd: iso('11:30') }), { ms: at('11:30'), reason: 'scheduled_length' })
check('S7 per-job: unknown length is 4 h', E.suggestEnd({ kind: 'job', startMs: at('09:00'), nowMs: NOW, personId: 'bri' }), { ms: at('13:00'), reason: 'scheduled_length' })
check('notes the office reads on Payroll (English, as the web writes)', [
  E.endedNote('shift', 'Carla Keane', null), E.endedNote('job', '', 'Auto-closed: forgot to clock out'), E.startedNote(' Carla ')],
  ['Day ended by Carla Keane', 'Auto-closed: forgot to clock out · Clocked out by the office', 'Day started by Carla'])
check('the cap is the server\'s 16 h', E.SHIFT_CAP_MS, 16 * 3600_000)

// Parity with the web's own endDay.ts, when that repo is on this machine.
const webRepo = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
let webDir = null
try {
  webDir = mkdtempSync(join(tmpdir(), 'team-today-web-'))
  mkdirSync(join(webDir, 'lib'))
  for (const f of ['endDay.ts', 'timezone.ts']) {
    writeFileSync(join(webDir, 'lib', f), execFileSync('git', ['-C', webRepo, 'show', `origin/main:src/lib/${f}`], { stdio: ['ignore', 'pipe', 'ignore'] }))
  }
} catch { webDir = null }
if (!webDir) console.log('–  web parity skipped (no rinsebase-app checkout with origin/main)')
else {
  const W = await import(join(webDir, 'lib', 'endDay.ts'))
  let same = 0, differ = []
  const base = at('07:00')
  const offs = [-90, -1, 0, 1, 59, 60, 61, 300, 301, 7 * 60, 15 * 60, 16 * 60, 16 * 60 + 1, 20 * 60].map(m => m * 60_000)
  for (const kind of ['shift', 'job']) for (const dEnd of offs) for (const dNow of offs) for (const dNext of [null, ...offs]) {
    const p = { kind, startMs: base, endMs: base + dEnd, nowMs: base + Math.abs(dNow) + 1, nextStartMs: dNext == null ? null : base + dNext }
    const a = E.validateEnd(p) == null, b = W.validateEnd({ ...p, tz: 'America/Phoenix' }) == null
    a === b ? same++ : differ.push(['validateEnd', p])
    const cl = [{ id: 'x', status: 'completed', completedAt: new Date(base + dEnd).toISOString(), completedById: dNow > 0 ? 'me' : 'other', assigned: dNext != null }]
    const q = { kind, startMs: base, nowMs: base + Math.abs(dNow) + 1, nextStartMs: p.nextStartMs, personId: 'me', cleans: cl, jobScheduledStart: new Date(base).toISOString(), jobScheduledEnd: new Date(base + Math.abs(dEnd)).toISOString() }
    JSON.stringify(E.suggestEnd(q)) === JSON.stringify(W.suggestEnd(q)) ? same++ : differ.push(['suggestEnd', q])
  }
  for (const d of offs) for (const s of [1, -1]) {
    const p = { startMs: NOW + s * d, nowMs: NOW }
    ;(E.validateOfficeStart(p) == null) === (W.validateOfficeStart({ ...p, tz: 'America/Phoenix' }) == null) ? same++ : differ.push(['validateOfficeStart', p])
  }
  check(`web parity: ${same} answers identical to rinsebase-app origin/main endDay.ts`, differ.slice(0, 3), [])
  check('web parity: same cap and graces', [E.SHIFT_CAP_MS, E.FUTURE_GRACE_MS, E.START_FUTURE_GRACE_MS], [W.SHIFT_CAP_MS, W.FUTURE_GRACE_MS, W.START_FUTURE_GRACE_MS])
  check('web parity: same notes', [E.endedNote('shift', 'Carla', 'x'), E.startedNote('Carla')], [W.endedNote('shift', 'Carla', 'x'), W.startedNote('Carla')])
  rmSync(webDir, { recursive: true, force: true })
}

// ── Typing a time, on the company's clock ───────────────────────────────────
const pc = (s, m = 'am') => { const r = T.parseClock(s, m); return r ? `${r.h}:${String(r.mi).padStart(2, '0')}` : null }
check('8:21 am / pm', [pc('8:21'), pc('8:21', 'pm')], ['8:21', '20:21'])
check('typed am/pm wins over the switch', [pc('8:21 pm'), pc('8:21p'), pc('1:38 P.M.'), pc('9a', 'pm')], ['20:21', '20:21', '13:38', '9:00'])
check('no colon, hour only, dot', [pc('821'), pc('1138', 'pm'), pc('8'), pc('08.05')], ['8:21', '23:38', '8:00', '8:05'])
check('24-hour times ignore the switch', [pc('14:05'), pc('0:30', 'pm'), pc('23:59')], ['14:05', '0:30', '23:59'])
check('12 am is midnight, 12 pm noon', [pc('12:15'), pc('12:15', 'pm')], ['0:15', '12:15'])
check('unreadable', [pc(''), pc('8:2'), pc('25:00'), pc('8:61'), pc('abc'), pc('12345')], [null, null, null, null, null, null])
check('clockText', [T.clockText(8, 21), T.clockText(13, 38), T.clockText(0, 5), T.clockText(12, 0)],
  [{ text: '8:21', meridiem: 'am' }, { text: '1:38', meridiem: 'pm' }, { text: '12:05', meridiem: 'am' }, { text: '12:00', meridiem: 'pm' }])
check('addDays across a month and a year', [T.addDays('2026-10-31', 1), T.addDays('2027-01-01', -1), T.addDays('2026-03-01', -1)], ['2026-11-01', '2026-12-31', '2026-02-28'])
check('8:21 on the Phoenix clock', Z.wallTimeInTz(DAY, 8, 21).getTime(), at('08:21'))
check('clockInTz reads it back', Z.clockInTz(new Date(at('13:38'))), { h: 13, mi: 38 })
Z.setCurrentTz('America/New_York')
check('New York, the day DST ends: 8:21 is EST', Z.wallTimeInTz('2026-11-01', 8, 21).toISOString(), '2026-11-01T13:21:00.000Z')
check('New York, the day before: EDT', Z.wallTimeInTz('2026-10-31', 8, 21).toISOString(), '2026-10-31T12:21:00.000Z')
check('New York, the day DST starts: 8:21 is EDT', Z.wallTimeInTz('2026-03-08', 8, 21).toISOString(), '2026-03-08T12:21:00.000Z')
check('unreadable day', Number.isNaN(Z.wallTimeInTz('10/20', 8, 0).getTime()), true)
Z.setCurrentTz('America/Phoenix')

// ── Who sees it, who fixes, where it goes ──────────────────────────────────
const roles = ['owner', 'manager', 'dispatcher', 'lead_cleaner', 'cleaner', 'trainee', 'inspector', 'maintenance', 'laundry_runner', null]
check('office sees it, crew never', roles.map(T.canSeeTeam), [true, true, true, false, false, false, false, false, false, false])
check('only the owner fixes times', roles.map(T.canFixTeamTime), [true, false, false, false, false, false, false, false, false, false])
check('Team takes Mileage\'s tab for a day-shift office only', [
  T.teamTabReplacesMileage({ role: 'owner', _timeMode: 'daily' }), T.teamTabReplacesMileage({ role: 'manager', _timeMode: 'daily' }),
  T.teamTabReplacesMileage({ role: 'owner', _timeMode: 'per_job' }), T.teamTabReplacesMileage({ role: 'cleaner', _timeMode: 'daily' })],
  [true, true, false, false])

// ── The screens ─────────────────────────────────────────────────────────────
const read = p => readFileSync(join(repo, p), 'utf8')
const screen = read('src/screens/TeamTodayScreen.tsx')
const form = read('src/components/TeamTimeForm.tsx')
const reads = read('src/lib/teamReads.ts')
const day = read('src/lib/teamDay.ts')
const app = read('App.tsx')
const profile = read('src/screens/ProfileScreen.tsx')
const code = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const all = [screen, form, reads, day].map(code).join('\n')
check('no pay anywhere on it (rates, pay type, the pay RPCs)',
  ['hourly_rate', 'per_job_rate', 'pay_type', 'crew_pay', 'user_private_details', 'user_pay_details', 'fetchMyPay', 'earnings', 'toFixed(2)'].filter(w => all.includes(w)), [])
check('…and no money sign ("$4", \'$\', >$ in JSX, as Profile\'s pay card has)', all.match(/\$\s?\d|['"`]\$(?!\{)|>\s*\$(?!\{)/g), null)
check('users read names only readable, non-pay columns', /select\('id, full_name, role, is_active, removed_at'\)/.test(reads), true)
const userCols = read('src/lib/userPrivateDetails.ts').match(/USERS_READABLE_COLUMNS = '([^']+)'/)[1].split(', ')
check('…every one of them is in USERS_READABLE_COLUMNS', ['id', 'full_name', 'role', 'is_active', 'removed_at'].filter(c => !userCols.includes(c)), [])
check('every fix goes through the outbox, none straight to the table',
  [/\.from\('job_time_entries'\)\s*\.(update|insert|upsert|delete)/.test(code(screen + reads)), (screen.match(/writeThrough\(\{/g) || []).length], [false, 3])
check('ending only touches a day still open (a replay never overwrites one ended since)', /match: \{ id: cur\.id, clocked_out_at: null \}/.test(screen), true)
check('a fix sets edited_at and edited_by (the closed-row guard lets the office through on edited_at)', (screen.match(/edited_at: iso\(now\)/g) || []).length, 3)
check('ending a day left open from an earlier day suggests from THAT day\'s cleans (web parity: Brittany 9/22)',
  /async function openEnd/.test(screen) && /teamCleansRead\(tenantId, wallTimeInTz\(startDay, 0, 0\)/.test(screen) && /const dayCleans = f\.cleans \?\? cleans/.test(screen), true)
check('…read live, never into today\'s saved copy', /const res: any = await r\.q\(\)/.test(screen), true)
check('Start their day writes the shift "Start my day" writes, with a client id', /entry_type: 'shift'/.test(screen) && /id: uuid4\(\)/.test(screen) && /job_id: null/.test(screen), true)
check('23505 on Start their day says who is already on the clock', /error\?\.code === '23505'/.test(screen) && /team_already_on/.test(screen), true)
check('fix buttons only for the owner; Start their day only today, day-shift', /canFix && dailyMode && isToday/.test(screen) && /\{canFix && \(/.test(screen), true)
check('crew can\'t open it from Profile, and the Team tab follows teamTabReplacesMileage',
  [/onOpenTeam=\{!teamTab && canSeeTeam\(user\.role\)/.test(app), /const teamTab = teamTabReplacesMileage\(user\)/.test(app), /\{teamTab \? \(/.test(app)], [true, true, true])
check('Mileage is still reachable for a day-shift office (Profile + Home\'s Log miles)',
  [/onOpenMileage=\{teamTab \?/.test(app), /screen === 'mileage' && teamTab/.test(app), /onOpenMileage &&/.test(profile)], [true, true, true])

const i18n = read('src/lib/i18n.ts')
const block = lang => { const a = i18n.indexOf(`\n  ${lang}: {`); const rest = i18n.slice(a + 5); const b = rest.search(/\n  [a-z]{2}: \{|\n\}\n/); return rest.slice(0, b) }
const used = [...new Set([...(screen + form + app + profile).matchAll(/t\('((?:team_|queued_offline|crew_you|today|yesterday|back|cancel|save|my_mileage)[a-z_]*)'\)/g)].map(m => m[1]))]
for (const lang of ['en', 'es', 'pt']) {
  const b = block(lang)
  check(`every string it uses is in ${lang} (${used.length})`, used.filter(k => !new RegExp(`\\b${k}: `).test(b)), [])
}
const enKeys = [...block('en').matchAll(/\b(team_[a-z_]+): /g)].map(m => m[1])
for (const lang of ['es', 'pt']) {
  const b = block(lang)
  check(`${lang} has every team_ string English has (${enKeys.length})`, enKeys.filter(k => !new RegExp(`\\b${k}: `).test(b)), [])
  const placeholders = k => [...(block('en').match(new RegExp(`\\b${k}: (['"])(.*?)\\1,?\\n`))?.[2] ?? '').matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join()
  const theirs = k => [...(b.match(new RegExp(`\\b${k}: (['"])(.*?)\\1,?\\n`))?.[2] ?? '').matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join()
  check(`${lang} keeps every {placeholder}`, enKeys.filter(k => placeholders(k) !== theirs(k)), [])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
