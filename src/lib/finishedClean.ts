// A finished clean as the crew see it, and where the walkthrough recorder
// starts. Both from CKS (Catherine, 2026-10-28), after the inspection review
// loop's first test clean.
//
// View only. The inspection push ('inspection_result', lib/pushTap) opens the
// clean the inspector looked at, and that screen stayed live after Complete:
// checklist ticks and OK / Issue / N/A answers saved, photos could be taken or
// deleted (long press), the stay rating saved again, and the notes box took
// typing it never saved. Anyone reading the review could change the clean by
// accident. Once a clean is completed the crew read it; the office still
// changes it, on this screen and on the web. Nothing here changes what the
// server accepts: a write already queued in the outbox still lands.
//
// The recorder. A walkthrough opens on Arrival until the clean is 15 minutes
// in, Guest ready after that, and the crew can switch it. The 15 minutes
// counted from the first clock-in on the clean, which a day-shift company
// (time_tracking_mode 'daily') never has: there the clean's Start is the
// clock, so every walkthrough after Start opened on Guest ready. CKS, to
// 2026-10-28: 22 of 68 Guest ready videos were recorded within 15 minutes of
// the clean's Start, and 46 of 49 Arrival videos before Start or within those
// 15 minutes. scripts/test-finished-clean.mjs runs both rules.
//
// CKS again, 2026-10-30: the first time anyone opens it, it should be on Arrival.
// Past the 15 minutes it still opened on Guest ready with no arrival video on the
// clean. Once the recorder knows what the clean has, that decides; the clock only
// answers when it can't find out (no signal). A late Arrival can be a video of a
// clean house, so the recorder says so (arrivalIsLate).
import { isOfficeRole } from './jobScope'
import type { WalkthroughType } from './videoQueue'

/** The clean's screen is view only: a completed clean, for anyone but the office. */
export function finishedCleanReadOnly(
  role: string | null | undefined,
  job: { status?: string | null; job_type?: string | null } | null | undefined,
): boolean {
  if (!job || isOfficeRole(role)) return false
  // Cleans only: an inspection's own filed record has its server rule
  // (filed findings are the office's), and tasks and laundry runs have no
  // review to read.
  return (job.job_type ?? 'clean') === 'clean' && job.status === 'completed'
}

/** How long after the clean starts the recorder still opens on Arrival. */
export const ARRIVAL_WINDOW_MS = 15 * 60_000

/**
 * The recorder's starting choice. `startedAt` is when the clean began: the
 * first clock-in on it, or on a day-shift company its Start (jobs.started_at).
 * `hasArrival` is whether the clean has an arrival video (lib/videosOwed), null
 * or left out when that's unknown. Not started is Arrival. Known: Guest ready
 * once there is one, Arrival until then, except on a completed clean, where an
 * arrival video can't be taken any more. Unknown: the 15 minutes, and started
 * with no time known is Guest ready, as before.
 */
export function walkthroughDefault(o: {
  started: boolean; startedAt: string | null | undefined; now: number
  hasArrival?: boolean | null; completed?: boolean
}): WalkthroughType {
  if (!o.started) return 'before'
  if (o.hasArrival === true || (o.hasArrival === false && o.completed)) return 'after'
  if (o.hasArrival === false) return 'before'
  const at = o.startedAt ? new Date(o.startedAt).getTime() : NaN
  return Number.isFinite(at) && o.now - at < ARRIVAL_WINDOW_MS ? 'before' : 'after'
}

/** The clean is past the Arrival window, so an arrival video now may not show the property as found. */
export function arrivalIsLate(o: { started: boolean; startedAt: string | null | undefined; now: number }): boolean {
  if (!o.started) return false
  const at = o.startedAt ? new Date(o.startedAt).getTime() : NaN
  return !Number.isFinite(at) || o.now - at >= ARRIVAL_WINDOW_MS
}
