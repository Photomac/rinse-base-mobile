// src/lib/jobOrder.ts
// One definition of the order a crew works their day in, shared by the Dashboard
// and the Schedule so the two screens can never disagree.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Both screens used to render whatever `.order('scheduled_start')` returned and
// nothing else. Two consequences, both reported from the field on 2026-09-09:
//
// 1. JOBS AT THE SAME TIME HAD NO ORDER — and no STABLE one either. A crew with
//    four cleans all set to 10:00 got them in whatever sequence Postgres
//    happened to return, which can differ between refreshes. An owner trying to
//    sequence a day by hand could not make it stick, because there was nothing
//    to make it stick TO.
//
// 2. `route_order` — what Dispatch's "Suggest order" writes — did not affect
//    the list at all. It was read on the Dashboard for exactly one purpose:
//    printing a "Stop 1 of 6" badge. So a dispatcher could set a route, watch
//    the web board renumber, and see nothing change on the crew's phone. The
//    feature looked like it worked and was decorative.
//
// ── THE RULE, AND WHY IT IS THIS WAY ROUND ──────────────────────────────────
// TIME FIRST, route order as the tie-break. Not the other way round.
//
// `scheduled_start` is a commitment, not a preference: it is derived from guest
// checkout and check-in times, and it is what the back-to-back window and the
// turnover guards are computed against. An order that sent a crew to a 12:00
// clean before a 10:00 one would not be a better route, it would be a broken
// schedule — potentially sending someone to a unit the guest is still in.
//
// The sequence question only genuinely arises when times TIE, which is exactly
// the case the app had no answer for. So route_order decides there, and nowhere
// else. An owner who wants a different sequence across different times changes
// the times, which is the honest way to say "this happens before that".
//
// Final tie-break on job_number purely for STABILITY: with no third key, two
// jobs at the same time and no route order can swap places between refreshes.

/** Sort comparator for a crew's day. Use with `[...jobs].sort(byCrewDayOrder)`. */
export function byCrewDayOrder(a: any, b: any): number {
  const ta = new Date(a?.scheduled_start ?? 0).getTime()
  const tb = new Date(b?.scheduled_start ?? 0).getTime()
  // A malformed start would otherwise make the whole comparator NaN and leave
  // the array in an arbitrary order.
  const sa = Number.isFinite(ta) ? ta : Number.MAX_SAFE_INTEGER
  const sb = Number.isFinite(tb) ? tb : Number.MAX_SAFE_INTEGER
  if (sa !== sb) return sa - sb

  // Same slot — the dispatcher's route decides. A job the optimizer ordered
  // comes before one it never saw, so adding a job after running Suggest order
  // appends it to the slot rather than shuffling the planned route.
  const ra = a?.route_order, rb = b?.route_order
  const hasA = ra !== null && ra !== undefined
  const hasB = rb !== null && rb !== undefined
  if (hasA && hasB && ra !== rb) return ra - rb
  if (hasA !== hasB) return hasA ? -1 : 1

  // Stability. Without this, equal-time jobs can reorder between refreshes.
  return (a?.job_number ?? 0) - (b?.job_number ?? 0)
}
