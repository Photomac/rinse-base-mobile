#!/usr/bin/env node
// "My week", the crew member's own week on the phone (CKS Perfections,
// 2026-10-08: "$203.85 for 7 hr 33 min, 7:57 AM – 3:30 PM", week totals,
// scheduled vs actual, in the app).
//
// Runs the REAL src/lib/myWeek.ts (with teamDay.ts and timezone.ts) under
// Node's type stripping and checks:
//   • the week is the pay week: tiled by 7 from the payroll anchor when periods
//     are whole weeks (CKS: Monday), else Sunday to Saturday (twice a month,
//     odd lengths, no schedule), before the anchor too, and across a DST change;
//   • each day's pay is the difference of running totals, so the days add up to
//     the week to the cent, a day ahead is unknown, and a day can come out
//     below zero when a later clock-in changes earlier pay (shown, not hidden);
//   • a CKS-shaped week (America/Phoenix): clock times, a start/end/start slip,
//     a day the nightly close ended, a day on the schedule with no time, today
//     still on the clock (time so far, pay after clock-out), days ahead, a day
//     off; scheduled = first assigned job's start to the last one's end, only
//     confirmed jobs; the totals; more / less than scheduled;
// and, in the reads and the screen: pay only from crew_pay_for_period, for the
// person themselves, as running totals from the week's start; no rate or price
// read; nothing written; only this week kept offline, and a saved copy of
// another week never shown; Home's earnings card opens it; every string in
// English, Spanish and Portuguese.
//
// Usage: node scripts/test-my-week.mjs
import { readFileSync, existsSync } from 'node:fs'
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

// The lib imports siblings the way Metro wants them (no extension); Node needs the file.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') && ctx.parentURL?.includes('/src/lib/')) {
      const file = join(dirname(fileURLToPath(ctx.parentURL)), `${spec}.ts`)
      if (existsSync(file)) return next(pathToFileURL(file).href, ctx)
    }
    return next(spec, ctx)
  },
})
const W = await import(join(repo, 'src/lib/myWeek.ts'))
const Z = await import(join(repo, 'src/lib/timezone.ts'))

// ── The week ────────────────────────────────────────────────────────────────
const CKS = { days: 7, anchor: '2026-09-21', cadence: 'biweekly' } // a Monday; cadence is the unused default
check('CKS: Thu Oct 22 is in the week of Mon Oct 19', W.weekStartFor('2026-10-22', CKS), '2026-10-19')
check('CKS: the Monday itself starts its week', W.weekStartFor('2026-10-19', CKS), '2026-10-19')
check('CKS: Sunday ends the week', W.weekStartFor('2026-10-25', CKS), '2026-10-19')
check('CKS: before the anchor, weeks still tile back from it', W.weekStartFor('2026-09-20', CKS), '2026-09-14')
check('every 14 days from a Wednesday: weeks start Wednesday', W.weekStartFor('2026-10-22', { days: 14, anchor: '2026-10-07' }), '2026-10-21')
check('no schedule: the Payroll page\'s Sunday week', W.weekStartFor('2026-10-22', null), '2026-10-18')
check('twice a month: Sunday week, whatever days + anchor say', W.weekStartFor('2026-10-22', { days: 7, anchor: '2026-09-21', cadence: 'semimonthly' }), '2026-10-18')
check('a 10-day schedule: Sunday week', W.weekStartFor('2026-10-22', { days: 10, anchor: '2026-10-01' }), '2026-10-18')
check('an anchor with no length: Sunday week', W.weekStartFor('2026-10-22', { days: null, anchor: '2026-09-21' }), '2026-10-18')
check('seven days across a month end', W.weekDays('2026-10-26'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
check('days between, both ways', [W.daysBetween('2026-10-19', '2026-10-22'), W.daysBetween('2026-10-22', '2026-10-19')], [3, -3])

// ── Pay per day from running totals ─────────────────────────────────────────
check('no rows is nothing paid', W.payTotals([]), { amount: 0, minutes: 0 })
check('rows add up (numeric strings too), to the cent', W.payTotals([{ labor_total: '101.10', total_minutes: '240' }, { labor_total: 2.25, total_minutes: 15 }]), { amount: 103.35, minutes: 255 })
const through = [{ amount: 203.85, minutes: 453 }, { amount: 380.1, minutes: 845 }, { amount: 380.1, minutes: 845 }, { amount: 571.75, minutes: 1271 }, null, null, null]
const days = W.dayPays(through)
check('each day is its running total less the day before', days.map(d => d && d.amount), [203.85, 176.25, 0, 191.65, null, null, null])
check('…and its minutes', days.map(d => d && d.minutes), [453, 392, 0, 426, null, null, null])
const sum = days.filter(Boolean).reduce((s, d) => Math.round((s + d.amount) * 100) / 100, 0)
check('the days add up to the week to the cent', sum, 571.75)
check('a later clock-in that lowers earlier pay shows as a day below zero', W.dayPays([{ amount: 125, minutes: 0 }, { amount: 62.5, minutes: 0 }]).map(d => d.amount), [125, -62.5])

// ── A CKS-shaped week, America/Phoenix (UTC-7 all year). Made-up times. ─────
Z.setCurrentTz('America/Phoenix')
const at = (ymd, hm) => Date.parse(`${ymd}T${hm}:00-07:00`)
const iso = (ymd, hm) => new Date(at(ymd, hm)).toISOString()
const start = '2026-10-19'
const bounds = W.weekDays(start).map(ymd => ({ ymd, startMs: Z.wallTimeInTz(ymd, 0, 0).getTime(), endMs: Z.wallTimeInTz(W.addDays(ymd, 1), 0, 0).getTime() }))
check('day bounds are company midnights', [bounds[0].startMs, bounds[0].endMs], [at('2026-10-19', '00:00'), at('2026-10-20', '00:00')])
let n = 0
const shift = (ymd, inHm, outHm, extra = {}) => ({
  id: `e${++n}`, user_id: 'me', job_id: null, entry_type: 'shift',
  clocked_in_at: iso(ymd, inHm), clocked_out_at: outHm ? iso(extra.outDay ?? ymd, outHm) : null, pause_reason: null, ...extra,
})
const entries = [
  shift('2026-10-19', '07:57', '15:30'),                                     // Mon: 7 hr 33 min
  shift('2026-10-20', '07:30', '07:31'), shift('2026-10-20', '07:32', '14:05'), // Tue: a slip
  shift('2026-10-21', '08:10', '00:10', { outDay: '2026-10-22', pause_reason: 'Auto-closed: forgot to clock out' }), // Wed: the nightly close
  shift('2026-10-23', '07:45', null),                                        // Fri (today): on the clock
  shift('2026-10-18', '09:00', '15:00'),                                     // last week's: not this week's
]
const job = (id, ymd, s, e, status = 'scheduled') => ({ id, status, job_type: 'clean', scheduled_start: iso(ymd, s), scheduled_end: e ? iso(ymd, e) : null })
const jobs = [
  job('a', '2026-10-19', '08:00', '11:00', 'completed'), job('b', '2026-10-19', '12:00', '15:00', 'completed'),
  job('c', '2026-10-20', '08:00', '14:00', 'completed'),
  job('d', '2026-10-22', '09:00', '13:00'),                       // Thu: on the schedule, no time
  job('e', '2026-10-23', '08:00', '12:00', 'in_progress'), job('f', '2026-10-23', '13:00', null), // Fri: one with no end
  job('g', '2026-10-24', '09:00', '12:00'),                       // Sat: ahead
  job('x', '2026-10-25', '09:00', '12:00', 'cancelled'), job('y', '2026-10-25', '10:00', '11:00', 'pending_approval'), job('z', '2026-10-25', '10:00', '11:00', 'draft'),
]
const payThrough = [{ amount: 203.85, minutes: 453 }, { amount: 351.1, minutes: 847 }, { amount: 692.8, minutes: 1807 }, { amount: 692.8, minutes: 1807 }, { amount: 692.8, minutes: 1807 }, null, null]
const NOW = at('2026-10-23', '10:46')
const wk = W.buildWeek({ days: bounds, entries, jobs, payThrough, nowMs: NOW, todayYmd: '2026-10-23' })
const d = ymd => wk.days.find(x => x.ymd === ymd)
check('the days\' states, Mon to Sun (a day ahead is upcoming, scheduled or not)', wk.days.map(x => x.state), ['worked', 'worked', 'worked', 'missed', 'on_clock', 'upcoming', 'upcoming'])
const past = W.buildWeek({ days: bounds, entries: [], jobs: [], payThrough: [], nowMs: NOW, todayYmd: '2026-10-25' })
check('an earlier day with nothing scheduled or recorded is off', past.days[0].state, 'off')
check('Mon: in and out', [d('2026-10-19').firstInMs, d('2026-10-19').lastOutMs], [at('2026-10-19', '07:57'), at('2026-10-19', '15:30')])
check('Mon: its pay and paid minutes', d('2026-10-19').pay, { amount: 203.85, minutes: 453 })
check('Tue: the slip is one day, first in to last out, 2 entries', [d('2026-10-20').firstInMs, d('2026-10-20').lastOutMs, d('2026-10-20').entries.length], [at('2026-10-20', '07:30'), at('2026-10-20', '14:05'), 2])
check('Wed: a day that ran past midnight belongs to the day it started', d('2026-10-21').lastOutMs, at('2026-10-22', '00:10'))
check('Wed: the nightly close says so', d('2026-10-21').notes, ['Auto-closed: forgot to clock out'])
check('Thu: on the schedule, no time, no pay', [d('2026-10-22').entries.length, d('2026-10-22').pay], [0, { amount: 0, minutes: 0 }])
check('Fri: on the clock since 7:45, 3 hr 1 min so far', [d('2026-10-23').open?.id, Math.floor(d('2026-10-23').workedMs / 60_000)], ['e5', 181])
check('Sat (ahead): pay unknown', d('2026-10-24').pay, null)
check('last week\'s entry isn\'t this week\'s', wk.days.flatMap(x => x.entries.map(e => e.id)).includes('e6'), false)

check('Mon scheduled: 8:00 to 3:00, 2 jobs', d('2026-10-19').sched, { startMs: at('2026-10-19', '08:00'), endMs: at('2026-10-19', '15:00'), ms: 7 * 3_600_000, jobs: 2 })
check('Fri scheduled: a job with no end counts to its start', [d('2026-10-23').sched.endMs, d('2026-10-23').sched.jobs], [at('2026-10-23', '13:00'), 2])
check('Sun: cancelled, waiting for approval and draft jobs are not the schedule', d('2026-10-25').sched, null)
check('Mon: 33 min more than scheduled', W.overUnderMinutes(d('2026-10-19')), 33)
check('Tue: 34 min more (394 paid vs 6 hr on the schedule)', W.overUnderMinutes(d('2026-10-20')), 34)
const lessDay = W.buildWeek({ days: bounds, entries: [shift('2026-10-19', '08:00', '14:00')], jobs, payThrough: [{ amount: 160, minutes: 360 }], nowMs: NOW, todayYmd: '2026-10-23' }).days[0]
check('a short day: 60 min less than scheduled', W.overUnderMinutes(lessDay), -60)
check('no over/under on a day still on the clock, or with no time', [W.overUnderMinutes(d('2026-10-23')), W.overUnderMinutes(d('2026-10-22'))], [null, null])

check('week pay = the running total through today', wk.totals.amount, 692.8)
check('week hours = paid minutes + today\'s clock so far', [wk.totals.minutes, wk.totals.running], [1807 + 181, true])
check('week scheduled = the days\' spans', wk.totals.scheduledMs, (7 + 6 + 4 + 5 + 3) * 3_600_000)

const noPay = W.buildWeek({ days: bounds, entries, jobs, payThrough: null, nowMs: NOW, todayYmd: '2026-10-23' })
check('pay unreadable: no pay anywhere, hours from the clock', [noPay.totals.amount, noPay.days[0].pay, Math.round(noPay.days[0].workedMs / 60_000)], [null, null, 453])

const notYet = W.buildWeek({ days: bounds, entries: [], jobs, payThrough: [{ amount: 0, minutes: 0 }], nowMs: at('2026-10-19', '07:00'), todayYmd: '2026-10-19' })
check('Monday before clocking in: not started yet, $0 so far', [notYet.days[0].state, notYet.totals.amount], ['not_started', 0])

// ── Payday (cut 2: tenants.payroll_payday_offset_days, web 20261022205544_payroll_payday) ──
check('CKS this week, paid 5 days after it ends: Fri Oct 30, in 8 days',
  W.weekPaydays(W.weekDays('2026-10-19'), CKS, 5, '2026-10-22'), [{ startDs: '2026-10-19', endDs: '2026-10-25', payday: '2026-10-30', inDays: 8 }])
check('last week\'s payday is tomorrow', W.weekPaydays(W.weekDays('2026-10-12'), CKS, 5, '2026-10-22').map(p => [p.payday, p.inDays]), [['2026-10-23', 1]])
check('a payday already past counts back', W.weekPaydays(W.weekDays('2026-10-05'), CKS, 5, '2026-10-22').map(p => p.inDays), [-6])
check('no payday set: none', [W.weekPaydays(W.weekDays('2026-10-19'), CKS, null, '2026-10-22'), W.weekPaydays(W.weekDays('2026-10-19'), CKS, -1, '2026-10-22')], [[], []])
const semi = { cadence: 'semimonthly' }
check('twice a month: a Sunday week across the 15th has both halves\' paydays',
  W.weekPaydays(W.weekDays(W.weekStartFor('2026-10-14', semi)), semi, 0, '2026-10-14').map(p => [p.startDs, p.endDs, p.payday]),
  [['2026-10-01', '2026-10-15', '2026-10-15'], ['2026-10-16', '2026-10-31', '2026-10-31']])
check('every 14 days from a Wednesday: a week sits in one period',
  W.weekPaydays(W.weekDays('2026-10-21'), { days: 14, anchor: '2026-10-07' }, 3, '2026-10-22').map(p => [p.startDs, p.endDs, p.payday]),
  [['2026-10-21', '2026-11-03', '2026-11-06']])

// The phone's pay periods are the web's: run the web's own payPeriodContaining
// (rinsebase-app src/lib/payPeriod.ts) over a grid when that repo is here.
const WEB = process.env.RINSEBASE_WEB_REPO || '/Users/toddschaffer/app/rinsebase-app'
if (existsSync(join(WEB, 'src/lib/payPeriod.ts'))) {
  const P = await import(join(WEB, 'src/lib/payPeriod.ts'))
  const schedules = [null, { days: 7, anchor: '2026-09-21' }, { days: 14, anchor: '2026-10-07' }, { days: 10, anchor: '2026-10-01' },
    { cadence: 'semimonthly' }, { days: 7, anchor: '2026-09-21', cadence: 'semimonthly' }, { days: null, anchor: '2026-09-21' }]
  let same = 0, diff = []
  for (const s of schedules) for (let i = -400; i <= 400; i += 3) {
    const ymd = W.addDays('2026-10-22', i)
    const a = W.payPeriodContaining(ymd, s), b = P.payPeriodContaining(ymd, s)
    if (a.startDs === b.startDs && a.endDs === b.endDs) same++; else diff.push([ymd, s, a, b])
  }
  check(`the web's payPeriodContaining agrees on every day and schedule (${same + diff.length} answers)`, diff.slice(0, 3), [])
} else console.log('·  web repo not here: the pay-period parity check is skipped')

const left = W.stillScheduledMs(wk.days, NOW)
check('still on the schedule from Fri 10:46: the rest of Fri (to 1:00) + Sat 3 hr', left, (134 + 180) * 60_000)
check('before today\'s schedule starts, all of it counts', W.stillScheduledMs(notYet.days, at('2026-10-19', '07:00')) >= 7 * 3_600_000, true)
check('hourly: today\'s clock so far + what\'s left, at their rate', W.stillToComePay({ payType: 'hourly', hourlyRate: 27, runningMs: 181 * 60_000, scheduledMs: left }), 222.75)
check('any other pay type, or no rate: no amount',
  [W.stillToComePay({ payType: 'per_job', hourlyRate: 27, runningMs: 0, scheduledMs: left }), W.stillToComePay({ payType: 'hourly', hourlyRate: 0, runningMs: 0, scheduledMs: left }),
   W.stillToComePay({ payType: 'hourly', hourlyRate: null, runningMs: 0, scheduledMs: left })], [null, null, null])

// ── The reads ───────────────────────────────────────────────────────────────
const reads = read('src/lib/myWeekReads.ts')
const code = s => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
check('pay only from crew_pay_for_period', [...code(reads).matchAll(/\.rpc\('([a-z_]+)'/g)].map(m => m[1]), ['crew_pay_for_period'])
check('…for the person themselves', /p_user_id: user\.id/.test(reads), true)
check('…as running totals from the week\'s start to each day\'s last millisecond', /p_start: fromIso, p_end: lastMsOf\(b\)/.test(reads) && /new Date\(b\.endMs - 1\)\.toISOString\(\)/.test(reads), true)
check('…only for the days up to today', /days\.slice\(0, payDays\)\.map/.test(reads), true)
check('their own clock entries only', /\.eq\('user_id', user\.id\)/.test(reads), true)
check('jobs they\'re assigned, confirmed ones only', /job_assignments!inner\(user_id\)/.test(reads) && /\.eq\('job_assignments\.user_id', user\.id\)/.test(reads) && /\.in\('status', SCHEDULED_STATUSES\)/.test(reads), true)
const selects = [...code(reads).matchAll(/\.select\('([^']+)'\)|WEEK_ENTRY_COLUMNS = '([^']+)'/g)].map(m => m[1] || m[2]).join(', ')
check('no rate, price or pay column read', /rate|price|pay_|amount|wage/.test(selects.replace(/payroll_(period_days|anchor_date|cadence|payday_offset_days)/g, '')), false)
check('the payday is its own read (a failure leaves no payday, never a wrong week)',
  /key: `myweek:payday:\$\{tenantId\}`/.test(reads) && /\.select\('payroll_payday_offset_days'\)/.test(reads)
  && !/payroll_payday_offset_days, |, payroll_payday_offset_days/.test(code(reads)), true)
check('a network failure anywhere answers status 0 (the saved copy), whole', /r\.error && r\.status === 0/.test(reads) && /status: 0 \}/.test(reads), true)
check('one saved copy per person, naming its week', /key: `myweek:week:\$\{user\.id\}`/.test(reads) && /weekStart,/.test(reads), true)

// ── The screen ──────────────────────────────────────────────────────────────
const screen = read('src/screens/MyWeekScreen.tsx')
const both = code(screen) + code(reads)
check('nothing written', /\.(insert|update|upsert|delete)\(|writeThrough|writeCacheEntry/.test(both), false)
check('only this week kept offline; earlier weeks read live', /offset === 0\s*\? await cachedRead\(r\)\s*: await Promise\.resolve\(r\.q\(\)\)/.test(screen), true)
check('a saved copy of another week is never shown', /res\.data && res\.data\.weekStart === start/.test(screen), true)
check('no signal and nothing saved for the week: "not saved on this phone", not a raw network error',
  /error: \{ \.\.\.offline\.error, message: offline\.error\?\.message, offline: true \}/.test(reads)
  && /if \(res\.error\?\.offline\) \{[\s\S]{0,200}setNothingSaved\(true\)/.test(screen), true)
check('a failed read drops the "showing what was saved" banner', /\} else if \(res\.error\) \{[\s\S]{0,200}setOffline\(false\)/.test(screen), true)
check('pay asked through today only, never a day ahead', /Math\.min\(7, Math\.max\(0, daysBetween\(start, today\) \+ 1\)\)/.test(screen), true)
check('a queued Start / End on this phone shows as made', /overlayPending\('job_time_entries'/.test(screen), true)
check('no week after this one', /setOffset\(o => Math\.min\(0, o \+ 1\)\)/.test(screen) && /disabled=\{offset === 0\}/.test(screen), true)
check('a failed payday read means no payday', /const paydayOffset: number \| null = pd\.error \? null :/.test(screen), true)
check('still to come: this week only, the estimate from the person\'s own pay type and rate (App.tsx\'s fetchMyPay), no new read',
  /const runningMs = offset === 0 && open \?/.test(screen) && /const leftMs = offset === 0 && view \?/.test(screen)
  && /stillToComePay\(\{ payType: user\.pay_type, hourlyRate: user\.hourly_rate,/.test(screen)
  && !/user_private_details|hourly_rate'/.test(code(screen) + code(reads)), true)

const app = read('App.tsx'), dash = read('src/screens/DashboardScreen.tsx')
check('App opens My week full screen where it isn\'t a tab', /subScreen === 'week'/.test(app) && /<MyWeekScreen user=\{user\} onBack=\{\(\) => setSubScreen\(null\)\} \/>/.test(app) && /if \(screen === 'week' && !weekTab\) \{ setSubScreen\('week'\); return \}/.test(app), true)
check('…and as the Pay tab at a day-shift company (no back button, the tab\'s navigation)',
  /const weekTab = weekTabReplacesMileage\(user\)/.test(app) && /name="Week"[\s\S]{0,200}tabBarLabel: t\('tab_pay'\)/.test(app)
  && /<MyWeekScreen key=\{user\?\.id\} user=\{user\} navigation=\{navigation\} \/>/.test(app), true)
check('Home\'s earnings card opens it (the Pay tab where there is one)', /onPress=\{\(\) => onNavigate\('week'\)\}/.test(dash) && /\{t\('week_open'\)\}/.test(dash) && /week: 'Week'/.test(app), true)
check('as a tab it re-reads each time it\'s opened', /navigation\?\.addListener\?\.\('focus', \(\) => \{ load\(\) \}\)/.test(screen), true)

// ── Strings ─────────────────────────────────────────────────────────────────
const i18n = read('src/lib/i18n.ts')
const block = lang => { const a = i18n.indexOf(`\n  ${lang}: {`); const rest = i18n.slice(a + 5); const b = rest.search(/\n  [a-z]{2}: \{|\n\}\n/); return rest.slice(0, b) }
const used = new Set([...screen.matchAll(/\bt\('([a-z0-9_]+)'\)/g), ...dash.matchAll(/\bt\('(week_[a-z0-9_]+)'\)/g)].map(m => m[1]))
for (const k of ['week_more', 'week_less', 'week_load_failed']) used.add(k) // picked by a ternary, or read through tRef
used.add('tab_pay') // the tab's label, in App.tsx
for (const lang of ['en', 'es', 'pt']) {
  const b = block(lang)
  const missing = [...used].filter(k => !new RegExp(`\\n\\s+${k}:`).test(b))
  check(`every string the screen uses exists in ${lang}`, missing, [])
}
const weekKeys = lang => [...block(lang).matchAll(/\n\s+(week_[a-z0-9_]+):/g)].map(m => m[1]).sort()
check('Spanish and Portuguese have the same week strings as English', [weekKeys('es'), weekKeys('pt')], [weekKeys('en'), weekKeys('en')])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
