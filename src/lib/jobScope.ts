// "Mine / Everyone" on Home and Schedule, for the office only.
//
// Owners, managers and dispatchers see the whole company's day on the phone;
// crew see only the cleans they are on. An owner who also cleans had no way to
// pick her own out of the company's: CKS Perfections, 2026-10-12, 28 route
// stops on Home and nothing saying which were hers. The crew line (#156) names
// who is on each card; this lets the office narrow the lists to their own.
//
// "Mine" is exactly what a crew member's phone shows: the jobs where the viewer
// has a job_assignments row. It reads the PLAIN `job_assignments(user_id)`
// embed, the one the crew filter already uses, never the aliased `crew:` embed:
// that one is for the names on the card and must stay whole.
//
// "Everyone" is the default, so nothing changes for an office user who never
// taps it. The choice is kept per phone (see useJobScope).
//
// Pure (no React, no storage, no imports) so scripts/test-mine-filter.mjs runs
// it as is.

export type JobScope = 'mine' | 'everyone'

/** The roles that see the whole company's day, and so the only ones offered the toggle. */
export const OFFICE_ROLES = ['owner', 'manager', 'dispatcher']

export function isOfficeRole(role: string | null | undefined): boolean {
  return OFFICE_ROLES.includes(String(role ?? ''))
}

/** A saved choice → a scope. Only an explicit 'mine' narrows; nothing saved
 *  yet, or anything unreadable, is Everyone. */
export function parseJobScope(raw: unknown): JobScope {
  return raw === 'mine' ? 'mine' : 'everyone'
}

/** The viewer is on this job. A job with no assignees is nobody's, so it is
 *  never "mine" — the office sees it under Everyone, flagged "No crew assigned". */
export function isMyJob(job: any, viewerId: string): boolean {
  return Array.isArray(job?.job_assignments) && job.job_assignments.some((a: any) => a?.user_id === viewerId)
}

/** A clean's crew as the server lists it (job_assignments.user_id), and
 *  whether that is a live answer or this phone's saved copy. */
export interface Roster { ids: string[]; live: boolean }

/**
 * The viewer is crew and not on this clean, so the server would refuse their
 * clock-in or resume: the insert rule on job_time_entries lets crew start an
 * entry only on a clean they're assigned to (rinsebase-app #1487). The office
 * records for anyone. The screen then says "ask the office to add you" in
 * place of the button.
 *
 * Only once it is known, so someone who is on the clean never loses the button:
 *  - a live roster decides (the list the screen was opened from may predate
 *    the office taking them off);
 *  - a saved roster says "not on it" only if the job's own assignments agree;
 *  - with no roster read yet, it isn't known.
 * `refused`: the server already refused this person's punch here (42501).
 */
export function notAssignedHere(job: any, viewerId: string, opts: { office: boolean; roster: Roster | null; refused?: boolean }): boolean {
  if (opts.office) return false
  if (opts.refused) return true
  const { roster } = opts
  if (!roster) return false
  if (roster.live) return !roster.ids.includes(viewerId)
  return !roster.ids.includes(viewerId) && !isMyJob(job, viewerId)
}

/** The jobs to show. Everyone: all of them, untouched. Mine: the viewer's own,
 *  in the order given. */
export function jobsInScope<T>(jobs: T[], viewerId: string, scope: JobScope): T[] {
  return scope === 'mine' ? jobs.filter(j => isMyJob(j, viewerId)) : jobs
}

export type RouteStops = Record<string, { k: number; m: number }>

/** "Stop k of M": rank among the given jobs that carry a route_order, so it is
 *  always a clean 1..M however the dispatcher generated the order.
 *
 *  Given the Mine list, k and M count only the viewer's own stops. route_order
 *  is one company-wide sequence, so "stop 14 of 28" would tell an owner where
 *  a clean sits in the company's day, not in hers; ranked over her own it
 *  reads "stop 2 of 5", the same numbers a crew member's phone shows. */
export function routeStops(jobs: any[]): RouteStops {
  const ordered = jobs
    .filter((j: any) => j?.route_order != null)
    .sort((a: any, b: any) => a.route_order - b.route_order)
  const map: RouteStops = {}
  ordered.forEach((j: any, i: number) => { map[j.id] = { k: i + 1, m: ordered.length } })
  return map
}

export interface DayView {
  /** The day's jobs that are not cancelled, in the order given. */
  jobs: any[]
  /** Cancelled today: shown as struck-through cards, never counted. */
  cancelled: any[]
  done: number
  remaining: number
  /** The clean underway (in_progress), else null. */
  active: any | null
  /** The next one to work (scheduled or en_route), else null. */
  next: any | null
  stops: RouteStops
}

/** Home's day for one scope: the list, the Today / Done / Remaining counts,
 *  the active and next job, and the route stops, all from the SAME scoped rows
 *  so they can never disagree. `rows` is the day in working order (the screen
 *  sorts it with byCrewDayOrder). */
export function dayView(rows: any[], viewerId: string, scope: JobScope): DayView {
  const inScope = jobsInScope(rows, viewerId, scope)
  const jobs = inScope.filter((j: any) => j.status !== 'cancelled')
  const done = jobs.filter((j: any) => j.status === 'completed').length
  return {
    jobs,
    cancelled: inScope.filter((j: any) => j.status === 'cancelled'),
    done,
    remaining: jobs.length - done,
    active: jobs.find((j: any) => j.status === 'in_progress') || null,
    next: jobs.find((j: any) => j.status === 'scheduled' || j.status === 'en_route') || null,
    stops: routeStops(jobs),
  }
}
