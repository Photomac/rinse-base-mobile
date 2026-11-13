// src/lib/routeTrailRules.ts
// The pure rules behind lib/routeTrail (the company's "Record crew routes"
// switch, rinsebase-app 20261113170000_crew_route_trail). Tested under Node:
// scripts/test-route-trail.mjs.
//
// The phone already gets a fix every 100 m of movement and every 5 minutes
// (locationTracker's task, only while working). Kept for the route:
//   • one every 30 seconds at most, and only after 50 m of movement,
//   • else one every 5 minutes while still (so a stop has a start and an end),
//   • never one less accurate than 250 m (Dispatch leaves those out anyway).
// About 150 points a working day: the route's shape, not a GPS log.

export const KEEP_MOVING_MS = 30_000
export const KEEP_STILL_MS = 5 * 60_000
export const MOVE_M = 50
export const MAX_ACCURACY_M = 250
// The server drops a point more than 48 hours old; the phone lets go an hour
// before that. Two days of points is ~600; the cap only bites a phone that
// was offline for days.
export const QUEUE_KEEP_MS = 47 * 60 * 60_000
export const QUEUE_CAP = 2000
// One request carries at most this many points.
export const BATCH = 500
// Send when this many are waiting, or this long after the last send.
export const FLUSH_COUNT = 60
export const FLUSH_EVERY_MS = 4 * 60_000

export type TrailBasis = 'clocked_in' | 'en_route'

/** [t ms, lat, lng, accuracy m | null, job id | null, basis] */
export type QueuedFix = [number, number, number, number | null, string | null, TrailBasis]

export interface RawFix {
  timestamp: number
  coords: { latitude: number; longitude: number; accuracy?: number | null }
}

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** The fixes worth keeping from a batch, given the last one kept. */
export function thinFixes(last: QueuedFix | null, fixes: RawFix[], basis: TrailBasis, jobId: string | null): QueuedFix[] {
  const kept: QueuedFix[] = []
  let prev = last
  const sorted = (fixes ?? [])
    .filter(f => f && Number.isFinite(f.timestamp) && Number.isFinite(f.coords?.latitude) && Number.isFinite(f.coords?.longitude)
      && Math.abs(f.coords.latitude) <= 90 && Math.abs(f.coords.longitude) <= 180
      && (f.coords.accuracy == null || f.coords.accuracy <= MAX_ACCURACY_M))
    .sort((a, b) => a.timestamp - b.timestamp)
  for (const f of sorted) {
    const fix: QueuedFix = [Math.round(f.timestamp), f.coords.latitude, f.coords.longitude,
      f.coords.accuracy == null ? null : Math.round(f.coords.accuracy), jobId, basis]
    if (prev) {
      const dt = fix[0] - prev[0]
      if (dt <= 0) continue
      const moved = distanceM(prev[1], prev[2], fix[1], fix[2])
      if (!(dt >= KEEP_STILL_MS || (dt >= KEEP_MOVING_MS && moved >= MOVE_M))) continue
    }
    kept.push(fix)
    prev = fix
  }
  return kept
}

/** Keep what the server will still take: newer than 47 hours, one per
 *  instant, in time order, the newest QUEUE_CAP. */
export function pruneQueue(queue: QueuedFix[], nowMs: number): QueuedFix[] {
  const seen = new Set<number>()
  const fresh = (Array.isArray(queue) ? queue : [])
    .filter(f => Array.isArray(f) && f.length === 6 && Number.isFinite(f[0]) && Number.isFinite(f[1]) && Number.isFinite(f[2])
      && f[0] >= nowMs - QUEUE_KEEP_MS && (f[5] === 'clocked_in' || f[5] === 'en_route'))
    .sort((a, b) => a[0] - b[0])
    .filter(f => (seen.has(f[0]) ? false : (seen.add(f[0]), true)))
  return fresh.length > QUEUE_CAP ? fresh.slice(fresh.length - QUEUE_CAP) : fresh
}

export function flushDue(queueLength: number, lastFlushMs: number, nowMs: number, force = false): boolean {
  if (queueLength === 0) return false
  return force || queueLength >= FLUSH_COUNT || nowMs - lastFlushMs >= FLUSH_EVERY_MS
}

/** The rows one request sends (crew_location_points' insertable columns). */
export function toRows(batch: QueuedFix[], userId: string, tenantId: string) {
  return batch.map(f => ({
    user_id: userId, at: new Date(f[0]).toISOString(), tenant_id: tenantId,
    lat: f[1], lng: f[2], accuracy_m: f[3], job_id: f[4], basis: f[5],
  }))
}

/** A refusal that sending again won't change (the batch is dropped): a rule,
 *  a grant, a CHECK, a bad value. Anything else (no signal, a timeout, a 5xx)
 *  keeps the batch for the next try. */
export function refusedForGood(error: { code?: string | null; status?: number } | null | undefined): boolean {
  const code = error?.code ?? ''
  return code === '42501' || code === '23514' || code === '22P02' || code === '22023' || code === '42703' || code === '42P01' || code === '42P10'
    || code === 'PGRST204' || code === 'PGRST205'
}
