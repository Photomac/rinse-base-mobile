// A cleaner's own week, set from the app (tenants.crew_set_availability, web
// migration 20261102190000). ACM Management asked for it on 2026-11-02: their
// contractors' days change, and one was given a clean on a day she couldn't work.
//
// It writes the same crew_availability rows as the office's Availability page,
// under the SAME rule, which lives in the web repo (src/lib/weeklySchedule.ts) and
// in SQL (crew_off_by_weekly_schedule), so auto-assign and the job board follow it:
//   • no rows at all: works any day;
//   • otherwise they work only a day with an is_available row.
// So the first day switched off has to write the OTHER six days. A row-set with
// no day ticked would read as off every day, so the last day can't be switched off.
//
// Pure: no imports, so scripts/test-crew-schedule.mjs runs it as is.

export interface ScheduleRow {
  id?: string
  day_of_week: number // 0 = Sunday … 6 = Saturday
  is_available: boolean
  every_other_week?: boolean | null
  week_anchor?: string | null
}

export type DayTap =
  | { kind: 'insert'; days: number[] }
  | { kind: 'update'; id: string; patch: { is_available: boolean; every_other_week?: false; week_anchor?: null } }
  | { kind: 'last_day' }

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

/** Do they work this weekday? No rows means any day. */
export function worksDay(rows: ScheduleRow[], dow: number): boolean {
  return !rows.length || rows.some(r => r.day_of_week === dow && r.is_available)
}

/** What tapping one day writes. */
export function planDayTap(rows: ScheduleRow[], dow: number): DayTap {
  if (!rows.length) return { kind: 'insert', days: ALL_DAYS.filter(d => d !== dow) }
  const day = rows.find(r => r.day_of_week === dow)
  if (!day) return { kind: 'insert', days: [dow] }
  if (!day.is_available) return { kind: 'update', id: day.id as string, patch: { is_available: true } }
  if (!rows.some(r => r !== day && r.is_available)) return { kind: 'last_day' }
  // Off stops any every-other-week pattern too, as the office grid does, so
  // switching it back on starts from plain weekly.
  return { kind: 'update', id: day.id as string, patch: { is_available: false, every_other_week: false, week_anchor: null } }
}

/** How many of these clean days ('YYYY-MM-DD', from dayKey) fall on this weekday. */
export function cleansOnWeekday(dayKeys: string[], dow: number): number {
  return dayKeys.filter(k => new Date(`${k}T12:00:00Z`).getUTCDay() === dow).length
}
