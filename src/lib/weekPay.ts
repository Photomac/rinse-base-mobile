// My Week's pay: the running total through each day of the week so far, in one
// request.
//
// crew_pay_through_days(start, ends[], user) (rinse-base-app
// 20261120163437_crew_pay_through_days) answers, for each day end and numbered
// from 1, exactly the rows crew_pay_for_period(start, that end, user) returns,
// asked as the person: the same pay the Payroll page pays, the same checks.
// My Week used to send one crew_pay_for_period request per day, all at once:
// on a Saturday six in one burst, every time the screen loaded, queueing behind
// each other at the server (118 ms on average where the whole week takes
// 6-35 ms in one go; API logs 2026-11-19/20).
//
// The answer comes back in the shape myWeekRead already reads: one
// { data, error, status } per day, data being that day's crew_pay_for_period
// rows. One request means one outcome: a failure (no signal, a server error, a
// malformed answer) is every day's failure, as one failed day already made the
// whole week's pay unknown. A server without the batch (it was dropped) gets
// the old per-day calls.
import { batchMissing, type Rpc } from './closingBlockers'

export type DayPay = { data: any; error: any; status?: number }

/** The batch's rows split by day: day i's crew_pay_for_period rows, in order,
 *  or null when the answer isn't the batch's shape. */
export function payRowsByDay(rows: unknown, days: number): any[][] | null {
  if (!Array.isArray(rows)) return null
  const out: any[][] = Array.from({ length: days }, () => [])
  for (const r of rows as any[]) {
    const i = r?.day_index
    if (!Number.isInteger(i) || i < 1 || i > days || !r || !('pay' in r)) return null
    out[i - 1].push(r.pay)
  }
  return out
}

/** The pay through each of `ends` (each day's last millisecond) from `start`,
 *  for `userId`: one entry per end, as the per-day reads answered. */
export async function weekPayThrough(rpc: Rpc, start: string, ends: string[], userId: string): Promise<DayPay[]> {
  if (ends.length === 0) return []
  const res: DayPay = await Promise.resolve(rpc('crew_pay_through_days', { p_start: start, p_ends: ends, p_user_id: userId }))
    .catch((e: any) => ({ data: null, error: e ?? true, status: 0 }))
  if (res.error && (batchMissing(res.error) || res.status === 404)) {
    return Promise.all(ends.map(end => Promise.resolve(rpc('crew_pay_for_period', { p_start: start, p_end: end, p_user_id: userId }))
      .catch((e: any) => ({ data: null, error: e ?? true, status: 0 }))))
  }
  if (res.error) return ends.map(() => ({ data: null, error: res.error, status: res.status }))
  const byDay = payRowsByDay(res.data, ends.length)
  if (!byDay) {
    const error = { message: 'crew_pay_through_days: unexpected answer' }
    return ends.map(() => ({ data: null, error, status: res.status }))
  }
  return byDay.map(rows => ({ data: rows, error: null, status: res.status }))
}
