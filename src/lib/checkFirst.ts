// "Check first": a short list of lines the office sets once per property
// ("Water all the plants", "Spa photo", "Propane OFF"). The crew sees it at the
// top of every clean there and in a window when they tap Start, and must tick
// every line before the clean can be completed. Asked for by CKS Perfections,
// 2026-10-15. The web app applies the same rules in its src/lib/checkFirst.ts.
//
// Tables (rinse-base-app migration 20261015130534_check_first_list):
//   property_check_first_lines  the list; office writes, crew read; archived,
//                               never deleted
//   job_check_first_ticks       one per line per clean (unique job_id, line_id)
//   job_check_first_seen        one per person per clean (unique job_id, user_id)
//   job_photos.check_first_line_id   the photo a "photo" line asks for
//   tenants.check_first_required     lines block Complete only where it's on
//
// The database decides what blocks (job_completion_blockers: codes
// check_first_unticked and check_first_photo_missing). These rules mirror it so
// the phone can say the same thing before it asks, and say it with no signal:
// offline the gate can't be asked, the Complete is queued, and a server refusal
// would then park it. Cleans only, never inspections, tasks or laundry runs.
//
// No imports, so src/lib/__tests__/checkFirst.scenario.ts can run it as is.

export const CHECK_FIRST_MAX = 200

export interface CheckFirstLine {
  id: string
  body: string
  photo_required: boolean
  sort_order: number
  created_at: string
  archived_at: string | null
}

export interface CheckFirstTick {
  line_id: string
  user_id: string
  line_text: string
  ticked_at: string
  users?: { full_name: string | null } | null
}

/** A clean, the only kind of job Check first is on. */
export function isCheckFirstJob(job: { job_type?: string | null } | null | undefined): boolean {
  return !!job && (job.job_type ?? 'clean') === 'clean'
}

/** The lines the crew sees, in the office's order. */
export function activeLines<T extends Pick<CheckFirstLine, 'sort_order' | 'created_at' | 'archived_at'>>(lines: readonly T[]): T[] {
  return lines
    .filter((l) => !l.archived_at)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
}

/** Active lines per property (the prep card's rows carry address_id). */
export function linesByProperty<T extends Pick<CheckFirstLine, 'sort_order' | 'created_at' | 'archived_at'> & { address_id: string }>(
  rows: readonly T[],
): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const l of activeLines(rows)) (out[l.address_id] ||= []).push(l)
  return out
}

/** The earliest clock-in among a clean's punches, or null when it has none. */
export function firstClockIn(entries: readonly { clocked_in_at?: string | null }[]): string | null {
  let first: string | null = null
  for (const e of entries) {
    if (!e?.clocked_in_at) continue
    if (first === null || Date.parse(e.clocked_in_at) < Date.parse(first)) first = e.clocked_in_at
  }
  return first
}

/**
 * When a clean started, as job_check_first_cutoff() reads it: the first
 * clock-in, else jobs.started_at (daily time tracking). null = not started, so
 * every line counts.
 */
export function startedAt(firstIn: string | null | undefined, jobStartedAt: string | null | undefined): string | null {
  return firstIn || jobStartedAt || null
}

/** A line written after the clean started doesn't block it (it's still shown). */
export function blocksThisClean(line: Pick<CheckFirstLine, 'created_at'>, started: string | null): boolean {
  return !started || Date.parse(line.created_at) <= Date.parse(started)
}

export type CheckFirstState = 'todo' | 'needs_photo' | 'done'

/** done = ticked, and for a photo line its photo exists (or is waiting to upload). */
export function lineState(
  line: Pick<CheckFirstLine, 'id' | 'photo_required'>,
  tickedLineIds: ReadonlySet<string>,
  photoLineIds: ReadonlySet<string>,
): CheckFirstState {
  if (!tickedLineIds.has(line.id)) return 'todo'
  if (line.photo_required && !photoLineIds.has(line.id)) return 'needs_photo'
  return 'done'
}

/** The lines still keeping this clean from being completed, in order. */
export function outstanding<T extends CheckFirstLine>(
  lines: readonly T[],
  tickedLineIds: ReadonlySet<string>,
  photoLineIds: ReadonlySet<string>,
  started: string | null,
): { line: T; state: Exclude<CheckFirstState, 'done'> }[] {
  const out: { line: T; state: Exclude<CheckFirstState, 'done'> }[] = []
  for (const line of activeLines(lines)) {
    if (!blocksThisClean(line, started)) continue
    const state = lineState(line, tickedLineIds, photoLineIds)
    if (state !== 'done') out.push({ line, state })
  }
  return out
}

/**
 * The phone's own check before Complete. Blocks only where the company's
 * switch is known to be on: off, or unknown (a failed or missing read), never
 * blocks here, and the server's gate still has the last word.
 */
export function localBlockers<T extends CheckFirstLine>(
  required: boolean | null | undefined,
  lines: readonly T[],
  tickedLineIds: ReadonlySet<string>,
  photoLineIds: ReadonlySet<string>,
  started: string | null,
): { line: T; state: Exclude<CheckFirstState, 'done'> }[] {
  return required === true ? outstanding(lines, tickedLineIds, photoLineIds, started) : []
}

export const CHECK_FIRST_CODES = ['check_first_unticked', 'check_first_photo_missing'] as const

/** The line as the tick keeps it: what the crew read, within the column's 200. */
export function lineText(body: string): string {
  return String(body ?? '').trim().slice(0, CHECK_FIRST_MAX)
}

/** A tick, sent as INSERT … ON CONFLICT (TICK_CONFLICT) DO NOTHING: exactly the
 *  columns crew may insert (no id, no created_at). A second tick is a no-op. */
export function tickRow(o: { tenantId: string; jobId: string; userId: string; line: Pick<CheckFirstLine, 'id' | 'body'>; at?: Date }) {
  return {
    tenant_id: o.tenantId,
    job_id: o.jobId,
    line_id: o.line.id,
    user_id: o.userId,
    line_text: lineText(o.line.body),
    ticked_at: (o.at ?? new Date()).toISOString(),
  }
}
export const TICK_CONFLICT = 'job_id,line_id'

/** "Seen at Start", sent the same way: once per person per clean. */
export function seenRow(o: { tenantId: string; jobId: string; userId: string; at?: Date }) {
  return {
    tenant_id: o.tenantId,
    job_id: o.jobId,
    user_id: o.userId,
    seen_at: (o.at ?? new Date()).toISOString(),
  }
}
export const SEEN_CONFLICT = 'job_id,user_id'
