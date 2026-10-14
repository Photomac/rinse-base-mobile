// "Everyone", crew by crew: the office's view of the whole day on Home and
// Schedule, in one section per crew member instead of one long time-sorted run.
//
// CKS Perfections, 2026-10-14: in Everyone, 27 cleans across nine people sat
// in one cluster, so the owner (who dispatches and cleans) had to read every
// crew line to see who had what. On the web she lives in Schedule → Crew and
// her manager in Schedule → Day ("One day, crew by crew"), because they keep
// each person's day apart. This is the phone's version of that Day view.
//
// The rules, and where they differ from the web's Day view:
// • A clean sits under ONE person: the first name on its crew line, which is
//   its lead (crewNames puts the lead first). The web draws a multi-crew clean
//   in every member's lane; on a phone that repeats cards down one long list
//   and makes the section counts add up to more than the day. Here each clean
//   appears once, the counts add up to Home's "Today" figure, and the card's
//   crew line still names the helpers.
// • Sections are A–Z by full name, as on the web, with the viewer in her own
//   place under "You" (the web lists her by name). Same order on every office
//   phone and on the web, so "Jennifer is third" holds wherever you look.
// • "No crew assigned" comes FIRST, not last as on the web's Day view. On a
//   phone the bottom of a 27-card list is many screens down, and an unstaffed
//   clean is on nobody's phone, so it is the one thing the office has to act
//   on. The web's Crew board pins Unassigned to the top for the same reason.
//   A clean lands there exactly when its card says "No crew assigned".
// • Inside a section the order is the day's working order (byCrewDayOrder,
//   already applied by the screens), and "Stop k of M" is ranked over that
//   person's stops: the numbers their own phone shows, not a company-wide rank.
// • Cancelled cleans are not anyone's work; the screens keep them as their own
//   cards after the sections.
//
// Pure (no React, no storage), so scripts/test-everyone-by-crew.mjs runs it as is.
import { crewNames, type CrewAssignment } from './crewNames'
import { routeStops, type RouteStops } from './jobScope'

export const UNASSIGNED_GROUP = 'unassigned'

export interface CrewGroup {
  /** The person's user id, or UNASSIGNED_GROUP. */
  id: string
  kind: 'crew' | 'me' | 'unassigned'
  /** "Nichole W.", "You", or '' for the unassigned section (the header words it). */
  label: string
  /** In working order. */
  jobs: any[]
  /** "Stop k of M" over this section's jobs. */
  stops: RouteStops
}

/** The day, one section per person. `jobs` is the day in working order with
 *  cancelled cleans already taken out.
 *
 *  Null when any clean lacks its `crew` rows (a copy cached before the crew
 *  line existed): sorting it into a section would be a guess, so the screen
 *  shows the plain list instead, as CrewLine shows nothing for such a row. */
export function crewGroups(jobs: any[], viewerId: string, youLabel: string): CrewGroup[] | null {
  if (!jobs.every(j => Array.isArray(j?.crew))) return null

  const byId = new Map<string, CrewGroup & { sortName: string }>()
  const unassigned: any[] = []
  for (const job of jobs) {
    const first = crewNames(job.crew as CrewAssignment[], viewerId, youLabel)[0]
    if (!first) { unassigned.push(job); continue }
    let g = byId.get(first.id)
    if (!g) {
      const full = fullName(job.crew, first.id)
      g = { id: first.id, kind: first.isMe ? 'me' : 'crew', label: first.label, jobs: [], stops: {}, sortName: full || first.label }
      byId.set(first.id, g)
    }
    g.jobs.push(job)
  }

  const people = [...byId.values()]
  // Two people who shorten alike ("Maria G." twice) get their full names on
  // the headers, or the two sections would read as one person's day split.
  const seen = new Map<string, number>()
  for (const g of people) seen.set(g.label, (seen.get(g.label) ?? 0) + 1)
  for (const g of people) if (g.kind === 'crew' && (seen.get(g.label) ?? 0) > 1) g.label = g.sortName

  people.sort((a, b) => a.sortName.toLowerCase().localeCompare(b.sortName.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const out: CrewGroup[] = []
  if (unassigned.length) out.push({ id: UNASSIGNED_GROUP, kind: 'unassigned', label: '', jobs: unassigned, stops: routeStops(unassigned) })
  for (const g of people) out.push({ id: g.id, kind: g.kind, label: g.label, jobs: g.jobs, stops: routeStops(g.jobs) })
  return out
}

function fullName(crew: CrewAssignment[], userId: string): string {
  return String(crew.find(r => r?.user_id === userId)?.users?.full_name ?? '').trim()
}

export type ListItem =
  | { kind: 'header'; group: CrewGroup }
  | { kind: 'job'; job: any; stops: RouteStops }

/** What a day list renders, top to bottom. Without sections (Mine, crew, or a
 *  day that can't be sectioned) it is the jobs as given with the day's stops,
 *  exactly the list as it was; with them, each section's header and then its
 *  cleans, numbered within the section. */
export function listItems(jobs: any[], stops: RouteStops, groups: CrewGroup[] | null): ListItem[] {
  if (!groups) return jobs.map(job => ({ kind: 'job' as const, job, stops }))
  const out: ListItem[] = []
  for (const group of groups) {
    out.push({ kind: 'header', group })
    for (const job of group.jobs) out.push({ kind: 'job', job, stops: group.stops })
  }
  return out
}
