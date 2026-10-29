// The reads behind accept / decline (lib/crewAnswers): whether the company
// asks, and which of the viewer's cleans they already accepted.
//
// Plain reads, not cachedQuery(): an answer needs a live call anyway, and a
// stale copy saying "accepted" would hide a clean the server moved to another
// day (which clears the yes). Offline or before the web migration, the reads
// fail and nothing shows.
import { useEffect, useState, useCallback } from 'react'
import { supabase } from './supabase'
import { ANSWERABLE_STATUSES } from './crewAnswers'

/** Whether the viewer's company asks crew to accept or decline. null = no
 *  (or unknown: offline, or the column isn't there yet). */
export async function readCompanyAsks(tenantId: string): Promise<boolean | null> {
  const { data, error } = await supabase.from('tenants').select('crew_confirm_cleans').eq('id', tenantId).maybeSingle()
  if (error || !data) return null
  return (data as any).crew_confirm_cleans === true ? true : null
}

/** The viewer's own answer on one clean, or null for none. */
export async function readMyAnswer(jobId: string, userId: string): Promise<{ answer: string } | null | 'error'> {
  const { data, error } = await supabase.from('job_crew_answers')
    .select('answer').eq('job_id', jobId).eq('user_id', userId).maybeSingle()
  if (error) return 'error'
  return data ? { answer: (data as any).answer } : null
}

/** Accept or decline, through the server. Returns its word, or 'error' when the
 *  call itself failed (no signal, a timeout). */
export async function sendAnswer(jobId: string, answer: 'accepted' | 'declined', reason?: string | null, note?: string | null): Promise<string> {
  const { data, error } = await supabase.rpc('answer_assigned_clean', {
    p_job_id: jobId, p_answer: answer, p_reason: reason ?? null, p_note: note ?? null,
  })
  return error ? 'error' : String(data)
}

/**
 * The viewer's upcoming cleans still waiting on their answer, for Home's
 * banner and Schedule's tags. null = the company doesn't ask (show nothing).
 * `reloadKey` re-reads (Schedule passes its load count).
 */
export function useAwaitingAnswers(user: any, reloadKey: unknown = 0): { waiting: Set<string>; reload: () => void } | null {
  const [state, setState] = useState<Set<string> | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick(n => n + 1), [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!user?.id || !user?.tenant_id) { setState(null); return }
      const asks = await readCompanyAsks(user.tenant_id)
      if (cancelled) return
      if (!asks) { setState(null); return }
      const [{ data: jobs, error: je }, { data: answers, error: ae }] = await Promise.all([
        supabase.from('jobs')
          .select('id, job_assignments!inner(user_id)')
          .eq('tenant_id', user.tenant_id)
          .eq('job_assignments.user_id', user.id)
          .in('status', ANSWERABLE_STATUSES)
          .gte('scheduled_start', new Date().toISOString())
          .order('scheduled_start')
          .limit(200),
        supabase.from('job_crew_answers').select('job_id').eq('user_id', user.id).eq('answer', 'accepted').limit(1000),
      ])
      if (cancelled) return
      if (je || ae) { setState(null); return }
      const accepted = new Set((answers ?? []).map((a: any) => a.job_id as string))
      setState(new Set((jobs ?? []).map((j: any) => j.id as string).filter(id => !accepted.has(id))))
    })()
    return () => { cancelled = true }
  }, [user?.id, user?.tenant_id, reloadKey, tick])

  return state ? { waiting: state, reload } : null
}
