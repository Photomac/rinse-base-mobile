// Accept or decline a clean you were given.
//
// ACM Management Services asked for it (2026-10-29): when the office puts a
// cleaner on a clean, the cleaner says yes or no in the app instead of texting
// that they can't make it. Only at a company that turned it on
// (tenants.crew_confirm_cleans, web migration 20261029160000).
//
// WRITES: only through the answer_assigned_clean RPC. Crew have no write on
// job_crew_answers. A decline takes them off the clean on the server (and
// tells the office), so it needs a live yes: nothing is queued in the outbox,
// and a failed call says so.
//
// READS: the switch (tenants.crew_confirm_cleans) and the person's own answers
// (RLS shows a cleaner only their own rows). Before the web migration is
// applied both reads fail and nothing shows.
//
// Pure (no React, no storage, no imports) so scripts/test-crew-answers.mjs runs
// it as is.

/** answer_assigned_clean's reasons, in the order the decline sheet lists them. */
export const DECLINE_REASONS = ['sick', 'unavailable', 'no_ride', 'other'] as const
export type DeclineReason = typeof DECLINE_REASONS[number]

/** A clean is answered while it is still ahead: the server refuses anything else. */
export const ANSWERABLE_STATUSES = ['pending_approval', 'scheduled']

/** The viewer is on this clean, and it is still ahead. */
export function canAnswer(job: any, viewerId: string): boolean {
  return ANSWERABLE_STATUSES.includes(String(job?.status ?? ''))
    && Array.isArray(job?.job_assignments)
    && job.job_assignments.some((a: any) => a?.user_id === viewerId)
}

/** On it, still ahead, and not yet accepted. A decline takes them off the
 *  clean, so a declined one is never on their list to begin with. */
export function needsAnswer(job: any, viewerId: string, accepted: Set<string>): boolean {
  return canAnswer(job, viewerId) && !accepted.has(job.id)
}

/** The words a decline is sent with: spaces squeezed, at most 500 characters
 *  (the server keeps the same). Empty is null. */
export function cleanNote(note: string | null | undefined): string | null {
  const s = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
  return s ? s : null
}

/** Whether Decline can be sent: a reason, and words when the reason is Other. */
export function declineReady(reason: string | null | undefined, note: string | null | undefined): boolean {
  if (!reason || !(DECLINE_REASONS as readonly string[]).includes(reason)) return false
  return reason !== 'other' || cleanNote(note) !== null
}

/** The server's word → the i18n key that explains it. 'accepted' and
 *  'declined' are the two successes; anything unknown is the generic one. */
export function resultKey(code: string): string {
  switch (code) {
    case 'status_not_eligible': return 'answer_r_started'
    case 'not_yours':           return 'answer_r_not_yours'
    case 'not_asked':           return 'answer_r_not_asked'
    case 'error':               return 'answer_r_offline'
    default:                    return 'answer_r_other'
  }
}
