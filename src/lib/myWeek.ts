// "My week": a crew member's own week on the phone. Each day's pay, hours and
// clock-in/out times, the time on the schedule beside it, and the week's totals.
//
// CKS Perfections asked on 2026-10-08 with Homebase screenshots ("$203.85 for
// 7 hr 33 min, 7:57 AM – 3:30 PM"): the crew like seeing the week add up, and
// it's the screen they'd open instead of asking the office.
//
// Pay comes from crew_pay_for_period, the resolver the Payroll page pays from.
// It is asked for running totals, never single days: Monday, then Monday
// through Tuesday, and so on, each day being the difference from the day
// before. Days asked for one at a time don't add up to the week: an entry that
// runs past midnight into the next day's clean overlaps it, and the week pays
// the overlap once while two single days each pay it (Z & K, week of
// 2026-10-12: 406 minutes counted twice). Running totals add up to exactly
// what the week pays. The one cost: a day can come out lower, or below zero,
// when a later clock-in changes an earlier day's pay (a pooled clean split
// again when a second crew member clocks it; Rhyne, once in ~285 person-weeks).
//
// The week is the pay week: seven days tiled from the company's payroll anchor
// when its periods are whole weeks (CKS: Monday to Sunday), otherwise the
// Sunday-to-Saturday week the Payroll page defaults to.
//
// Pure (no React, no Supabase) so scripts/test-my-week.mjs runs it under Node.

import { workedMs, type TeamEntry } from './teamDay'

/** tenants.payroll_period_days / payroll_anchor_date / payroll_cadence. */
export type PaySchedule = { days?: number | null; anchor?: string | null; cadence?: string | null }

/** A job is on someone's schedule once the office confirmed it. Drafts and
 *  cleans waiting for approval aren't yet; cancelled ones and no-shows aren't. */
export const SCHEDULED_STATUSES = ['scheduled', 'en_route', 'in_progress', 'completed']

const DAY_MS = 86_400_000

function ymdUtc(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, (m || 1) - 1, d || 1)
}

/** 'YYYY-MM-DD' moved by whole days (calendar arithmetic, no zone involved). */
export function addDays(ymd: string, n: number): string {
  return new Date(ymdUtc(ymd) + n * DAY_MS).toISOString().slice(0, 10)
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((ymdUtc(b) - ymdUtc(a)) / DAY_MS)
}

/** The first day of the pay week holding `ymd`. */
export function weekStartFor(ymd: string, schedule?: PaySchedule | null): string {
  const days = Number(schedule?.days) || 0
  const anchor = schedule?.anchor ? String(schedule.anchor).slice(0, 10) : null
  if (schedule?.cadence !== 'semimonthly' && anchor && days > 0 && days % 7 === 0) {
    return addDays(anchor, Math.floor(daysBetween(anchor, ymd) / 7) * 7)
  }
  return addDays(ymd, -new Date(ymdUtc(ymd)).getUTCDay())
}

/** The week's seven days, first to last. */
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/** What the pay resolver answered for a window: its pay and paid minutes.
 *  No rows (nothing worked yet) is zero. */
export type PaySoFar = { amount: number; minutes: number }

export function payTotals(rows: any[] | null | undefined): PaySoFar {
  let amount = 0, minutes = 0
  for (const r of rows ?? []) {
    amount += Number(r?.labor_total) || 0
    minutes += Number(r?.total_minutes) || 0
  }
  return { amount: Math.round(amount * 100) / 100, minutes: Math.round(minutes) }
}

/** Each day's pay from the running totals through each day (null = not asked:
 *  a day still ahead). Rounded totals subtracted, so the days add up to the
 *  week to the cent. */
export function dayPays(through: (PaySoFar | null)[]): (PaySoFar | null)[] {
  let prev: PaySoFar = { amount: 0, minutes: 0 }
  return through.map(cum => {
    if (!cum) return null
    const day = { amount: Math.round((cum.amount - prev.amount) * 100) / 100, minutes: cum.minutes - prev.minutes }
    prev = cum
    return day
  })
}

export type WeekJob = {
  id: string
  status: string
  job_type?: string | null
  scheduled_start?: string | null
  scheduled_end?: string | null
}

export type DayBounds = { ymd: string; startMs: number; endMs: number }

export type DaySchedule = { startMs: number; endMs: number; ms: number; jobs: number }

/** First assigned job's start to the last one's end: the closest thing the
 *  schedule has to a shift, since the drive between homes isn't on it. */
export function scheduledSpan(jobs: WeekJob[]): DaySchedule | null {
  let start = Infinity, end = -Infinity, n = 0
  for (const j of jobs) {
    if (!SCHEDULED_STATUSES.includes(j.status)) continue
    const s = Date.parse(j.scheduled_start || '')
    if (!Number.isFinite(s)) continue
    const e = Date.parse(j.scheduled_end || '')
    start = Math.min(start, s)
    end = Math.max(end, Number.isFinite(e) && e > s ? e : s)
    n++
  }
  return n ? { startMs: start, endMs: end, ms: end - start, jobs: n } : null
}

export type DayState =
  | 'worked'      // time recorded, all of it ended
  | 'on_clock'    // a clock-in still running
  | 'not_started' // today, on the schedule, no clock-in yet
  | 'missed'      // an earlier day on the schedule with no time recorded
  | 'upcoming'    // a day still ahead
  | 'off'         // nothing scheduled, nothing recorded

export type WeekDay = {
  ymd: string
  isToday: boolean
  /** clock entries that began this day, oldest first */
  entries: TeamEntry[]
  firstInMs: number | null
  /** the latest clock-out, when nothing is running */
  lastOutMs: number | null
  open: TeamEntry | null
  /** time on the clock, overlaps once; a running entry counts to now */
  workedMs: number
  /** the day's pay and paid minutes (ended entries only); null when not known */
  pay: PaySoFar | null
  sched: DaySchedule | null
  /** server notes on the day's entries ("Auto-closed: forgot to clock out", ...) */
  notes: string[]
  state: DayState
}

export type WeekTotals = {
  /** pay for the week so far; null when the pay couldn't be read */
  amount: number | null
  /** minutes shown for the week: paid minutes, plus a running clock so far */
  minutes: number
  running: boolean
  scheduledMs: number
}

export function buildWeek(p: {
  days: DayBounds[]
  entries: TeamEntry[]
  jobs: WeekJob[]
  /** running pay totals through each day, as read (null for a day not asked);
   *  null altogether when the pay couldn't be read */
  payThrough: (PaySoFar | null)[] | null
  nowMs: number
  todayYmd: string
}): { days: WeekDay[]; totals: WeekTotals } {
  const pays = p.payThrough ? dayPays(p.payThrough) : null
  const out: WeekDay[] = p.days.map((b, i) => {
    const entries = p.entries
      .filter(e => { const s = Date.parse(e.clocked_in_at); return Number.isFinite(s) && s >= b.startMs && s < b.endMs })
      .sort((x, y) => Date.parse(x.clocked_in_at) - Date.parse(y.clocked_in_at))
    const running = entries.filter(e => !e.clocked_out_at)
    const open = running.length ? running[running.length - 1] : null
    const ends = entries.map(e => Date.parse(e.clocked_out_at || '')).filter(Number.isFinite)
    const sched = scheduledSpan(p.jobs.filter(j => {
      const s = Date.parse(j.scheduled_start || '')
      return Number.isFinite(s) && s >= b.startMs && s < b.endMs
    }))
    const isToday = b.ymd === p.todayYmd
    const ahead = b.ymd > p.todayYmd
    const state: DayState = open ? 'on_clock'
      : entries.length ? 'worked'
      : ahead ? 'upcoming'
      : sched ? (isToday ? 'not_started' : 'missed')
      : 'off'
    return {
      ymd: b.ymd, isToday, entries,
      firstInMs: entries.length ? Date.parse(entries[0].clocked_in_at) : null,
      lastOutMs: open || !ends.length ? null : Math.max(...ends),
      open,
      workedMs: workedMs(entries, p.nowMs),
      pay: pays ? pays[i] ?? null : null,
      sched,
      notes: Array.from(new Set(entries.map(e => (e.pause_reason || '').trim()).filter(r => /^Auto-closed/i.test(r)))),
      state,
    }
  })

  let minutes = 0
  let running = false
  for (const d of out) {
    if (d.open) {
      running = true
      minutes += Math.floor(d.workedMs / 60_000)
    } else if (d.pay) {
      minutes += d.pay.minutes
    } else if (d.entries.length) {
      minutes += Math.round(d.workedMs / 60_000)
    }
  }
  const asked = p.payThrough ? p.payThrough.filter((x): x is PaySoFar => !!x) : []
  return {
    days: out,
    totals: {
      amount: p.payThrough ? (asked.length ? asked[asked.length - 1].amount : 0) : null,
      minutes,
      running,
      scheduledMs: out.reduce((s, d) => s + (d.sched?.ms ?? 0), 0),
    },
  }
}

// ── Payday ──────────────────────────────────────────────────────────────────
// tenants.payroll_payday_offset_days: days after a pay period's last day that
// the crew are paid (web Payroll sets it; 20261022210000_payroll_payday). The
// periods are the web's (src/lib/payPeriod.ts payPeriodContaining): twice a
// month the 1st–15th and the 16th to the month's end; otherwise tiled from the
// anchor by the period's length; with no schedule, the Sunday week.

export type PayPeriod = { startDs: string; endDs: string }

export function payPeriodContaining(ymd: string, schedule?: PaySchedule | null): PayPeriod {
  if (schedule?.cadence === 'semimonthly') {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
    const day = (month: number, n: number) => new Date(Date.UTC(y, month, n)).toISOString().slice(0, 10)
    return d <= 15 ? { startDs: day(m - 1, 1), endDs: day(m - 1, 15) } : { startDs: day(m - 1, 16), endDs: day(m, 0) }
  }
  const days = Number(schedule?.days) || 0
  const anchor = schedule?.anchor ? String(schedule.anchor).slice(0, 10) : null
  if (anchor && days > 0) {
    const startDs = addDays(anchor, Math.floor(daysBetween(anchor, ymd) / days) * days)
    return { startDs, endDs: addDays(startDs, days - 1) }
  }
  const startDs = addDays(ymd, -new Date(ymdUtc(ymd)).getUTCDay())
  return { startDs, endDs: addDays(startDs, 6) }
}

export type Payday = PayPeriod & { payday: string; /** whole days from today: 0 today, 1 tomorrow, <0 past */ inDays: number }

/** The paydays for the pay periods a week's days fall in (one, unless a period
 *  ends mid-week: twice a month, or an odd length). None when no payday is set. */
export function weekPaydays(days: string[], schedule: PaySchedule | null | undefined, offsetDays: number | null | undefined, todayYmd: string): Payday[] {
  if (offsetDays == null) return []
  const n = Number(offsetDays)
  if (!Number.isInteger(n) || n < 0) return []
  const out: Payday[] = []
  for (const d of days) {
    const p = payPeriodContaining(d, schedule)
    if (out.some(x => x.startDs === p.startDs)) continue
    const payday = addDays(p.endDs, n)
    out.push({ ...p, payday, inDays: daysBetween(todayYmd, payday) })
  }
  return out
}

/** What's left of the week's schedule from now: the rest of today's span (from
 *  now, or from its start if that's later) and every day still ahead. */
export function stillScheduledMs(days: WeekDay[], nowMs: number): number {
  let ms = 0
  for (const d of days) {
    if (!d.sched) continue
    if (d.state === 'upcoming') ms += d.sched.ms
    else if (d.isToday) ms += Math.max(0, d.sched.endMs - Math.max(nowMs, d.sched.startMs))
  }
  return ms
}

/** The pay still to come this week, for hourly crew only: today's clock so far
 *  (not paid until it ends) plus what's left on the schedule, at their hourly
 *  rate. An estimate: a clean paid by the property's rate card, or a schedule
 *  that changes, comes out different. Null for any other pay type. */
export function stillToComePay(p: { payType?: string | null; hourlyRate?: number | null; runningMs: number; scheduledMs: number }): number | null {
  const rate = Number(p.hourlyRate)
  if (p.payType !== 'hourly' || !(rate > 0)) return null
  return Math.round(((p.runningMs + p.scheduledMs) / 3_600_000) * rate * 100) / 100
}

/** A day's minutes worked minus its scheduled minutes, for "33 min more than
 *  scheduled". Null unless both are known and the day's time has ended. */
export function overUnderMinutes(d: WeekDay): number | null {
  if (d.state !== 'worked' || !d.sched || !d.sched.ms) return null
  const actual = d.pay ? d.pay.minutes : Math.round(d.workedMs / 60_000)
  return actual - Math.round(d.sched.ms / 60_000)
}
