// A Task's or inspection's flat crew pay (jobs.task_pay). Signed-in users
// can't SELECT it (web repo, 20261016140000_task_pay_owner_manager): every
// crew member used to be able to read the pay on every colleague's Task from
// the REST API. job_task_pay() gives owners and managers every job's and
// anyone else the jobs they're assigned to.
//
// A jobs read that names task_pay, or '*', now fails with 42501
// (scripts/test-task-pay.mjs checks every jobs read in the app).
import { supabase } from './supabase'

/**
 * The task pay of each asked-for job the caller may see, keyed by job id: a
 * number, or null for a job with no flat pay. A job missing from the map is
 * one the caller may not see. Throws the database's error.
 */
export async function fetchJobTaskPay(jobIds: string[]): Promise<Map<string, number | null>> {
  const ids = [...new Set(jobIds.filter(Boolean))]
  const out = new Map<string, number | null>()
  if (!ids.length) return out
  const { data, error } = await supabase.rpc('job_task_pay', { p_job_ids: ids })
  if (!error) {
    for (const r of (data ?? []) as { job_id: string; task_pay: number | string | null }[]) {
      out.set(r.job_id, r.task_pay == null ? null : Number(r.task_pay))
    }
    return out
  }
  // Until the migration is applied the function doesn't exist (PostgREST
  // PGRST202) and the column is still readable: read it as before, so this
  // update can reach phones first. Once it's applied this never runs.
  if (error.code !== 'PGRST202') throw error
  const old = await supabase.from('jobs').select('id, task_pay').in('id', ids)
  if (old.error) throw old.error
  for (const r of (old.data ?? []) as { id: string; task_pay: number | string | null }[]) {
    out.set(r.id, r.task_pay == null ? null : Number(r.task_pay))
  }
  return out
}
