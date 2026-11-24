// "Fix my times": a crew member asks the office to fix a day's Start my day /
// End my day, or to add a day they forgot to start (True Shine Cleaning
// Services, Elle, 2026-11-23: "employees frequently forget to clock in or out,
// allowing them to adjust their time directly—and having that change sent to an
// admin for approval—would make the process much easier").
//
// The ask goes to the server (rinsebase-app 20261123220100_time_fix_requests:
// request_time_fix), which checks it again and keeps it until the office
// approves or declines it on the web (Team → Time logs). Nothing about the day
// changes until then: the hours on My week stay what the phone recorded.
//
// Also "Start my day before a clean" (tenants.clean_start_needs_day,
// 20261123220000_clean_start_needs_day): at a company that turned it on, Start
// on a clean asks a crew member with no day running to start their day first.
//
// Pure: the screens (components/TimeFixSheet, screens/DashboardScreen,
// screens/MyWeekScreen, screens/JobDetailScreen) do the reading and sending.
import type { TranslationKey } from './i18n'

/** The server's own limits (request_time_fix). */
export const FIX_MAX_MS = 16 * 3600_000
export const FIX_DAYS_BACK = 14
/** The server allows an end up to 5 minutes ahead of its clock. */
const FUTURE_GRACE_MS = 5 * 60_000

export type FixProblem = 'no_start' | 'no_end' | 'order' | 'long' | 'future' | 'same'

/**
 * Why the picked times can't be sent, or null. `was` is what the day says now
 * (null for a day never started): asking for the same times is nothing to fix.
 */
export function fixProblem(o: { inMs: number; outMs: number; nowMs: number; was?: { inMs: number; outMs: number } | null }): FixProblem | null {
  if (!Number.isFinite(o.inMs)) return 'no_start'
  if (!Number.isFinite(o.outMs)) return 'no_end'
  if (o.outMs <= o.inMs) return 'order'
  if (o.outMs - o.inMs > FIX_MAX_MS) return 'long'
  if (o.outMs > o.nowMs + FUTURE_GRACE_MS) return 'future'
  if (o.was && Math.floor(o.was.inMs / 60_000) === Math.floor(o.inMs / 60_000)
      && Math.floor(o.was.outMs / 60_000) === Math.floor(o.outMs / 60_000)) return 'same'
  return null
}

export const FIX_PROBLEM_KEYS: Record<FixProblem, TranslationKey> = {
  no_start: 'fix_p_no_start',
  no_end: 'fix_p_no_end',
  order: 'fix_p_order',
  long: 'fix_p_long',
  future: 'fix_p_future',
  same: 'fix_p_same',
}

/** Whether a day ('YYYY-MM-DD', company clock) can still be fixed from the app:
 *  today and the 14 days before it. Older days are the office's. */
export function withinFixWindow(ymd: string, todayYmd: string): boolean {
  if (!ymd || !todayYmd || ymd > todayYmd) return false
  const a = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))
  const b = Date.UTC(+todayYmd.slice(0, 4), +todayYmd.slice(5, 7) - 1, +todayYmd.slice(8, 10))
  return (b - a) / 86_400_000 <= FIX_DAYS_BACK
}

/** Quick reasons the crew can tap (their words, sent as written in English so
 *  the office reads one language; the crew see them in theirs). */
export const FIX_REASONS: { value: string; key: TranslationKey }[] = [
  { value: 'Forgot to start my day', key: 'fix_chip_forgot_start' },
  { value: 'Forgot to end my day', key: 'fix_chip_forgot_end' },
  { value: 'Phone died or no signal', key: 'fix_chip_phone' },
]

/**
 * The server's refusal in the crew's words. request_time_fix raises fixed
 * English messages; a message not listed here shows as the server wrote it.
 * A failed request with no answer (no signal) is `offline`.
 */
export function fixErrorKey(error: any): TranslationKey | null {
  const m = String(error?.message ?? error ?? '')
  if (!m || /network|fetch|timed? ?out|abort|offline/i.test(m)) return 'fix_no_signal'
  if (/run into another day/i.test(m)) return 'fix_e_overlap'
  if (/payroll already approved/i.test(m)) return 'fix_e_paid'
  if (/last 14 days/i.test(m)) return 'fix_e_old'
  if (/end your day first/i.test(m)) return 'fix_e_running'
  if (/already that day/i.test(m)) return 'fix_p_same'
  if (/at most 16 hours/i.test(m)) return 'fix_p_long'
  if (/after the start/i.test(m)) return 'fix_p_order'
  if (/in the future/i.test(m)) return 'fix_p_future'
  if (/same day/i.test(m)) return 'fix_e_same_day'
  if (/could not be found/i.test(m)) return 'fix_e_not_found'
  if (/say what happened/i.test(m)) return 'fix_p_reason'
  if (/pick both times/i.test(m)) return 'fix_p_no_end'
  if (/only a day/i.test(m)) return 'fix_e_only_day'
  // a per-clean company (the app only offers it at day-shift ones), or the
  // database before its migration: the feature isn't there yet
  if (/day-shift companies/i.test(m)) return 'fix_e_not_ready'
  if (/request_time_fix|PGRST202|schema cache/i.test(m)) return 'fix_e_not_ready'
  return null
}

export type FixAsk = {
  id: string
  time_entry_id: string | null
  work_date: string
  asked_in: string
  asked_out: string
  status: 'pending' | 'approved' | 'declined' | 'replaced'
  review_note: string | null
  created_at: string
}

/**
 * What a day of My week says about its asks: the newest one that counts (a
 * replaced ask is the crew's own earlier version, never shown). null = none.
 */
export function dayFixLine(asks: FixAsk[], ymd: string): { status: 'pending' | 'approved' | 'declined'; note: string | null } | null {
  const mine = asks.filter(a => a.work_date === ymd && a.status !== 'replaced')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  const top = mine[0]
  if (!top) return null
  return { status: top.status as 'pending' | 'approved' | 'declined', note: top.review_note }
}

/** A day shift whose times can be fixed: closed, the person's own, no clean. */
export function fixableShift(e: { entry_type?: string | null; job_id?: string | null; clocked_out_at?: string | null }): boolean {
  return (e.entry_type ?? 'work') === 'shift' && !e.job_id && !!e.clocked_out_at
}

/**
 * Start my day before a clean (tenants.clean_start_needs_day): whether Start on
 * a clean stops and asks for the day first. Only a day-shift crew member at a
 * company with the switch on, not someone recording a cleaner's time, and not
 * owners, admins and managers (they start cleans for others). `dayRunning` null
 * = the phone can't tell (no signal, nothing saved): never stopped then.
 */
export function dayNeededFirst(o: { dailyMode: boolean; switchOn: boolean; officeExempt: boolean; recordsForOthers: boolean; dayRunning: boolean | null }): boolean {
  return o.dailyMode && o.switchOn && !o.officeExempt && !o.recordsForOthers && o.dayRunning === false
}

/** From the open-shift read (lib/jobReads dashShiftRead, a row or null) and the
 *  phone's queued punches overlaid on it: is a day running? */
export function dayRunningFrom(rows: { clocked_out_at?: string | null; entry_type?: string | null }[]): boolean {
  return rows.some(r => !r.clocked_out_at && (r.entry_type == null || r.entry_type === 'shift'))
}
