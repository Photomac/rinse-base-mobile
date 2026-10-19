// The running clock on a job for day-shift (daily time tracking) companies:
// how long the crew has been there so far, counted from the Start tap that
// jobs.started_at keeps (rinsebase-app 20261012143932). One clock per job, so a
// team on the same clean sees the same time.
//
// Per-job time tracking has its own timer on the job screen (each person's
// clocked minutes, pauses left out). This is only for daily mode, whose cleans
// have no per-person punches, so a crew asked for something to pace by (CKS,
// 2026-10-18).

/** The longest believable stretch, as the server uses it for a start
 *  (trg_stamp_job_started_at) and a forgotten shift: past it, a job left in
 *  progress from an earlier day shows no clock rather than "27h 4m". */
export const JOB_CLOCK_MAX_MS = 16 * 3600 * 1000

type ClockJob = { status?: string | null; started_at?: string | null } | null | undefined

/** Milliseconds since the job started, or null when no clock runs: not in
 *  progress, no start, a start that can't be read, or one past the cap. A start
 *  ahead of this phone's clock reads 0. */
export function jobClockMs(job: ClockJob, now: number): number | null {
  if (!job || job.status !== 'in_progress' || !job.started_at) return null
  const start = Date.parse(job.started_at)
  if (!Number.isFinite(start)) return null
  const ms = now - start
  if (ms > JOB_CLOCK_MAX_MS) return null
  return Math.max(0, ms)
}

/** "1h 12m", "12m", "0m": whole minutes elapsed, never "1h 60m". */
export function fmtJobClock(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
