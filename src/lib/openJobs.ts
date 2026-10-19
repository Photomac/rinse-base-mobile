// Which cleans are on this person's Open jobs board: one rule for the tab's
// badge (App.tsx refreshOpenJobs) and the list on the tab (OpenJobsScreen).
//
// They used to be two rules. The badge counted every open clean; the list
// showed only cleans in the next 60 days. Arise Properties had 8 cleans open,
// all 63 to 106 days out (2026-10-19), so every crew member saw a badge of 8
// over "Nothing open right now", with nothing they could claim. A clean the
// office opened is claimable whatever its date (claim_open_job has no
// horizon), so the board has none either. Both reads go through boardQuery()
// and boardJobsFor(), and nothing else decides what is on the board.
//
// No imports, so scripts/test-open-jobs.mjs can run it as is.

export const BOARD_STATUSES = ['pending_approval', 'scheduled']

// Earliest first; a company with more open cleans than this sees the soonest.
export const BOARD_LIMIT = 200

/** The server-side half: the open, future cleans in this company, soonest
 *  first. `q` is a supabase-js select on jobs; the caller picks the columns. */
export function boardQuery<Q>(q: Q, tenantId: string, now: Date): Q {
  return (q as any)
    .eq('tenant_id', tenantId)
    .not('open_for_claims_at', 'is', null)
    .in('status', BOARD_STATUSES)
    .gt('scheduled_start', now.toISOString())
    .order('scheduled_start')
    .limit(BOARD_LIMIT)
}

/** Still claimable: on the board, pending or scheduled, in the future, and
 *  with a spot left (jobs.max_crew, as claim_open_job counts it). */
export function isOpenJob(j: any, now = Date.now()): boolean {
  return !!j.open_for_claims_at
    && BOARD_STATUSES.includes(j.status)
    && new Date(j.scheduled_start).getTime() > now
    && (j.job_assignments?.length ?? 0) < Math.max(Number(j.max_crew ?? 1), 1)
}

/** Crew first, then everyone (web migration 20261014230000): inside its
 *  first-pick window (jobs.open_to_all_at) a clean is its property's default
 *  crew's alone — claim_open_job refuses anyone else — so only they see it. */
export function offeredFirstTo(j: any, userId: string, now = Date.now()): 'all' | 'me' | 'others' {
  if (!j.open_to_all_at || new Date(j.open_to_all_at).getTime() <= now) return 'all'
  const crew: string[] = j.client_addresses?.default_crew ?? []
  return crew.includes(userId) ? 'me' : 'others'
}

/** The cleans this person sees on the board: the list, and the badge's count. */
export function boardJobsFor<J>(rows: J[], userId: string, now = Date.now()): J[] {
  return rows.filter((j: any) => isOpenJob(j, now) && offeredFirstTo(j, userId, now) !== 'others')
}
