// Does a guest arrive the day this inspection runs? The card says "↔ Back-to-back"
// like a clean's does (CKS, 2026-10-24: she was comparing dates in the Airbnb app).
//
// A clean carries that on its own row (jobs.window_minutes, set by the sync). An
// inspection has no reservation and can move days, so a copy on its row would go
// stale; it's read from the bookings. An owner block isn't a guest. A finished stay
// still is: the sync marks a past booking 'completed'.
//
// No imports, so scripts/test-same-day-checkin.mjs can run it as is.

export interface ArrivalRow { address_id?: string | null; checkin_date?: string | null }

const addressOf = (j: any): string | null => j?.client_addresses?.id || j?.address_id || null

/** The live inspections to look up: the properties and the days they run on. */
export function inspectionDays(jobs: any[], dayOf: (j: any) => string) {
  const shown = (jobs ?? []).filter(j => j?.job_type === 'inspection' && j.status !== 'cancelled' && addressOf(j))
  const days = shown.map(j => dayOf(j)).sort()
  return { addressIds: [...new Set(shown.map(addressOf) as string[])], from: days[0] ?? null, to: days[days.length - 1] ?? null }
}

/** The ids of the inspections a guest arrives on. */
export function sameDayIds(jobs: any[], arrivals: ArrivalRow[], dayOf: (j: any) => string): Set<string> {
  const keys = new Set((arrivals ?? []).map(a => `${a.address_id}|${a.checkin_date}`))
  return new Set((jobs ?? [])
    .filter(j => j?.job_type === 'inspection' && j.status !== 'cancelled' && keys.has(`${addressOf(j)}|${dayOf(j)}`))
    .map(j => j.id))
}

export function markSameDay<T extends { id: string }>(rows: T[], ids: Set<string>): T[] {
  return ids.size ? rows.map(r => (ids.has(r.id) ? { ...r, same_day_checkin: true } : r)) : rows
}
