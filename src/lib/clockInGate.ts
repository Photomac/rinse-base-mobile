// Clock-in only at the property (tenants.clock_in_location_required, off by
// default). Decides whether a crew member's clock-in goes ahead. Pure, with the
// phone's and the network's answers passed in, so every case can be tested.
//
// This file is the same in rinsebase-app and rinsebase-mobile. The mobile test
// compares them when both repos are on the machine.
//
// A refusal needs proof. The time entry is somebody's pay, so a clock-in is
// refused only when ALL of these hold:
//   - the property has an exact map pin;
//   - the phone gave a fresh fix, accurate to 100 m or better;
//   - the phone is outside the 150 m fence by more than that accuracy;
//   - the office can be reached, and hasn't let this person in on this clean.
//
// Every other case lets the punch through, and the entry records which one in
// clock_in_check, so the office can see what wasn't checked:
//   no_pin         no pin, or one that isn't exact. A street match or a centroid
//                  can sit hundreds of metres from the door, and a legacy pin
//                  (no precision) may be a town centre. Refusing on one would
//                  turn the crew away at the right house.
//   no_permission  location is off for the app. They can't be told apart from
//                  someone who is at the property with a phone set that way.
//   no_fix         no fix in time (indoors, mountains, a cold GPS), or a stale one.
//   weak_accuracy  the fix could be anywhere within a circle wider than 100 m
//                  (iOS Precise Location off, a desktop browser).
//   offline        away from the property, but the office's override couldn't
//                  reach this phone, so a refusal would have no way out.
//
// docs/clock-in-location-spec.md has the reasoning and what this can't catch.

/** The arrival fence, the same 150 m the crew app's arrival geofence uses. */
export const CLOCK_IN_FENCE_M = 150
/** A fix less accurate than this proves nothing about a 150 m fence. */
export const CLOCK_IN_MAX_ACCURACY_M = 100
/** Older than this may be from the drive over. */
export const CLOCK_IN_MAX_FIX_AGE_MS = 60_000
/** How long the crew member waits for a fix before the punch goes ahead. */
export const CLOCK_IN_FIX_WAIT_MS = 8_000

export type ClockInCheck = 'inside' | 'override' | 'office' | 'no_pin' | 'no_permission' | 'no_fix' | 'weak_accuracy' | 'offline'

export interface ClockInSite {
  name?: string | null
  lat?: number | string | null
  lng?: number | string | null
  /** client_addresses.geocode_precision. A company's own office pin passes 'exact'. */
  precision?: string | null
}

export interface ClockInFix {
  lat: number
  lng: number
  /** Metres. Null or missing counts as weak. */
  accuracy: number | null
  /** When the fix was taken, ms since the epoch. */
  at: number
}

export type ClockInDecision =
  | { allow: true; check: ClockInCheck; distanceM: number | null; accuracyM: number | null; stamp: { lat: number; lng: number } | null }
  | { allow: false; distanceM: number; accuracyM: number; stamp: { lat: number; lng: number }; siteName: string | null }

export function distanceBetweenM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** A pin good enough to turn someone away on. */
export function pinOf(site: ClockInSite | null | undefined): { lat: number; lng: number } | null {
  if (!site || site.lat == null || site.lng == null || site.precision !== 'exact') return null
  const lat = Number(site.lat), lng = Number(site.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null
  return { lat, lng }
}

export const siteOf = (addr: any): ClockInSite => ({
  name: addr?.nickname || addr?.street || null,
  lat: addr?.lat, lng: addr?.lng, precision: addr?.geocode_precision,
})

/**
 * Where Start my day may begin: today's cleans and the office. Without an
 * office pin the list holds an unknown place, which the gate treats as
 * somewhere they could be standing, so the start isn't refused.
 */
export function daySites(jobs: any[], office: ClockInSite | null): ClockInSite[] {
  return [...jobs.map(j => siteOf(j.client_addresses)), office ?? { name: null, lat: null, lng: null, precision: null }]
}

// Owners and managers can let themselves in, so they aren't checked. Dispatchers
// clock in as crew at some companies (gate_settings_office_only), so they are.
export const notCheckedRole = (role: string | null | undefined) => role === 'owner' || role === 'admin' || role === 'manager'

export interface ClockInGateDeps {
  /** The property, or for Start my day every place the day could start. */
  sites: () => ClockInSite[] | Promise<ClockInSite[]>
  /** Asks when the phone hasn't been asked yet. */
  permission: () => 'granted' | 'denied' | Promise<'granted' | 'denied'>
  fix: () => ClockInFix | null | Promise<ClockInFix | null>
  online: () => boolean | Promise<boolean>
  /** Has the office let this person in? A throw means the answer never came. */
  overridden: () => boolean | Promise<boolean>
  now?: () => number
}

// A failed answer takes the fail-open branch: nothing here may stop a punch by
// breaking.
async function answer<T>(ask: () => T | Promise<T>, otherwise: T): Promise<T> {
  try { return await ask() } catch { return otherwise }
}

/** Run the check. Never throws. Call it only with the company's switch on. */
export async function runClockInGate(deps: ClockInGateDeps): Promise<ClockInDecision> {
  const now = deps.now ?? Date.now
  const pass = (check: ClockInCheck, distanceM: number | null = null, fix: ClockInFix | null = null): ClockInDecision => ({
    allow: true, check, distanceM,
    accuracyM: fix?.accuracy != null ? Math.round(fix.accuracy) : null,
    stamp: fix ? { lat: fix.lat, lng: fix.lng } : null,
  })

  const sites = await answer(deps.sites, [] as ClockInSite[])
  const pins = (sites ?? []).map(pinOf)
  if (!pins.some(Boolean)) return pass('no_pin')

  if ((await answer(deps.permission, 'denied' as const)) !== 'granted') return pass('no_permission')

  const fix = await answer(deps.fix, null)
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return pass('no_fix')
  if (!Number.isFinite(fix.at) || now() - fix.at > CLOCK_IN_MAX_FIX_AGE_MS) return pass('no_fix')
  // A stale fix isn't kept as a stamp above, but a weak one still says roughly where.
  if (fix.accuracy == null || !Number.isFinite(fix.accuracy) || fix.accuracy > CLOCK_IN_MAX_ACCURACY_M) return pass('weak_accuracy', null, fix)

  let nearest = Infinity
  let nearestIndex = -1
  pins.forEach((pin, i) => {
    if (!pin) return
    const d = distanceBetweenM(fix.lat, fix.lng, pin.lat, pin.lng)
    if (d < nearest) { nearest = d; nearestIndex = i }
  })
  const distanceM = Math.round(nearest)
  if (nearest - fix.accuracy <= CLOCK_IN_FENCE_M) return pass('inside', distanceM, fix)

  // Outside every pin we can trust. Start my day may have another place in the
  // list with no pin, and they could be standing there.
  if (pins.some(p => !p)) return pass('no_pin', distanceM, fix)

  if (!(await answer(deps.online, false))) return pass('offline', distanceM, fix)
  const overridden = await answer(deps.overridden as () => boolean | Promise<boolean> | null, null)
  if (overridden === null) return pass('offline', distanceM, fix)
  if (overridden) return pass('override', distanceM, fix)

  return {
    allow: false, distanceM, accuracyM: Math.round(fix.accuracy),
    stamp: { lat: fix.lat, lng: fix.lng },
    siteName: sites[nearestIndex]?.name ?? null,
  }
}

/** The audit columns for the time entry, or nothing when the switch is off. */
export function clockInFields(d: ClockInDecision | null | undefined): { clock_in_check?: ClockInCheck; clock_in_distance_m?: number | null } {
  if (!d || !d.allow) return {}
  return { clock_in_check: d.check, clock_in_distance_m: d.distanceM }
}

/** "0.4 mi (0.6 km)": the crew's message names both, since the app runs in both. */
export function fmtClockInDistance(metres: number): string {
  const km = metres / 1000
  return `${(km * 0.621371).toFixed(1)} mi (${km.toFixed(1)} km)`
}
