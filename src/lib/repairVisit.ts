// "Needs a return visit" on a repair visit (rinse-base-app migration
// 20261019210000_repair_visit_needs_return).
//
// A repair visit is a Task the office scheduled from a property incident on
// the web (jobs.source_report_id). When the tech finishes it but has to come
// back (a part on order, a bigger fix), he ticks "I need to come back" and the
// same write that completes the visit sets jobs.needs_return_visit. The
// incident then stays open on the web and offers the office "Schedule return
// visit". The web crew view and the job panel ask the same thing.

/** A Task scheduled from an incident: its tech can say he has to come back. */
export function isRepairVisit(job: any): boolean {
  return job?.job_type === 'task' && !!job?.source_report_id
}

/**
 * What Complete adds to its write: the flag, only on a repair visit and only
 * when ticked. Nothing otherwise, so a Complete that doesn't use it sends the
 * same write as before (and works on a database without the column).
 */
export function returnVisitValues(job: any, ticked: boolean): { needs_return_visit?: true } {
  return ticked && isRepairVisit(job) ? { needs_return_visit: true } : {}
}
