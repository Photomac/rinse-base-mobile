// src/lib/inspectionCleanGate.ts
// An inspection is filed on a finished clean (CKS Perfections, 2026-11-09).
//
// "An inspection passed while the cleaner was still working at TQ": in the 60
// days to 2026-11-10, 37 of CKS's 335 filed inspections were filed before
// their clean was completed (16 of them within 15 minutes). rinse-base-app
// 20261110145359_inspection_stays_with_clean refuses it in the database
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
// HELD UNTIL THE CLEAN IS DONE (CKS, Catherine 2026-11-10): "Nichole and I
// can be done and off work before some of our cleaners are." An INSPECTOR (or
// the office) who files before the clean is completed now has the record
// HELD: the app writes job_inspections.held_at instead of completed_at, the
// server stamps the time and who held it, completes the visit, and files the
// record itself the moment the crew completes the clean (guest ready goes out
// then). Anyone else (Mia at TQ: not an inspector) still waits, as above.
// Who may hold is the server's call, asked through the RPC
// inspection_filing_mode(p_parent_job_id, p_tenant_id) -> 'file' | 'hold' |
// 'wait' (rinse-base-app, the hold migration), the same rule its guard uses.
// Before that migration (or with no signal) the RPC fails and the app falls
// back to the status read above: not completed waits, a failed read files.
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

/** What filing does now: 'file' (no clean, or it's completed), 'hold' (its
 *  clean isn't completed and the server lets this person hold it until it
 *  is), 'wait' (its clean isn't completed; nothing is written). */
export type FilingMode = 'file' | 'hold' | 'wait'

/** The server's answer, as supabase-js returns an rpc(). */
export interface ModeRead {
  data: unknown
  error: unknown
}

/** The RPC's answer as a mode, or null when it can't tell (an error: the
 *  function isn't there yet, no signal; or an answer it doesn't know). */
export function modeFromRpc(read: ModeRead | null): FilingMode | null {
  if (!read || read.error) return null
  return read.data === 'file' || read.data === 'hold' || read.data === 'wait' ? read.data : null
}

/** Asks the server (only when the record has a clean); when it can't tell,
 *  falls back to reading the clean's status (checkCleanGate: 'file' or
 *  'wait', never 'hold': only the server says who may hold). */
export async function checkFilingMode(
  parentJobId: unknown,
  tenantId: unknown,
  askMode: (cleanId: string, tenantId: string) => PromiseLike<ModeRead>,
  readStatus: (cleanId: string) => PromiseLike<CleanRead>,
): Promise<FilingMode> {
  if (typeof parentJobId !== 'string' || parentJobId.trim() === '') return 'file'
  let mode: FilingMode | null = null
  if (typeof tenantId === 'string' && tenantId.trim() !== '') {
    let read: ModeRead | null = null
    try { read = await askMode(parentJobId, tenantId) } catch { read = null }
    mode = modeFromRpc(read)
  }
  return mode ?? checkCleanGate(parentJobId, readStatus)
}

/** A record the inspector filed early, waiting for its clean: held_at set,
 *  completed_at still empty. A row from before the column reads as not held. */
export function isHeld(rec: { held_at?: unknown; completed_at?: unknown } | null | undefined): boolean {
  return !!rec && !!rec.held_at && !rec.completed_at
}
