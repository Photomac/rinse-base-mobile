// "How did the guests leave it?": the stay rating's write, and when Complete
// asks for it. Pure: scripts/test-stay-ask.mjs runs it under Node.
//
// CKS Perfections (Catherine, 2026-11-03) asked for the clean's screen to
// follow the order of the work, and Todd decided it on 2026-11-06 for every
// company: the rating card and Report an issue sit right after the time card,
// before the checklist, so damage is reported before cleaning covers it.
// Most ratings still come at the end (CKS, 2026-11-04: of 440 rated cleans,
// 84 were rated in the clean's first third, 101 mid-clean and 255 at or after
// completion; 26% of STR/PM cleans get rated at all, 14% at CKS). So Complete
// asks once, on a clean that shows the card and has no rating: the same stars
// and flags, plus Skip.
//
// Never twice for the same clean on this phone once it's ANSWERED: the clean
// is remembered when the crew Skip, and when a rating saves (the card or the
// ask). Until 2026-11-13 it was remembered as soon as the ask showed, so
// closing it (Android's back button) or a Complete the gate then held back
// meant it was never asked again; now a closed ask asks again on the next
// Complete. And a pick of 1-4 stars that isn't saved (picked, then closed)
// is always asked again at Complete, whatever was answered before: a low
// rating is the one that must not get lost (CKS, Catherine 2026-11-13).
//
// After the Finished walkthrough video (CKS, Catherine 2026-11-13: "when the
// walk-through video is saved, the star rating should pop up automatically
// right then"): saving a Finished video on a clean that shows the card and has
// no rating closes the recorder and asks right then (asksAfterVideo), with
// Save instead of "Save and complete". That ask REQUIRES a rating (Todd,
// 2026-11-13): no Skip and no back button, only a star and Save.
//
// Leaving the ask (CKS 2026-11-13: "no saving it and no backing out of it
// without the pictures"): under 5 stars, short of the company's photos
// (lib/stayPhotos), it neither saves nor skips nor closes; 5 stars or the
// photos open the way again. At Complete, Skip shows only before a star is
// picked or at 5 stars: a 1-4 pick is an answer, so it's saved, not skipped
// (askExits).

export const STAY_FLAGS = [
  { key: 'heavy_mess',  i18n: 'stay_flag_heavy_mess',  icon: '🧹' },
  { key: 'damage',      i18n: 'stay_flag_damage',      icon: '⚠️' },
  { key: 'smoking',     i18n: 'stay_flag_smoking',     icon: '🚬' },
  { key: 'pets',        i18n: 'stay_flag_pets',        icon: '🐾' },
  { key: 'extra_time',  i18n: 'stay_flag_extra_time',  icon: '⏱️' },
  { key: 'items_moved', i18n: 'stay_flag_items_moved', icon: '📦' },
] as const

export interface StayValue { rating: number; flags: string[]; note: string }

/** The jobs.stay_* columns, as StayRatingCard has always written them (the
 *  web JobPanel and the host portal read the same five). */
export function stayWrite(v: StayValue, userId: string | null | undefined, now: Date) {
  return {
    stay_rating: v.rating,
    stay_condition_flags: v.flags,
    stay_condition_note: v.note.trim() || null,
    stay_rated_at: now.toISOString(),
    stay_rated_by: userId ?? null,
  }
}

/** A pick of 1-4 stars that isn't saved: picked and never saved, or changed
 *  from the saved rating and not saved again. */
export function lowPickUnsaved(s: { rating: number; saved: boolean; dirty: boolean }): boolean {
  return Number.isInteger(s.rating) && s.rating >= 1 && s.rating <= 4 && (!s.saved || s.dirty)
}

/** Complete asks only on a clean that shows the rating card (the card's own
 *  gate, not read-only): one with no rating that wasn't answered here before,
 *  or one with a 1-4 star pick that isn't saved (always, see lowPickUnsaved). */
export function asksAtComplete(s: { shows: boolean; rated: boolean; askedBefore: boolean; lowUnsaved?: boolean }): boolean {
  return s.shows && (!!s.lowUnsaved || (!s.rated && !s.askedBefore))
}

/** Saving a walkthrough video asks right then only for a Finished one, on a
 *  clean that shows the rating card and has no rating. (A Skip earlier
 *  doesn't stop it: the video is the moment the company asked for.) */
export function asksAfterVideo(s: { type: string; shows: boolean; rated: boolean }): boolean {
  return s.type === 'after' && s.shows && !s.rated
}

/** The ways out of the ask, for the stars picked and the photos still short
 *  (lib/stayPhotos photosShort). Under 5 stars and short: none (the stars
 *  can still change, and Take photos opens the photo screen, the sheet still
 *  waiting). Skip only before a star or at 5 stars. Save once a star is
 *  picked and nothing is short. Closing (Android's back) whenever nothing is
 *  short. `ratingRequired` (the ask after a Finished video, Todd 2026-11-13):
 *  no Skip and no closing at all; a star and Save is the only way out. */
export function askExits(rating: number, short: number, opts: { ratingRequired?: boolean } = {}): { save: boolean; skip: boolean; close: boolean } {
  const locked = short > 0
  const required = !!opts.ratingRequired
  return {
    save: rating > 0 && !locked,
    skip: !required && !locked && (rating === 0 || rating === 5),
    close: !required && !locked,
  }
}

/** How many cleans the phone remembers as asked. A busy cleaner works ~130
 *  stops a month, so this is months; an older clean is long finished. */
export const ASKED_KEEP = 400

/** The remembered list with this clean added: newest last, no repeats, capped.
 *  Anything stored that isn't a list of ids is dropped. */
export function withAsked(list: unknown, jobId: string, keep = ASKED_KEEP): string[] {
  const ids = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x !== jobId) : []
  return [...ids, jobId].slice(-keep)
}

/** Whether the remembered list holds this clean. */
export function wasAsked(list: unknown, jobId: string): boolean {
  return Array.isArray(list) && list.includes(jobId)
}
