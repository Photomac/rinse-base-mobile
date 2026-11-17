// "Can't finish today" on a started clean (CKS Perfections, 2026-11-16; web
// repo migrations 20261117140000_clean_unfinished_column and
// 20261117140100_clean_unfinished).
//
// On 11/16 Krystal started OLDTOWN at 11:35 AM and ended her day with it still
// open: the app had no way to say she couldn't finish (day shifts have no
// Pause), and nobody in the office was told. Now the crew tap "Can't finish
// today" on a started clean and pick a reason. The server pauses the clean
// (jobs.unfinished_at, mark_clean_unfinished) and texts or pushes the office,
// who move it to the day the crew come back (Finish tomorrow on the web). On
// that day the clean is on the crew's list as paused, and Continue
// (resume_unfinished_clean) picks it back up.
//
// The keys are job_unfinished_marks.reason's list: the web app's
// src/lib/cleanUnfinished.ts and the server's _shared/clean-unfinished.ts hold
// the same six. Pure (no React, no Supabase) so scripts/test-unfinished.mjs
// runs it under Node.

import type { TranslationKey } from './i18n'

/** The crew's reasons: the stored key and its label. */
export const UNFINISHED_REASONS: { value: string; key: TranslationKey }[] = [
  { value: 'out_of_time', key: 'unfinished_reason_out_of_time' },
  { value: 'waiting_access', key: 'unfinished_reason_waiting_access' },
  { value: 'supplies', key: 'unfinished_reason_supplies' },
  { value: 'maintenance', key: 'unfinished_reason_maintenance' },
  { value: 'guest_still_there', key: 'unfinished_reason_guest_still_there' },
  { value: 'other', key: 'unfinished_reason_other' },
]

/** The note a per-clean clock's closed punch carries (pause_reason, English
 *  like every pause note; lib/pauseReason translates it). The web crew view
 *  writes the same words. */
export const CANT_FINISH_PAUSE_NOTE = "Can't finish today"

type Clean = { status?: string | null; job_type?: string | null; scheduled_start?: string | null }

/** "Can't finish today" is offered on a started clean that isn't paused. */
export function canMarkUnfinished(job: Clean | null | undefined, unfinishedAt: string | null | undefined): boolean {
  return !!job && job.status === 'in_progress' && (job.job_type ?? 'clean') === 'clean' && !unfinishedAt
}

/** Paused: started, marked, not picked back up. */
export function isPausedClean(job: Clean | null | undefined, unfinishedAt: string | null | undefined): boolean {
  return !!job && job.status === 'in_progress' && !!unfinishedAt
}

function ymdIn(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
}

/** Where a paused clean carries on: its start, when the office has moved it
 *  to a later day than today (in its zone). null while it hasn't been moved. */
export function finishingAt(job: Clean, tz: string, now: Date = new Date()): string | null {
  if (!job.scheduled_start) return null
  const at = new Date(job.scheduled_start)
  if (Number.isNaN(at.getTime())) return null
  return ymdIn(at, tz) > ymdIn(now, tz) ? job.scheduled_start : null
}

/** "Tue 9:30 AM" in the clean's zone and the crew's language. */
export function shortWhen(at: string, tz: string, locale = 'en-US'): string {
  const d = new Date(at)
  try {
    const wd = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short' }).format(d)
    const time = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d)
    return `${wd} ${time}`
  } catch {
    return d.toLocaleString(locale)
  }
}

/** The paused line: "Paused · finishing Tue 9:30 AM", or "Paused" until the
 *  office sets the day. */
export function pausedText(
  job: Clean, unfinishedAt: string | null | undefined, tz: string,
  words: { paused: string; finishing: string }, locale = 'en-US', now: Date = new Date(),
): string | null {
  if (!isPausedClean(job, unfinishedAt)) return null
  const at = finishingAt(job, tz, now)
  return at ? `${words.paused} · ${words.finishing} ${shortWhen(at, tz, locale)}` : words.paused
}
