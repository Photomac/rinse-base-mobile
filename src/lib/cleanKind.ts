// What kind of job a card is, on Home's list (beside the time) and on
// Schedule's list (the line under the address).
//
// The cards used to say only "🏠 Turnover" (and "↔ Back-to-back"), so every
// other clean looked alike: CKS's arrival preps (service "Property
// Prep--Arrival"), second runs and linen restocks were told apart only by the
// owner who built the schedule (Catherine, 2026-10-14). The job's service name
// (jobs.service_id → service_types.name, as the office typed it) now says it.
//
// One rule keeps it from saying the same thing twice: on a turnover the
// "🏠 Turnover" tag stays, in the crew's language, and the service follows it
// unless the service's own name already says turnover ("STANDARD TURNOVER",
// "Airbnb Turnover"), which the tag has said. A synced turnover with no
// service reads exactly as it always did.
//
// Laundry runs and tasks get no service: their title already names them
// (🧺 Laundry run, 📌 the task's note), as on the job screen. An inspection
// keeps its "🔍 Inspection" title and shows its service ("Final Inspection")
// here like any clean.
//
// The rows come from `service_types!jobs_service_id_fkey(name)` on the list
// queries. A row cached before that embed existed has no `service_types` and
// reads as it did before.
//
// No imports, so scripts/test-clean-kind.mjs can run it as is.

export interface KindJob {
  job_type?: string | null
  is_turnover?: boolean | null
  window_minutes?: number | null
  service_types?: { name?: string | null } | null
}

/** The service's name as the office typed it, trimmed; null when there is none. */
export function serviceName(job: KindJob | null | undefined): string | null {
  const name = job?.service_types?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/** Does this service name already say "turnover" (in English, or in the
 *  crew's own word for it)? */
export function saysTurnover(name: string, turnoverLabel: string): boolean {
  if (/turn[\s-]*over/i.test(name)) return true
  const label = turnoverLabel.trim().toLowerCase()
  return !!label && name.toLowerCase().includes(label)
}

/**
 * The card's kind, in order, each part ready to print:
 *   ['🏠 Turnover', 'Standard Clean', '↔ Back-to-back'], ['Property Prep--Arrival'], [].
 * Home joins them after the time with ' · '; Schedule puts them on one line.
 */
export function kindParts(
  job: KindJob,
  labels: { turnover: string; backToBack: string },
): string[] {
  const parts: string[] = []
  const typed = job.job_type === 'laundry_run' || job.job_type === 'task'
  const service = typed ? null : serviceName(job)
  if (job.is_turnover) {
    parts.push(`🏠 ${labels.turnover}`)
    if (service && !saysTurnover(service, labels.turnover)) parts.push(service)
  } else if (service) {
    parts.push(service)
  }
  if (job.window_minutes != null) parts.push(`↔ ${labels.backToBack}`)
  return parts
}
