// src/lib/siteVisitRules.ts
// The rules for recording arrive / leave at each home (day-shift companies with
// the "arrive and leave" switch on; lib/siteVisits does the I/O). Pure: no
// React Native, no network, no storage, so scripts/test-site-visits.mjs runs it
// under Node.

export type SiteKind = 'arrive' | 'depart'
export type FenceState = 'in' | 'out'
/** A home on the person's list (the fence is named by its clean), the
 *  company's office (rinsebase-app 20261023210100_job_site_events_office), or
 *  one of the company's other places, like a laundry drop-off (rinsebase-app
 *  20261125200100_company_places; CKS 2026-11-25). */
export type SitePlace = 'home' | 'office' | 'place'

/** The office fence's name beside the day's cleans: the company's address
 *  (tenants.lat/lng). Crossing it is recorded with no clean. */
export const OFFICE_FENCE = 'office'

/** A company place's fence is named PLACE_FENCE_PREFIX + its id. Crossing it is
 *  recorded with no clean and that place's id (place 'place'). */
export const PLACE_FENCE_PREFIX = 'place:'
export const placeFence = (placeId: string) => PLACE_FENCE_PREFIX + placeId
/** The company place a fence watches, or null for a home or the office. */
export function placeIdOfFence(fence: string | null | undefined): string | null {
  return typeof fence === 'string' && fence.startsWith(PLACE_FENCE_PREFIX) && fence.length > PLACE_FENCE_PREFIX.length
    ? fence.slice(PLACE_FENCE_PREFIX.length) : null
}
/** What a crossing of this fence is recorded as: its place, its clean, its company place. */
export function siteRowPlace(fence: string): { place: SitePlace; job_id: string | null; place_id: string | null } {
  if (fence === OFFICE_FENCE) return { place: 'office', job_id: null, place_id: null }
  const placeId = placeIdOfFence(fence)
  if (placeId) return { place: 'place', job_id: null, place_id: placeId }
  return { place: 'home', job_id: fence, place_id: null }
}

/** A company that starts forgotten days from the arrival record asks a crew
 *  member whose phone isn't on Location "Always" again, at a Start my day,
 *  once a week at most (only "Always" records with the app closed; on
 *  2026-11-25 that was 1 of CKS's 13 cleaners). */
export const SITE_NUDGE_EVERY_MS = 7 * 24 * 60 * 60 * 1000
export function siteNudgeDue(lastShownMs: number | null | undefined, nowMs: number): boolean {
  return lastShownMs == null || !Number.isFinite(lastShownMs) || nowMs - lastShownMs >= SITE_NUDGE_EVERY_MS || lastShownMs > nowMs + 60_000
}

/** The most fences a day-shift phone watches around homes: 17, plus the office
 *  and up to MAX_COMPANY_PLACES places, within the 20 regions iOS allows. */
export const MAX_SITE_HOMES = 17
export const MAX_COMPANY_PLACES = 2

/**
 * Is this fence one of the armed arrive/leave fences? A home's fence belongs to
 * the day it was armed for: on a later day it's 'stale' (yesterday's clean) and
 * records nothing until Home loads again. The office's and the company places'
 * fences mean the same place every day, so they record as long as arrive/leave
 * fences were ever armed on this phone: the morning they forget to open the app
 * before reaching the office (or the linens) is the morning that matters most
 * (a forgotten Start my day is started from that arrival).
 */
export function fenceKind(armed: { day?: string; jobIds?: string[] } | null | undefined, fence: string, today: string): 'site' | 'stale' | 'other' {
  if (!armed || !Array.isArray(armed.jobIds) || !armed.jobIds.includes(fence)) return 'other'
  if (fence === OFFICE_FENCE || placeIdOfFence(fence)) return 'site'
  return armed.day === today ? 'site' : 'stale'
}

export interface SiteEventRow {
  id: string
  tenant_id: string
  /** null for the office and a company place */
  job_id: string | null
  user_id: string
  kind: SiteKind
  at: string
  lat?: number | null
  lng?: number | null
  accuracy_m?: number | null
  place?: SitePlace
  /** the company place, when place is 'place' */
  place_id?: string | null
}

/** Statuses whose homes keep a fence all day in day-shift mode. A completed
 *  clean stays fenced: they usually leave a few minutes after tapping
 *  Complete, and dropping the fence then would lose that departure. */
export const SITE_FENCE_STATUSES = ['pending_approval', 'scheduled', 'en_route', 'in_progress', 'completed']

/** The server refuses a crossing older than this (guard_job_site_event_time);
 *  the phone gives up an hour before, rather than send it to be refused. */
export const SITE_EVENT_MAX_AGE_MS = 47 * 60 * 60 * 1000

/** The most crossings kept on a phone that can't reach the server. A day is
 *  ~20 (ten homes, in and out); this is two weeks of a dead phone. */
export const SITE_QUEUE_CAP = 300

/**
 * What one OS fence report means, given what this phone last recorded at this
 * home. The OS can report the same thing twice (registering the day's fences
 * again re-reports every fence the phone is already inside), so only a change
 * is a crossing. A leave with nothing recorded before still counts, except
 * right after the fences go up: that one is the setup echo (isSetupEcho),
 * checked first.
 */
export function decideSiteEvent(last: FenceState | null | undefined, report: 'enter' | 'exit'): SiteKind | null {
  if (report === 'enter') return last === 'in' ? null : 'arrive'
  return last === 'out' ? null : 'depart'
}

/** How long after the day's fences are registered an Exit for a fence the
 *  phone has nothing recorded for is the OS's first answer, not a leave.
 *  expo-location starts every region as "unknown" and reports the OS's
 *  initial state (iOS requestStateForRegion): with leave fences on, every
 *  home the phone is OUTSIDE fires an Exit the moment they're registered.
 *  Before this, each one was recorded as a leave: Sheddys, 14 days to
 *  2026-11-13, 51 of 62 visits began with one, often several homes in the
 *  same minute. (A phone already INSIDE gets an Enter instead, so a real
 *  "inside when the fences went up" leave still has its arrival.) */
export const SETUP_ECHO_MS = 2 * 60 * 1000

/** Is this report the fence-setup echo? An Exit, for a fence with nothing
 *  recorded on this phone, within SETUP_ECHO_MS of registering (a minute of
 *  clock slack before it). The caller marks the fence 'out', so the next
 *  Enter is an arrival, and records nothing. No registration time known
 *  (registered before this version) = not an echo: the old behaviour. */
export function isSetupEcho(last: FenceState | null | undefined, report: 'enter' | 'exit', msSinceRegistered: number | null | undefined): boolean {
  if (report !== 'exit' || last != null) return false
  if (msSinceRegistered == null || !Number.isFinite(msSinceRegistered)) return false
  return msSinceRegistered >= -60_000 && msSinceRegistered <= SETUP_ECHO_MS
}

/** What the phone keeps per fence: in or out, and since when (ms). Phones on
 *  the first version kept a bare 'in' / 'out'; that still reads, with no time. */
export interface FenceMark { s: FenceState; t: number | null }

export function readFenceMark(raw: string | null | undefined): FenceMark | null {
  if (raw === 'in' || raw === 'out') return { s: raw, t: null }
  try {
    const m = JSON.parse(raw ?? '')
    if (m && (m.s === 'in' || m.s === 'out')) return { s: m.s, t: Number.isFinite(m.t) ? m.t : null }
  } catch { /* not ours */ }
  return null
}

// ── The trail: where the phone has been, for a true leave time ──────────────
// While someone is on shift the phone already takes positions for the
// dispatch map (lib/locationTracker), each stamped with when it was taken,
// even when the OS hands them over late. The OS reports leaving a fence
// anywhere from seconds to 10+ minutes after the fact (later for a phone
// that was asleep), so the leave is timed from the trail instead: the first
// position clearly outside the fence after the last one inside. Kept on the
// phone only, an hour at most, and only while today's arrive/leave fences are
// armed.

/** [taken at (ms), lat, lng, accuracy in m or null] */
export type TrailFix = [number, number, number, number | null]
export const TRAIL_KEEP_MS = 60 * 60 * 1000
export const TRAIL_CAP = 240

/** The trail as it should be kept: real fixes, in time order, one per instant,
 *  the last hour only (a phone clock a minute ahead is allowed), at most
 *  TRAIL_CAP, the newest kept. */
export function pruneTrail(trail: TrailFix[], nowMs: number): TrailFix[] {
  const seen = new Set<number>()
  const fixes = (trail ?? [])
    .filter(f => Array.isArray(f) && [f[0], f[1], f[2]].every(Number.isFinite)
      && f[0] >= nowMs - TRAIL_KEEP_MS && f[0] <= nowMs + 60_000)
    .sort((a, b) => a[0] - b[0])
    .filter(f => (seen.has(f[0]) ? false : (seen.add(f[0]), true)))
  return fixes.length > TRAIL_CAP ? fixes.slice(fixes.length - TRAIL_CAP) : fixes
}

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** The OS's leave report can't be more than this late and still be refined. */
export const TRAIL_LOOKBACK_MS = 30 * 60 * 1000

/**
 * When the phone left a fence, from its own trail: the first position clearly
 * outside (further than the radius by more than its own accuracy) after the
 * last moment it's known to have been inside, if that's no later than the OS's
 * report and no more than 30 minutes before it. Known inside: the last position
 * inside on the trail, or the recorded arrival (insideSinceMs), whichever is
 * later. The arrival matters on a long clean: a phone sitting still takes no
 * positions, the hour's trail can hold none inside, and the first one on
 * driving off can already be outside. null = it can't say (nothing known
 * inside, nothing clearly outside yet, location only while using the app, off
 * shift): the report's own time stands.
 */
export function departureFromTrail(trail: TrailFix[], center: { lat: number; lng: number }, radiusM: number, reportMs: number, insideSinceMs: number | null = null): number | null {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return null
  const fixes = (trail ?? []).filter(f => f[0] <= reportMs).sort((a, b) => a[0] - b[0])
  let lastInT = insideSinceMs != null && Number.isFinite(insideSinceMs) && insideSinceMs <= reportMs ? insideSinceMs : -Infinity
  for (const f of fixes) if (distanceM(f[1], f[2], center.lat, center.lng) <= radiusM && f[0] > lastInT) lastInT = f[0]
  if (lastInT === -Infinity) return null
  for (const f of fixes) {
    if (f[0] <= lastInT) continue
    if (distanceM(f[1], f[2], center.lat, center.lng) - (f[3] ?? 0) > radiusM) {
      return f[0] >= reportMs - TRAIL_LOOKBACK_MS ? f[0] : null
    }
  }
  return null
}

// ── Start my day from the arrival ───────────────────────────────────────────
// CKS (Catherine, 2026-10-23): "the choice at the moment, in front of the
// person it happened to: 'You arrived 8:50 — start from then, or from now,
// 9:10?' and they pick." Offered when the phone recorded them reaching a home
// on their list and they're still there: at least 5 minutes ago (under that,
// it just starts), at most 12 hours.
export const START_FROM_ARRIVAL_MIN_MS = 5 * 60 * 1000
export const START_FROM_ARRIVAL_MAX_MS = 12 * 60 * 60 * 1000

/** The arrival Start my day offers: the newest home fence they're still
 *  inside, within the window. Never the office or a company place. */
export function arrivalToOffer(marks: { jobId: string; mark: FenceMark | null }[], nowMs: number): { jobId: string; at: number } | null {
  let best: { jobId: string; at: number } | null = null
  for (const { jobId, mark } of marks ?? []) {
    if (!jobId || jobId === OFFICE_FENCE || placeIdOfFence(jobId) || mark?.s !== 'in' || mark.t == null) continue
    const age = nowMs - mark.t
    if (age < START_FROM_ARRIVAL_MIN_MS || age > START_FROM_ARRIVAL_MAX_MS) continue
    if (!best || mark.t > best.at) best = { jobId, at: mark.t }
  }
  return best
}

/** The queue as it should be kept: in order, nothing past the age limit, at
 *  most SITE_QUEUE_CAP (the oldest go first). */
export function pruneSiteQueue(queue: SiteEventRow[], nowMs: number): SiteEventRow[] {
  const fresh = queue.filter(e => {
    const t = Date.parse(e.at)
    return Number.isFinite(t) && nowMs - t <= SITE_EVENT_MAX_AGE_MS
  })
  return fresh.length > SITE_QUEUE_CAP ? fresh.slice(fresh.length - SITE_QUEUE_CAP) : fresh
}

/** After a send: 'sent', 'retry' (no answer, or not signed in right now: keep
 *  it and stop for now) or 'drop' (a real refusal: the clean was taken off
 *  them or the switch is off, 403; it's too old, 400; the clean is gone, 409.
 *  A crossing is a record, not pay, so a refusal isn't retried).
 *  401 is not a refusal: a background wake after the session lapsed, or a
 *  refresh race, answers 401 for a row that will go once signed in again. The
 *  47 h prune still bounds what waits. */
export function siteSendOutcome(res: { error: any; status?: number | null }): 'sent' | 'retry' | 'drop' {
  if (!res.error) return 'sent'
  if (!res.status) return 'retry'
  if (res.status >= 500 || res.status === 401 || res.status === 408 || res.status === 429) return 'retry'
  return 'drop'
}
