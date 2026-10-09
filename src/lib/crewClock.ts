// Who on a clean is on the clock, for the "Crew on this job" line.
//
// The job screen's own timer only reads the viewer's entries, so on a two- or
// three-person clean every phone showed exactly one person clocked in — its
// own — while the others were clocked in too (Celebrity Clean, 2026-10-09).
// Crew may read their teammates' entries on the same job (RLS lets any company
// user SELECT job_time_entries in their company); this module only decides
// what each person's entries say.
//
// The rules mirror loadTimeEntries in JobDetailScreen, so a person's line and
// their own timer can never disagree:
//   · an open entry (no clocked_out_at) → on the clock, since that entry began;
//   · otherwise the latest entry closed by a pause, on a clean that isn't
//     finished → paused;
//   · otherwise any entry → clocked out, at the latest entry's end;
//   · no entry → not clocked in.
// Daily-mode companies punch a shift with no job_id, so their per-job entries
// say nothing about who is on site; the screen shows no status for them.

export type CrewClockState = 'on' | 'paused' | 'out' | 'none'

export interface CrewClockEntry {
  user_id: string
  clocked_in_at: string
  clocked_out_at?: string | null
  pause_reason?: string | null
}

export interface CrewClock {
  state: CrewClockState
  /** When that state began: clock-in for 'on', clock-out for 'paused'/'out', null for 'none'. */
  at: string | null
}

/** One person's clock on this clean, from the clean's time entries (anyone's may be passed in). */
export function crewClockFor(entries: CrewClockEntry[], userId: string, jobFinished: boolean): CrewClock {
  const mine = entries
    .filter(e => e.user_id === userId && !!e.clocked_in_at)
    .sort((a, b) => String(a.clocked_in_at).localeCompare(String(b.clocked_in_at)))
  if (mine.length === 0) return { state: 'none', at: null }
  const open = mine.find(e => !e.clocked_out_at)
  if (open) return { state: 'on', at: open.clocked_in_at }
  const last = mine[mine.length - 1]
  if (last.pause_reason && !jobFinished) return { state: 'paused', at: last.clocked_out_at ?? null }
  return { state: 'out', at: last.clocked_out_at ?? null }
}
