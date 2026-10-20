// Walkthrough lines carried forward, as the crew app shows them.
//
// A line an inspector marked Not right on a filed inspection keeps showing at
// that home until a later filed inspection marks the same line OK, or no
// longer has it on its list. The database works the lines out (web migration
// 20261020123000_walkthrough_carried_lines, rpc walkthrough_carried_lines);
// this file only shapes them for the screen.
//
// Two places:
//   - CarriedLinesCard, at the top of a clean (JobDetailScreen), before and
//     after Start: section, line, the inspector's words and photo, the date.
//     Findings, never scores: no counts and no names there (the rule
//     InspectionResultCard follows).
//   - WalkthroughChecklist, on an inspection: a "Missed last time" block above
//     the sections, each line answered right there on this visit's own row.
//     "Looks good" on a section leaves those lines for the inspector.
//
// No imports, so src/lib/__tests__/carriedLines.scenario.ts runs it as is.

export interface CarriedLine {
  room: string | null
  task: string
  sort_order: number
  issue_note: string | null
  photo_urls: string[]
  missed_at: string
  missed_job_id: string
  missed_item_id: string
  /** Not right answers since the line was last OK (inspector's block only). */
  times_missed: number
  inspector_name: string | null
  /** The same line on the job asked about, when it has one. */
  this_item_id: string | null
  this_result: 'ok' | 'issue' | 'na' | null
}

export interface CarriedSection {
  room: string
  lines: CarriedLine[]
}

/** The rpc's rows, defensively: anything malformed is dropped. */
export function carriedFromRpc(data: unknown): CarriedLine[] {
  if (!Array.isArray(data)) return []
  return data
    .filter((r: any) => r && typeof r.task === 'string' && r.task.trim() && typeof r.missed_at === 'string')
    .map((r: any) => ({
      room: typeof r.room === 'string' ? r.room : null,
      task: r.task,
      sort_order: Number.isFinite(r.sort_order) ? r.sort_order : 0,
      issue_note: typeof r.issue_note === 'string' && r.issue_note.trim() ? r.issue_note.trim() : null,
      photo_urls: Array.isArray(r.photo_urls) ? r.photo_urls.filter((u: unknown) => typeof u === 'string' && !!u) : [],
      missed_at: r.missed_at,
      missed_job_id: r.missed_job_id,
      missed_item_id: r.missed_item_id,
      times_missed: Number.isFinite(r.times_missed) && r.times_missed > 0 ? r.times_missed : 1,
      inspector_name: typeof r.inspector_name === 'string' && r.inspector_name.trim() ? r.inspector_name.trim() : null,
      this_item_id: typeof r.this_item_id === 'string' ? r.this_item_id : null,
      this_result: r.this_result === 'ok' || r.this_result === 'issue' || r.this_result === 'na' ? r.this_result : null,
    }))
}

/** Sections in walk order; a section whose lines are split keeps its first place. */
export function groupCarried(lines: CarriedLine[]): CarriedSection[] {
  const sorted = lines.slice().sort((a, b) => a.sort_order - b.sort_order)
  const out: CarriedSection[] = []
  const at = new Map<string, CarriedSection>()
  for (const l of sorted) {
    const name = l.room?.trim() || 'Other'
    let s = at.get(name)
    if (!s) { s = { room: name, lines: [] }; at.set(name, s); out.push(s) }
    s.lines.push(l)
  }
  return out
}

/** The carried lines' rows on this job: "Looks good" leaves them alone. */
export function carriedItemIds(lines: CarriedLine[]): Set<string> {
  return new Set(lines.map(l => l.this_item_id).filter((id): id is string => !!id))
}

/** What "Looks good" answers: the open lines that weren't missed last time. */
export function looksGoodIds(openIds: string[], carried: Set<string>): string[] {
  return openIds.filter(id => !carried.has(id))
}

/** A job carries the crew card: a clean that isn't finished or called off. */
export function showsCrewCard(job: { job_type?: string | null; status?: string | null } | null | undefined): boolean {
  if (!job) return false
  if ((job.job_type ?? 'clean') !== 'clean') return false
  return !['completed', 'cancelled', 'no_show'].includes(job.status ?? '')
}

/** A job that is itself a walkthrough (it has the lines): the inspector's
 *  block shows instead of the crew card. */
export function isWalkthroughVisit(lines: CarriedLine[]): boolean {
  return lines.some(l => l.this_item_id != null)
}

/** The photos the day pack saves for offline: the first of each line, at most
 *  `perStop` for the stop. */
export function photosToSave(lines: CarriedLine[], perStop = 8): string[] {
  const out: string[] = []
  for (const l of lines.slice().sort((a, b) => a.sort_order - b.sort_order)) {
    const u = l.photo_urls[0]
    if (u && !out.includes(u)) out.push(u)
    if (out.length >= perStop) break
  }
  return out
}
