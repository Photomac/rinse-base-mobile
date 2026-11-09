// The linen driver's stops, worked out from rows (no React, no network), for
// components/DriverStopsCard.tsx. A driver (jobs.driver_user_id) drops off
// each clean's linen and picks up the soiled; the office picks them on the
// clean (web migration 20261103214000_driver_on_clean). The linen math is the
// Pull Sheet's and PrepCard's: the property's Linens par plus this clean's
// extra, floored at 0. scripts/test-driver-stops.mjs drives these.

export type LinenRow = { id: string; address_id: string; item_name: string; par_level: number | null; sort_order?: number | null }
export type ExtraRow = { job_id: string; inventory_id: string; extra_qty: number | null }

/** What to bring to one clean, in the property's linen order. */
export function linenFor(stop: { id: string; client_addresses?: { id?: string } | null }, linen: LinenRow[], extras: ExtraRow[]): { name: string; qty: number }[] {
  const addrId = stop.client_addresses?.id
  if (!addrId) return []
  const extra: Record<string, number> = {}
  for (const x of extras) if (x.job_id === stop.id) extra[x.inventory_id] = x.extra_qty || 0
  return linen
    .filter(l => l.address_id === addrId)
    .sort((a, b) => ((a.sort_order ?? 9999) - (b.sort_order ?? 9999)) || a.item_name.localeCompare(b.item_name))
    .map(l => ({ name: l.item_name, qty: Math.max(0, (l.par_level || 0) + (extra[l.id] || 0)) }))
    .filter(l => l.qty > 0)
}

/** Stops grouped by day ('YYYY-MM-DD' from dayOf), days and stops in time order. */
export function stopsByDay<T extends { id: string; scheduled_start: string }>(stops: T[], dayOf: (at: string) => string): { day: string; stops: T[] }[] {
  const sorted = [...stops].sort((a, b) => Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start) || a.id.localeCompare(b.id))
  const out: { day: string; stops: T[] }[] = []
  for (const s of sorted) {
    const day = dayOf(s.scheduled_start)
    const last = out[out.length - 1]
    if (last && last.day === day) last.stops.push(s)
    else out.push({ day, stops: [s] })
  }
  return out
}

/** Nothing left at this stop, so the card folds it to one line (CKS,
 *  2026-11-04: finished stops pushed the next one off the screen). Picked up
 *  alone is NOT finished: crews tap it at the office for the houses they're
 *  carrying bags to (CKS 11/4 09:31, three houses in nine seconds), so the drop
 *  is still ahead. Finished = picked up, and either dropped off or the clean
 *  itself is done: the office stop gets only Picked up and is completed. */
export function stopFinished(stop: { status?: string | null; linen_dropped_at?: string | null; linen_collected_at?: string | null }): boolean {
  return !!stop.linen_collected_at && (!!stop.linen_dropped_at || stop.status === 'completed')
}

/** Which tick to highlight. None until one is ticked: the card shows Picked
 *  up first (CKS, 2026-11-04: their day starts with the bags at the office),
 *  and a stop starts with the pickup at the office but with the drop at a
 *  home. Once the clean linen is dropped, the pickup is what's left. */
export function primaryTick(stop: { linen_dropped_at?: string | null; linen_collected_at?: string | null }): 'pickup' | null {
  return stop.linen_dropped_at && !stop.linen_collected_at ? 'pickup' : null
}

/** First names of who's cleaning there. */
export function crewFirstNames(stop: { crew?: { users?: { full_name?: string | null } | null }[] | null }): string[] {
  return (stop.crew ?? []).map(c => (c.users?.full_name || '').trim().split(/\s+/)[0]).filter(Boolean)
}

// ── The morning pickup (CKS, 2026-11-09) ───────────────────────────────────
// A property can say how long before checkout its bags are picked up at the
// office (client_addresses.linen_pickup_minutes, web migration
// driver_follows_lead_and_pickup_times): CKS picks up Sedona homes 45 minutes
// before checkout and Cottonwood homes 15. The checkout is the property's usual
// one (default_checkout_time), else the company's. It's a time on the
// property's own clock, so it stays a wall-clock time ('HH:MM') and is never
// turned into an instant.

/** Minutes after midnight from 'HH:MM' or 'HH:MM:SS'; null when unreadable. */
export function clockMinutes(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** When to pick up a stop's bags, in minutes after midnight on the property's
 *  clock: the checkout less the property's pickup minutes, never before
 *  midnight. Null when the property sets no pickup minutes or no checkout is
 *  known. */
export function pickupMinutes(checkout: string | null | undefined, before: number | null | undefined): number | null {
  if (before == null || !Number.isFinite(Number(before)) || Number(before) < 0) return null
  const co = clockMinutes(checkout)
  if (co == null) return null
  return Math.max(0, co - Math.round(Number(before)))
}

/** 555 → '09:15', for the app's wall-clock formatter (nextArrival.fmtWallTime). */
export function minutesToClock(min: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export type PickupPlace = { id: string; default_checkout_time?: string | null; linen_pickup_minutes?: number | null }

/** Each property's pickup, by property id; only properties that have one. */
export function pickupsByPlace(places: PickupPlace[] | null | undefined, companyCheckout: string | null | undefined): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of places ?? []) {
    if (!p?.id) continue
    const at = pickupMinutes(p.default_checkout_time || companyCheckout, p.linen_pickup_minutes)
    if (at != null) out.set(p.id, at)
  }
  return out
}

/** One day's stops in pickup order, so the card reads as the morning pickup
 *  list: stops with a pickup time first, earliest pickup first (ties: start
 *  time, then id); then the stops with none, in the order they came (stopsByDay
 *  gives start order). A company that sets no pickup minutes sees no change. */
export function orderByPickup<T extends { id: string; scheduled_start: string }>(stops: T[], pickupOf: (s: T) => number | null): T[] {
  const timed = stops.filter(s => pickupOf(s) != null)
  const rest = stops.filter(s => pickupOf(s) == null)
  timed.sort((a, b) => (pickupOf(a)! - pickupOf(b)!)
    || Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start) || a.id.localeCompare(b.id))
  return [...timed, ...rest]
}
