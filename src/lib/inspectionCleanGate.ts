// src/lib/inspectionCleanGate.ts
// An inspection is filed on a finished clean (CKS Perfections, 2026-11-09).
//
// "An inspection passed while the cleaner was still working at TQ": in the 60
// days to 2026-11-10, 37 of CKS's 335 filed inspections were filed before
// their clean was completed (16 of them within 15 minutes). rinse-base-app
// 20261110140000_inspection_stays_with_clean refuses it in the database
// (trg_zy_guard_inspection_waits_for_clean, errcode 23514): filing a record
// (job_inspections.completed_at going from empty to set) while its clean
// (parent_job_id → jobs.status, read in the record's company) isn't
// 'completed'. A record with no clean files as before.
//
// The crew app has to ask first, because filing clocks the inspector OUT
// before it writes completed_at (JobInspectionScreen doFile(): the safe order
// for payroll). Left to the server, an early tap would end their time and
// then fail. So the form reads the clean's status before the confirm and
// again before the clock-out, and stops on 'wait'.
//
// The same answer as the server's: a clean whose row comes back without
// 'completed' (another status, or no row) waits. Only a read that fails (no
// signal, an error) can't tell, and filing goes ahead as it did before this:
// the server still refuses, and its message is shown.
//
// Pure: no imports, so scripts/test-inspection-waits.mjs loads it as is.

/** The clean's status as supabase-js answers it. */
export interface CleanRead {
  data: { status?: string | null } | null
  error: unknown
}

/** 'file': go ahead. 'wait': its clean isn't completed; nothing is written. */
export type CleanGate = 'file' | 'wait'

/** The decision, from the record's clean and the read of it (null: the read
 *  threw, which is the network failing). */
export function cleanGate(parentJobId: unknown, read: CleanRead | null): CleanGate {
  if (typeof parentJobId !== 'string' || parentJobId.trim() === '') return 'file'
  if (!read || read.error) return 'file'
  return read.data?.status === 'completed' ? 'file' : 'wait'
}

/** Reads the clean (only when there is one) and decides. */
export async function checkCleanGate(
  parentJobId: unknown,
  readStatus: (cleanId: string) => PromiseLike<CleanRead>,
): Promise<CleanGate> {
  if (typeof parentJobId !== 'string' || parentJobId.trim() === '') return 'file'
  let read: CleanRead | null = null
  try { read = await readStatus(parentJobId) } catch { read = null }
  return cleanGate(parentJobId, read)
}
