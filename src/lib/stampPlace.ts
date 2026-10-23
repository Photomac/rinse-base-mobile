// src/lib/stampPlace.ts
// Where a punch's GPS stamp was, in words the office can read: "at SILEX", or
// "2.4 mi from SILEX", measured to the nearest home on that person's list that
// day. A day-shift start or end is one tap with no clean attached, so a bare
// pair of coordinates means nothing to the owner until it is put next to the
// homes the person was meant to be at.
//
// Pure: no I/O, no clock, no zone. The caller says which homes count and which
// company day an instant falls on (dayOf). A copy of rinsebase-app
// src/lib/stampPlace.ts (Time logs, Payroll); scripts/test-stamp-place.mjs
// compares the two over a grid of inputs when the web repo is on this machine.

export interface StampHome {
  name: string
  lat: number | string | null | undefined
  lng: number | string | null | undefined
  /** client_addresses.geocode_precision */
  precision?: string | null
}

export type StampPlace =
  | { kind: 'at'; name: string; metres: number }
  | { kind: 'near'; name: string; metres: number; miles: number }
  | { kind: 'none' }

/** Within this of a home's pin the stamp reads "at" it. The same 300 m the
 *  left-the-property check uses: a phone fix is good to ~100 m, and a pin sits
 *  on the building, not the driveway. */
export const AT_HOME_M = 300

const M_PER_MILE = 1609.344

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** A coordinate pair a punch carries, or null when it carries none. `!= null`
 *  rather than falsy: latitude 0 / longitude 0 are valid. */
export function stampOf(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const a = num(lat), b = num(lng)
  if (a == null || b == null) return null
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null
  return { lat: a, lng: b }
}

export function metresBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** The stamp next to the nearest usable home. null = the punch has no stamp.
 *  An approximate pin (a ZIP or town centre, 1-3 km off) is never measured to:
 *  "2 mi from" a centroid would read as the crew member being somewhere else. */
export function stampPlace(lat: unknown, lng: unknown, homes: StampHome[]): StampPlace | null {
  const s = stampOf(lat, lng)
  if (!s) return null
  let best: { name: string; metres: number } | null = null
  for (const h of homes) {
    if (h.precision === 'approximate') continue
    const p = stampOf(h.lat, h.lng)
    if (!p) continue
    const m = metresBetween(s.lat, s.lng, p.lat, p.lng)
    // Ties keep the first home listed (the caller lists them in day order).
    if (!best || m < best.metres) best = { name: h.name, metres: m }
  }
  if (!best) return { kind: 'none' }
  const metres = Math.round(best.metres)
  if (best.metres <= AT_HOME_M) return { kind: 'at', name: best.name, metres }
  return { kind: 'near', name: best.name, metres, miles: best.metres / M_PER_MILE }
}

/** "0.3 mi", "2.4 mi", "14 mi". Past AT_HOME_M is at least 0.19 mi, so the
 *  smallest this shows is 0.2. */
export function fmtMiles(miles: number): string {
  if (!Number.isFinite(miles) || miles < 0) return ''
  if (miles >= 10) return `${Math.round(miles)} mi`
  return `${(Math.round(miles * 10) / 10).toFixed(1)} mi`
}

/** A map of the spot. Five decimals is about a metre: more than a phone fix is good for. */
export function stampMapUrl(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`
}

export interface StampJob {
  scheduled_start: string | null
  status?: string | null
  completed_by_user_id?: string | null
  job_assignments?: { user_id: string | null }[] | null
  client_addresses?: {
    nickname?: string | null
    street?: string | null
    lat?: number | string | null
    lng?: number | string | null
    geocode_precision?: string | null
  } | null
}

/** The homes on one person's list on one company day: cleans they were
 *  assigned to or completed, cancelled ones left out, in the order given.
 *  dayOf turns an instant into the company's YYYY-MM-DD. */
export function homesForPersonDay(jobs: StampJob[], userId: string, ymd: string, dayOf: (iso: string) => string): StampHome[] {
  const out: StampHome[] = []
  for (const j of jobs) {
    if (!j.scheduled_start || j.status === 'cancelled') continue
    const mine = j.completed_by_user_id === userId
      || (j.job_assignments ?? []).some(a => a?.user_id === userId)
    if (!mine || dayOf(j.scheduled_start) !== ymd) continue
    const a = j.client_addresses
    if (!a) continue
    out.push({ name: a.nickname || a.street || '', lat: a.lat, lng: a.lng, precision: a.geocode_precision })
  }
  return out
}
