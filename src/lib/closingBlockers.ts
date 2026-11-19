// Home's "Needs closing" badges: how many completion blockers each open clean
// still has ("Ready to close" at 0, "N photos outstanding" above).
//
// One request per 100 cleans: job_completion_blocker_counts(uuid[])
// (rinse-base-app 20261118210000) answers count(*) of job_completion_blockers()
// for each clean, as the person asking, so the badge is the gate's own answer,
// the same gate JobDetailScreen enforces on Complete. Home used to send one
// job_completion_blockers request per clean, all at once: an office phone at a
// company with 42 or 55 open cleans fired that many in a fraction of a second,
// more than the server's ~24 connections, and every one of them (and everyone
// else's requests) waited in line: 367 ms on average where one call alone takes
// ~20 ms (API logs, 2026-11-17/18).
//
// A server without the batch (it was dropped) gets the old one-clean calls,
// four at a time, never all at once. Any other failure (no signal, a timeout)
// answers nothing for those cleans, and Home shows no badge for them: an
// optimistic "ready" the gate then refuses is worse than none.

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>

/** Cleans per batch request (the server refuses more than 200). */
export const BATCH_SIZE = 100
/** One-clean gate calls in flight at once when the batch is missing. */
export const FALLBACK_AT_ONCE = 4

/** PostgREST's "no such function" (PGRST202), or a 404 from the RPC route. */
export function batchMissing(error: any): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.status === 404
}

/** The batch's rows as { job_id: blockers }, dropping anything malformed. */
export function countsFromRows(rows: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!Array.isArray(rows)) return out
  for (const r of rows as any[]) {
    if (r && typeof r.job_id === 'string' && r.job_id && Number.isInteger(r.blockers) && r.blockers >= 0) {
      out[r.job_id] = r.blockers
    }
  }
  return out
}

/** The blocker count for each clean the server answered for; a clean it
 *  didn't answer for is absent (no badge). */
export async function closingBlockerCounts(rpc: Rpc, jobIds: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(jobIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const out: Record<string, number> = {}
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE)
    const { data, error } = await Promise.resolve(rpc('job_completion_blocker_counts', { p_job_ids: chunk }))
      .catch((e: any) => ({ data: null, error: e ?? true }))
    if (!error) {
      Object.assign(out, countsFromRows(data))
      continue
    }
    if (!batchMissing(error)) continue
    for (let k = 0; k < chunk.length; k += FALLBACK_AT_ONCE) {
      const part = chunk.slice(k, k + FALLBACK_AT_ONCE)
      const answers = await Promise.all(part.map(id =>
        Promise.resolve(rpc('job_completion_blockers', { p_job_id: id })).catch(() => ({ data: null, error: true }))))
      answers.forEach((a, j) => {
        if (!a.error) out[part[j]] = Array.isArray(a.data) ? a.data.length : 0
      })
    }
  }
  return out
}
