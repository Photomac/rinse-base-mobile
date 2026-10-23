// What a clean's (or an inspection's) Supplies screen shows about restocking
// at the home. CKS Perfections (Catherine, 2026-10-22): "the property's
// restocking info. What the home needs - its pars and anything running low -
// visible to cleaners AND inspectors while they're standing in the home".
//
// - The par: each catalog item's, as before.
// - What's flagged low here and not restocked yet, on any earlier visit
//   (jobReads openRestockRead): "Flagged low since Oct 20" on the item, and
//   a card at the top. The office's Mark restocked clears it.
// - Counts: the crew add them only when the company allows it
//   (tenants.crew_supply_counts, the Supplies page switch); Mark low always
//   stays. The office always sees them.
//
// Pure (no React, no Supabase) so scripts/test-restock-view.mjs runs it.
import { isOfficeRole } from './jobScope'

/** One item's open flags at the home, this visit's own left out. */
export type ItemFlag = {
  /** The earliest open flag's time: low since then. */
  since: string
  /** How many visits flagged it. */
  visits: number
  /** The latest flag's words, if any. */
  note: string | null
}

/** The home's open flags by inventory_id. This visit's own rows are left
 *  out: they're the lines on the screen. */
export function openFlagsByItem(rows: unknown, jobId: string): Record<string, ItemFlag> {
  const out: Record<string, ItemFlag & { latest: string }> = {}
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.inventory_id !== 'string' || r.job_id === jobId || typeof r.created_at !== 'string') continue
    const note = typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null
    const cur = out[r.inventory_id]
    if (!cur) { out[r.inventory_id] = { since: r.created_at, latest: r.created_at, visits: 1, note }; continue }
    cur.visits++
    if (r.created_at < cur.since) cur.since = r.created_at
    if (r.created_at > cur.latest) { cur.latest = r.created_at; if (note) cur.note = note }
    else if (!cur.note && note) cur.note = note
  }
  return Object.fromEntries(Object.entries(out).map(([k, { latest, ...v }]) => [k, v]))
}

/** The switch from its read: only an explicit false turns the crew's counts
 *  off. A failed read (no signal and nothing saved, or a database without
 *  the column) keeps them, as before. */
export function crewCountsFrom(data: unknown, error: unknown): boolean {
  return !!error || (data as any)?.crew_supply_counts !== false
}

/** Counts on the Supplies list: the office always, the crew unless the
 *  company turned them off. */
export function countsAllowed(role: string | null | undefined, crewCounts: boolean): boolean {
  return isOfficeRole(role) || crewCounts
}
