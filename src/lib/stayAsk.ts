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
//
// No photos to add (CKS, Catherine 2026-11-16): "the rating happens after the
// cleaning is already done, so sometimes there won't be pictures to add, just
// the walk-through video. In that case, if they tap 4 or lower, it can save
// the rating, pop a flag, and notify me that it's a low rating with no
// pictures." So under 5 stars and short of the photos, the one way out besides
// the photos or 5 stars is "No photos to add" (askExits noPhotos): after a
// confirm it saves the rating with jobs.stay_photos_skipped = true (stayWrite),
// the clean shows the flag in the office, and the office's low-rating text
// (owner-sms-events stay_rating_low) says the rating has no photos. Still no
// Skip and no closing while short.
//
// At arrival (CKS, Catherine 2026-11-17: "the star rating is based on the
// arrival video, not the finished video ... required right after the arrival
// video and impossible to skip. If the rating is under 5 stars, photos should
// be required right then, not later, and not saved without photos"). A
// company switch, tenants.stay_rating_at_arrival (rinse-base-app), off for
// everyone else. With it on, and walkthrough videos on:
//   • Start opens the recorder on Arrival, when the clean has no arrival video
//     yet (arrivalStep 'record'); with one already (a teammate's) and no
//     rating, the ask opens straight away ('ask');
//   • saving the Arrival video asks right then (asksAfterVideo atArrival), a
//     rating REQUIRED as after a Finished video, and under 5 stars the photos
//     are the only way: no "No photos to add" (askExits photosOnly). The
//     guests' mess is still there to photograph;
//   • leaving that recorder without saving a video still asks, the same way:
//     the rating comes before the cleaning either way;
//   • a clean still unrated by the Finished video asks there as before (No
//     photos to add and all), and Complete as before, so nothing is missed.

export const STAY_FLAGS = [
  { key: 'heavy_mess',  i18n: 'stay_flag_heavy_mess',  icon: '🧹' },
  { key: 'damage',      i18n: 'stay_flag_damage',      icon: '⚠️' },
  { key: 'smoking',     i18n: 'stay_flag_smoking',     icon: '🚬' },
  { key: 'pets',        i18n: 'stay_flag_pets',        icon: '🐾' },
  { key: 'extra_time',  i18n: 'stay_flag_extra_time',  icon: '⏱️' },
  { key: 'items_moved', i18n: 'stay_flag_items_moved', icon: '📦' },
] as const

export interface StayValue {
  rating: number
  flags: string[]
  note: string
  /** Saved short of the company's photos ("No photos to add"): true; saved
   *  with them (or at 5 stars) where the company asks for photos: false; left
   *  out where it doesn't, so a company with the rule off never writes the
   *  column (useStayRating decides). */
  photosSkipped?: boolean
}

/** The jobs.stay_* columns, as StayRatingCard has always written them (the
 *  web JobPanel and the host portal read the same five), and
 *  stay_photos_skipped only when the save says (StayValue.photosSkipped): the
 *  office's flag for a rating saved without the photos the company asks for. */
export function stayWrite(v: StayValue, userId: string | null | undefined, now: Date) {
  return {
    stay_rating: v.rating,
    stay_condition_flags: v.flags,
    stay_condition_note: v.note.trim() || null,
    stay_rated_at: now.toISOString(),
    stay_rated_by: userId ?? null,
    ...(typeof v.photosSkipped === 'boolean' ? { stay_photos_skipped: v.photosSkipped } : {}),
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

/** Saving a walkthrough video asks right then, on a clean that shows the
 *  rating card and has no rating: a Finished one always, an Arrival one at a
 *  company that rates at arrival (`atArrival`, tenants.stay_rating_at_arrival).
 *  (A Skip earlier doesn't stop it: the video is the moment the company asked
 *  for.) */
export function asksAfterVideo(s: { type: string; shows: boolean; rated: boolean; atArrival?: boolean }): boolean {
  if (!s.shows || s.rated) return false
  return s.type === 'after' || (!!s.atArrival && s.type === 'before')
}

/** At Start, at a company that rates at arrival: open the recorder on Arrival
 *  while the clean has no arrival video ('record'; not knowing, with no
 *  signal at the door, counts as none); with one already, ask for the rating
 *  straight away unless the clean has one ('ask'; not knowing asks, the same
 *  stars come back filled in when the rating reads back); else nothing. */
export function arrivalStep(s: { hasArrival: boolean | null; rated: boolean | null }): 'record' | 'ask' | null {
  if (s.hasArrival !== true) return 'record'
  return s.rated === true ? null : 'ask'
}

/** The ways out of the ask, for the stars picked and the photos still short
 *  (lib/stayPhotos photosShort). Under 5 stars and short: only "No photos to
 *  add" (noPhotos: a confirm, then the rating saves flagged, CKS 2026-11-16);
 *  the stars can still change, and Take photos opens the photo screen, the
 *  sheet still waiting. Skip only before a star or at 5 stars. Save once a
 *  star is picked and nothing is short. Closing (Android's back) whenever
 *  nothing is short. `ratingRequired` (the ask after a walkthrough video, Todd
 *  2026-11-13): no Skip and no closing at all; a star and Save (or No photos
 *  to add) is the only way out. `photosOnly` (the ask at arrival, CKS
 *  2026-11-17): no No photos to add either, so under 5 stars and short the
 *  photos (or 5 stars) are the only way out. */
export function askExits(rating: number, short: number, opts: { ratingRequired?: boolean; photosOnly?: boolean } = {}): { save: boolean; skip: boolean; close: boolean; noPhotos: boolean } {
  const locked = short > 0
  const required = !!opts.ratingRequired
  return {
    save: rating > 0 && !locked,
    skip: !required && !locked && (rating === 0 || rating === 5),
    close: !required && !locked,
    noPhotos: rating > 0 && locked && !opts.photosOnly,
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
