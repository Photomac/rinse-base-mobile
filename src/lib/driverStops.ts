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

/** What's left at a stop: drop the clean linen, pick up the soiled, or nothing. */
export function nextStep(stop: { linen_dropped_at?: string | null; linen_collected_at?: string | null }): 'drop' | 'pickup' | 'done' {
  if (stop.linen_collected_at) return 'done'
  if (stop.linen_dropped_at) return 'pickup'
  return 'drop'
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
