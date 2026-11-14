// The crew app's "Inspections to review" card on Home (CKS Perfections,
// 2026-11-13; web 20261114113340_inspection_review_reminders).
//
// CKS's cleaners reviewed 1 of the 10 inspections that asked for it from Nov 1
// to 13, and nothing in the app listed an inspection once its push was swiped
// away. At a company with inspection review reminders on, Home now lists the
// person's own inspections still waiting for their "I've reviewed this", from
// my_inspections_to_review() (the server decides: their own cleans, not as the
// inspector, needs review, not reviewed, since the company's start, 30 days,
// 20 at most). Tapping one opens that clean, whose InspectionResultCard has the
// button. Reviewing it there takes it off the card at once (inspectionReviewed).
//
// Pure: Node tests import it (scripts/test-inspections-to-review.mjs).

export type Verdict = 'pass' | 'pass_with_corrections' | 'fail'
export interface ToReview { inspectionId: string; jobId: string; property: string; filedAt: string | null; result: Verdict }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The server's rows, read defensively: newest first, one per inspection, 20 at most. */
export function readToReview(rows: unknown): ToReview[] {
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: ToReview[] = []
  for (const r of rows as any[]) {
    if (!r || !UUID.test(String(r.inspection_id)) || !UUID.test(String(r.job_id)) || seen.has(r.inspection_id)) continue
    seen.add(r.inspection_id)
    out.push({
      inspectionId: r.inspection_id,
      jobId: r.job_id,
      property: String(r.property ?? '').trim(),
      filedAt: typeof r.filed_at === 'string' ? r.filed_at : null,
      result: r.result === 'pass_with_corrections' || r.result === 'fail' ? r.result : 'pass',
    })
  }
  return out
    .sort((a, b) => (Date.parse(b.filedAt ?? '') || 0) - (Date.parse(a.filedAt ?? '') || 0))
    .slice(0, 20)
}

/** The verdict's existing words in lib/i18n. */
export const VERDICT_KEY: Record<Verdict, 'insp_pass' | 'insp_pass_corr' | 'insp_fail'> = {
  pass: 'insp_pass', pass_with_corrections: 'insp_pass_corr', fail: 'insp_fail',
}

// A review saved on the clean's screen tells the card, so it drops the row
// without waiting for the next reload.
const listeners = new Set<(inspectionId: string) => void>()
export function onInspectionReviewed(fn: (inspectionId: string) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export function inspectionReviewed(inspectionId: string): void {
  for (const fn of [...listeners]) { try { fn(inspectionId) } catch { /* one listener can't stop the rest */ } }
}
