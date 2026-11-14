// Which cleans are on this person's Open jobs board: one rule for the tab's
// badge (App.tsx refreshOpenJobs) and the list on the tab (OpenJobsScreen).
//
// They used to be two rules. The badge counted every open clean; the list
// showed only cleans in the next 60 days. Arise Properties had 8 cleans open,
// all 63 to 106 days out (2026-10-19), so every crew member saw a badge of 8
// over "Nothing open right now", with nothing they could claim. Both read the
// same rows and count them through boardJobsFor(), and nothing else decides
// what is on the board.
//
// THE ROWS (crew read scope, stage 1; rinse-base-app 20261113171611): both
// read the open_board_jobs() RPC, not jobs. The board used to read the open
// cleans straight from jobs, with the client's name and phone, the
// property's lockbox code and its default crew, for cleans nobody had
// claimed; once a company's crew read scope is on, crew can't read a clean
// they are not on at all. The RPC hands each person what a card shows and
// nothing else: no client, no codes, no notes (a task's card shows its
// service name: notes can hold codes). For crew it lists the cleans they
// could claim now (open to everyone, or first pick for them) plus the board
// cleans they already claimed; for the office every board clean. It decides
// the horizon too: cleans starting within the next 30 days.
//
// No imports, so scripts/test-open-jobs.mjs can run it as is.

export const BOARD_STATUSES = ['pending_approval', 'scheduled']

/** One row of open_board_jobs(). */
export interface BoardRpcRow {
  job_id: string
  job_number: number | null
  status: string
  job_type: string | null
  scheduled_start: string
  scheduled_end: string | null
  is_turnover: boolean
  calendar_made: boolean
  service_name: string | null
  property_name: string | null
  street: string | null
  city: string | null
  property_timezone: string | null
  max_crew: number | null
  spots_taken: number
  open_to_all_at: string | null
  offered_to_me: boolean
  claimed_by_me_at: string | null
}

/** A board card's row: the RPC's answer in the shape the screens' helpers
 *  read (id, client_addresses for the place and its clock, service_types,
 *  reservation_id for the calendar mark). */
export interface BoardRow {
  id: string
  job_number: number | null
  status: string
  job_type: string | null
  scheduled_start: string
  scheduled_end: string | null
  is_turnover: boolean
  /** Only whether a booking made it: the mark needs nothing more. */
  reservation_id: string | null
  service_types: { name: string } | null
  client_addresses: { nickname: string | null; street: string | null; city: string | null; timezone: string | null }
  max_crew: number | null
  spots_taken: number
  open_to_all_at: string | null
  offered_to_me: boolean
  claimed_by_me_at: string | null
}

/** open_board_jobs()'s rows as card rows. Anything that isn't one (a copy
 *  saved by an older app, a failed read) is dropped. */
export function boardRows(data: unknown): BoardRow[] {
  if (!Array.isArray(data)) return []
  return data.filter((r: any) => r && typeof r.job_id === 'string' && r.scheduled_start).map((r: BoardRpcRow) => ({
    id: r.job_id,
    job_number: r.job_number ?? null,
    status: r.status,
    job_type: r.job_type ?? null,
    scheduled_start: r.scheduled_start,
    scheduled_end: r.scheduled_end ?? null,
    is_turnover: !!r.is_turnover,
    reservation_id: r.calendar_made ? 'calendar' : null,
    service_types: r.service_name ? { name: r.service_name } : null,
    client_addresses: { nickname: r.property_name ?? null, street: r.street ?? null, city: r.city ?? null, timezone: r.property_timezone ?? null },
    max_crew: r.max_crew ?? null,
    spots_taken: Number(r.spots_taken ?? 0),
    open_to_all_at: r.open_to_all_at ?? null,
    offered_to_me: !!r.offered_to_me,
    claimed_by_me_at: r.claimed_by_me_at ?? null,
  }))
}

/** Still claimable: pending or scheduled, in the future, and with a spot left
 *  (jobs.max_crew, as claim_open_job counts it). */
export function isOpenJob(j: BoardRow, now = Date.now()): boolean {
  return BOARD_STATUSES.includes(j.status)
    && new Date(j.scheduled_start).getTime() > now
    && j.spots_taken < Math.max(Number(j.max_crew ?? 1), 1)
}

/** Crew first, then everyone (web migration 20261014230000): inside its
 *  first-pick window (jobs.open_to_all_at) a clean is its property's default
 *  crew's alone — claim_open_job refuses anyone else — so only they see it.
 *  The RPC says whether this person is one of them (offered_to_me). */
export function offeredFirstTo(j: BoardRow, now = Date.now()): 'all' | 'me' | 'others' {
  if (!j.open_to_all_at || new Date(j.open_to_all_at).getTime() <= now) return 'all'
  return j.offered_to_me ? 'me' : 'others'
}

/** The cleans this person sees on the board: the list, and the badge's count. */
export function boardJobsFor(rows: BoardRow[], now = Date.now()): BoardRow[] {
  return rows.filter(j => isOpenJob(j, now) && offeredFirstTo(j, now) !== 'others')
}

/** Board cleans this person claimed: where "give back" lives (a full one has
 *  left the open list). */
export function claimedByMe(rows: BoardRow[]): BoardRow[] {
  return rows.filter(j => !!j.claimed_by_me_at)
}
