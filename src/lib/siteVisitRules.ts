// src/lib/siteVisitRules.ts
// The rules for recording arrive / leave at each home (day-shift companies with
// the "arrive and leave" switch on; lib/siteVisits does the I/O). Pure: no
// React Native, no network, no storage, so scripts/test-site-visits.mjs runs it
// under Node.

export type SiteKind = 'arrive' | 'depart'
export type FenceState = 'in' | 'out'

export interface SiteEventRow {
  id: string
  tenant_id: string
  job_id: string
  user_id: string
  kind: SiteKind
  at: string
  lat?: number | null
  lng?: number | null
  accuracy_m?: number | null
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
 * is a crossing. A leave with nothing recorded before still counts: the phone
 * may have been inside when the fences went up.
 */
export function decideSiteEvent(last: FenceState | null | undefined, report: 'enter' | 'exit'): SiteKind | null {
  if (report === 'enter') return last === 'in' ? null : 'arrive'
  return last === 'out' ? null : 'depart'
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

/** After a send: 'sent', 'retry' (no answer: keep it and stop for now) or
 *  'drop' (a real refusal: the clean was taken off them, the switch is off,
 *  it's too old; a crossing is a record, not pay, so it isn't retried). */
export function siteSendOutcome(res: { error: any; status?: number | null }): 'sent' | 'retry' | 'drop' {
  if (!res.error) return 'sent'
  if (!res.status) return 'retry'
  if (res.status >= 500 || res.status === 408 || res.status === 429) return 'retry'
  return 'drop'
}
