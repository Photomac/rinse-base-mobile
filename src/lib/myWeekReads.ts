// The reads behind "My week" (screens/MyWeekScreen, rules in lib/myWeek).
//
// The company's pay schedule picks the week; then one read for the week: the
// person's own clock entries, the jobs they're assigned (for the time on the
// schedule), and the pay resolver's running totals through each day so far.
// Pay comes only from crew_pay_for_period, which answers a crew member about
// themselves: no rate or price column is read here.
//
// Only the CURRENT week is kept for offline, under one key per person, so the
// cache doesn't grow a copy per week looked at. An earlier week is read live.
// The saved copy names its week; a copy from another week is never shown.
import { supabase } from './supabase'
import type { CacheRead } from './dataCache'
import { SCHEDULED_STATUSES, payTotals, type DayBounds, type PaySoFar, type PaySchedule, type WeekJob } from './myWeek'
import type { TeamEntry } from './teamDay'

export const WEEK_ENTRY_COLUMNS = 'id, user_id, job_id, entry_type, clocked_in_at, clocked_out_at, duration_minutes, pause_reason'

export type WeekData = {
  weekStart: string
  entries: TeamEntry[]
  jobs: WeekJob[]
  /** running pay totals through each day asked; null when the pay read failed */
  payThrough: (PaySoFar | null)[] | null
  payError: string | null
}

/** The pay schedule the week follows (lib/myWeek weekStartFor). */
export function myWeekScheduleRead(tenantId: string): CacheRead {
  return {
    key: `myweek:sched:${tenantId}`,
    q: () => supabase.from('tenants')
      .select('payroll_period_days, payroll_anchor_date, payroll_cadence')
      .eq('id', tenantId)
      .maybeSingle(),
  }
}

export function scheduleOf(row: any): PaySchedule | null {
  if (!row) return null
  return { days: row.payroll_period_days ?? null, anchor: row.payroll_anchor_date ?? null, cadence: row.payroll_cadence ?? null }
}

/** The resolver's window end for a day: its last millisecond, inclusive, as
 *  the Payroll page sends it (crew_pay_for_period compares clocked_in_at <= p_end). */
const lastMsOf = (b: DayBounds) => new Date(b.endMs - 1).toISOString()

/**
 * The week `days` for `user`. Pay is asked for days[0..payDays-1] only (the
 * days up to today; a day still ahead has nothing to pay). One answer for all
 * of it: a network failure anywhere falls back to the saved copy whole; a
 * server error on the entries or jobs fails the read; a pay error leaves the
 * times showing with the pay unknown.
 */
export function myWeekRead(user: { id: string; tenant_id: string }, days: DayBounds[], payDays: number): CacheRead {
  const weekStart = days[0].ymd
  const fromIso = new Date(days[0].startMs).toISOString()
  const toIso = new Date(days[days.length - 1].endMs).toISOString()
  return {
    key: `myweek:week:${user.id}`,
    q: () => (async () => {
      const [e, j, ...pays]: any[] = await Promise.all([
        supabase.from('job_time_entries')
          .select(WEEK_ENTRY_COLUMNS)
          .eq('tenant_id', user.tenant_id)
          .eq('user_id', user.id)
          .gte('clocked_in_at', fromIso)
          .lt('clocked_in_at', toIso)
          .order('clocked_in_at')
          .limit(500),
        supabase.from('jobs')
          .select('id, status, job_type, scheduled_start, scheduled_end, job_assignments!inner(user_id)')
          .eq('tenant_id', user.tenant_id)
          .eq('job_assignments.user_id', user.id)
          .in('status', SCHEDULED_STATUSES)
          .gte('scheduled_start', fromIso)
          .lt('scheduled_start', toIso)
          .order('scheduled_start')
          .limit(300),
        ...days.slice(0, payDays).map(b => supabase.rpc('crew_pay_for_period', {
          p_start: fromIso, p_end: lastMsOf(b), p_user_id: user.id,
        })),
      ])
      // `offline: true` marks it for the screen: with nothing saved, cachedRead
      // hands this error back as is, and "not saved on this phone" is the answer.
      const offline = [e, j, ...pays].find(r => r.error && r.status === 0)
      if (offline) return { data: null, error: { ...offline.error, message: offline.error?.message, offline: true }, status: 0 }
      const failed = [e, j].find(r => r.error)
      if (failed) return { data: null, error: failed.error, status: failed.status }
      const payFailed = pays.find(r => r.error)
      const data: WeekData = {
        weekStart,
        entries: (e.data ?? []) as TeamEntry[],
        jobs: ((j.data ?? []) as any[]).map(x => ({
          id: x.id, status: x.status, job_type: x.job_type, scheduled_start: x.scheduled_start, scheduled_end: x.scheduled_end,
        })),
        payThrough: payFailed ? null : days.map((_, i) => (i < payDays ? payTotals(pays[i].data) : null)),
        payError: payFailed ? (payFailed.error?.message || String(payFailed.error)) : null,
      }
      return { data, error: null, status: 200 }
    })(),
  }
}
