// The office's rules for fixing someone's clock from the phone: which end to
// suggest for an open clock-in, and which starts and ends can be saved. A port
// of the web app's src/lib/endDay.ts (rinsebase-app: "End their day at…",
// #1158, and Payroll's "Start their day", #1628), so the phone and the laptop
// accept and refuse the same times. The web returns English sentences; here a
// problem is a code the screen words in the crew app's languages.
//
// The database backs these up: job_time_entries_one_open_shift (one open day
// per person), guard_closed_time_entry_times (once a row is closed only the
// office can move its times, and only with edited_at set), and
// clamp_crew_time_entry_start (crew starts clamped to the last 16 h; the office
// is exempt, which is why the 16 h rule is checked here).
//
// Pure (no React, no Supabase, no imports) so scripts/test-team-today.mjs runs
// it under Node as is. Times are epoch ms.

const MIN = 60_000
const HOUR = 60 * MIN

/** The most close_stale_shifts() gives a forgotten day shift (16 h). */
export const SHIFT_CAP_MS = 16 * HOUR
/** A picked end this far past "now" is allowed (and saved as now): clocks drift. */
export const FUTURE_GRACE_MS = MIN
/** A start this far past "now" is allowed (and saved as now), as on the web. */
export const START_FUTURE_GRACE_MS = 5 * MIN

export type EntryKind = 'shift' | 'job'

/** A day shift ("Start my day"), or a clock-in on one job. */
export function entryKind(e: { entry_type?: string | null }): EntryKind {
  return e.entry_type === 'shift' ? 'shift' : 'job'
}

export type DayClean = {
  id: string
  status: string
  completedAt: string | null
  /** users.id of whoever pressed Complete */
  completedById: string | null
  /** the person is on this clean's crew (job_assignments) */
  assigned: boolean
}

export type SuggestionReason =
  | 'own_completion'   // the last clean they completed themselves
  | 'crew_completion'  // the last clean on their crew that completed; someone else pressed Complete
  | 'now'
  | 'next_start'       // their next shift (or next clock-in on the job) began before now
  | 'shift_cap'        // 16 h after the start, what the nightly auto-close would record
  | 'scheduled_length' // per-job: clock-in + the job's scheduled length

export type Suggestion = { ms: number; reason: SuggestionReason; cleanId?: string }

function upperBound(startMs: number, nowMs: number, nextStartMs?: number | null): Suggestion {
  if (nextStartMs != null && nextStartMs > startMs && nextStartMs < nowMs) return { ms: nextStartMs, reason: 'next_start' }
  return { ms: nowMs, reason: 'now' }
}

/**
 * The end time to offer for an open entry, as the web's EndDayDialog does.
 * Day shift: the last clean the person completed themselves after the start,
 * else the last completed clean on their crew, else now; only completions
 * inside the shift's own window (after the start, by now or their next start,
 * within 16 h). Per-job clock-in: clock-in + the job's scheduled length
 * (1-16 h, 4 h when unknown), or now if that hasn't come yet.
 */
export function suggestEnd(p: {
  kind: EntryKind
  startMs: number
  nowMs: number
  nextStartMs?: number | null
  personId: string
  cleans?: DayClean[]
  jobScheduledStart?: string | null
  jobScheduledEnd?: string | null
}): Suggestion {
  const bound = upperBound(p.startMs, p.nowMs, p.nextStartMs)

  if (p.kind === 'job') {
    const span = p.jobScheduledStart && p.jobScheduledEnd
      ? Date.parse(p.jobScheduledEnd) - Date.parse(p.jobScheduledStart)
      : NaN
    const cap = Number.isFinite(span) ? Math.min(SHIFT_CAP_MS, Math.max(HOUR, span)) : 4 * HOUR
    const at = p.startMs + cap
    return at <= bound.ms ? { ms: at, reason: 'scheduled_length' } : bound
  }

  const windowEnd = Math.min(bound.ms, p.startMs + SHIFT_CAP_MS)
  const done = (p.cleans ?? [])
    .filter(c => c.status === 'completed' && c.completedAt)
    .map(c => ({ c, t: Date.parse(c.completedAt as string) }))
    .filter(x => Number.isFinite(x.t) && x.t > p.startMs && x.t <= windowEnd)
  const latest = (xs: typeof done) => xs.reduce((a, b) => (b.t > a.t ? b : a))

  const own = done.filter(x => x.c.completedById === p.personId)
  if (own.length) { const x = latest(own); return { ms: x.t, reason: 'own_completion', cleanId: x.c.id } }
  const crew = done.filter(x => x.c.assigned)
  if (crew.length) { const x = latest(crew); return { ms: x.t, reason: 'crew_completion', cleanId: x.c.id } }
  if (windowEnd < bound.ms) return { ms: windowEnd, reason: 'shift_cap' }
  return bound
}

/** Why a time can't be saved. The screen turns each code into a sentence. */
export type TimeProblem =
  | { code: 'no_time' }
  /** an end before the start: check the AM/PM */
  | { code: 'before_start'; kind: EntryKind; startMs: number }
  | { code: 'zero_length' }
  /** a corrected clock-in after the clock-out: check the AM/PM */
  | { code: 'after_end'; endMs: number }
  | { code: 'future'; nowMs: number }
  /** an end after their next shift (or next clock-in on the job) began */
  | { code: 'after_next'; kind: EntryKind; nextMs: number }
  /** the office starting an open day more than 16 h ago */
  | { code: 'too_old' }

/**
 * An end time for an entry (ending an open one, or fixing a clock-out). After
 * the start, not in the future, and not after the person's next shift started
 * (their next clock-in on the same job, for a per-job entry): ending there
 * would pay the same minutes twice. The web's validateEnd.
 */
export function validateEnd(p: {
  kind: EntryKind
  startMs: number
  endMs: number
  nowMs: number
  nextStartMs?: number | null
}): TimeProblem | null {
  if (!Number.isFinite(p.endMs)) return { code: 'no_time' }
  const mins = Math.round((p.endMs - p.startMs) / MIN)
  if (mins < 0) return { code: 'before_start', kind: p.kind, startMs: p.startMs }
  if (mins === 0) return { code: 'zero_length' }
  if (p.endMs > p.nowMs + FUTURE_GRACE_MS) return { code: 'future', nowMs: p.nowMs }
  if (p.nextStartMs != null && p.nextStartMs > p.startMs && p.endMs > p.nextStartMs) {
    return { code: 'after_next', kind: p.kind, nextMs: p.nextStartMs }
  }
  return null
}

/**
 * The office starting someone's day ("Start their day"): the same open shift
 * "Start my day" writes. Not in the future (5-minute grace, saved as now), and
 * within the last 16 h: close_stale_shifts() closes anything older at the full
 * 16 h that same night. The web's validateOfficeStart.
 */
export function validateOfficeStart(p: { startMs: number; nowMs: number }): TimeProblem | null {
  if (!Number.isFinite(p.startMs)) return { code: 'no_time' }
  if (p.startMs > p.nowMs + START_FUTURE_GRACE_MS) return { code: 'future', nowMs: p.nowMs }
  if (p.nowMs - p.startMs > SHIFT_CAP_MS) return { code: 'too_old' }
  return null
}

/**
 * A corrected clock-in. On a running entry it follows the office-start rule
 * (it is the start of a day still open). On a closed one it must come before
 * the clock-out and not be in the future: the checks the web's Payroll time
 * editor makes (spanMinutes). An overlap with another of their entries is not
 * refused there either: payroll pays overlapping minutes once.
 */
export function validateStartFix(p: {
  kind: EntryKind
  startMs: number
  endMs: number | null
  nowMs: number
}): TimeProblem | null {
  if (!Number.isFinite(p.startMs)) return { code: 'no_time' }
  if (p.endMs == null) return validateOfficeStart({ startMs: p.startMs, nowMs: p.nowMs })
  if (p.startMs > p.nowMs + FUTURE_GRACE_MS) return { code: 'future', nowMs: p.nowMs }
  const mins = Math.round((p.endMs - p.startMs) / MIN)
  if (mins < 0) return { code: 'after_end', endMs: p.endMs }
  if (mins === 0) return { code: 'zero_length' }
  return null
}

/** Whole minutes from start to end, never negative (duration_minutes). */
export function minutesBetween(startMs: number, endMs: number): number {
  return Math.max(0, Math.round((endMs - startMs) / MIN))
}

/** pause_reason for an entry the office closed, appended to whatever it said.
 *  English, as the web writes it: the office reads these on Payroll. */
export function endedNote(kind: EntryKind, actorName: string | null | undefined, existing?: string | null): string {
  const who = (actorName || '').trim() || 'the office'
  const note = kind === 'shift' ? `Day ended by ${who}` : `Clocked out by ${who}`
  const prior = (existing || '').trim()
  return prior ? `${prior} · ${note}` : note
}

/** pause_reason for a day the office started. */
export function startedNote(actorName: string | null | undefined): string {
  return `Day started by ${(actorName || '').trim() || 'the office'}`
}
