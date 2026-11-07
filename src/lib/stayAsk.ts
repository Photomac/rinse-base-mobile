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
// Never twice for the same clean on this phone: the clean is remembered once
// the ask is shown, and once the card saves a rating. A Complete the gate then
// holds back (a missing photo, say) goes straight through on the next tap.

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

/** Complete asks only on a clean that shows the rating card (the card's own
 *  gate, not read-only), has no rating, and wasn't asked here before. */
export function asksAtComplete(s: { shows: boolean; rated: boolean; askedBefore: boolean }): boolean {
  return s.shows && !s.rated && !s.askedBefore
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
