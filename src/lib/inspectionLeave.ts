// src/lib/inspectionLeave.ts
// An inspection opened while the crew are still cleaning says so up front, and
// the form asks before the inspector leaves without filing (CKS Perfections,
// 2026-11-15, BOCCE).
//
// WHY. Nichole walked BOCCE while the crew were still cleaning and backed out
// of the inspection without filing or holding it. The crew completed the
// clean, guest ready waited for the inspection, and the homeowner never heard.
// What we promised Catherine: "When an inspection is opened while the crew are
// still cleaning, the app says up front that filing now holds it until they
// finish, and asks before they leave without filing." (The other half, a text
// to the inspector the moment the clean is completed, is rinse-base-app's
// notify-inspection-owed.)
//
// THE BANNER. Shown on an inspection not filed or held whose clean is still
// open (scheduled, on the way or being cleaned), worded by what filing does
// for this person now: the same answer the form already asks before filing
// (inspection_filing_mode through lib/inspectionCleanGate checkFilingMode), so
// there is one source for it:
//   'hold' (an inspector, or the office): "tap Complete inspection: it's held
//          and goes out as guest ready the moment they complete the clean";
//   'wait' (anyone else): an inspector has to file it; tap Save progress so
//          the notes are kept.
// 'file' (the server says the clean is completed) or no answer: no banner.
//
// LEAVING. Back (the header's, or Android's hardware back) asks "Leave
// without filing?" when the form isn't filed or held and something changed
// since it was loaded or last saved: a result picked, the layer, corrections,
// minutes or notes changed, or a walkthrough line answered (those save
// themselves, but the inspection is still not filed). Stay, Save progress
// (when the form can save), Leave. Nothing changed, or filed or held: back
// leaves at once. After a Save progress that worked nothing has changed, so
// back leaves; after filing or holding the job screen closes the form.
//
// Pure: type imports only, so scripts/test-inspection-leave.mjs loads it as is.

import type { FilingMode } from './inspectionCleanGate'

/** The form's own fields (JobInspectionScreen). */
export interface InspectionForm {
  layer: string
  result: string
  corrections: boolean
  minutes: string
  notes: string
}

/** The form as one comparable value. Notes and minutes compare trimmed: the
 *  save trims them, and a reload must not read as a change. */
export function formKey(f: InspectionForm): string {
  return JSON.stringify([f.layer ?? '', f.result ?? '', !!f.corrections, String(f.minutes ?? '').trim(), String(f.notes ?? '').trim()])
}

/** The clean's statuses while the crew are still on it. */
export const OPEN_CLEAN_STATUSES = ['scheduled', 'en_route', 'in_progress'] as const

/** Is the inspection's clean still being cleaned (or about to be)? */
export function cleanStillOpen(status: unknown): boolean {
  return typeof status === 'string' && (OPEN_CLEAN_STATUSES as readonly string[]).includes(status)
}

/** Which banner, if any, tops the inspection. */
export type OpenCleanBanner = 'hold' | 'wait' | null

export function openCleanBanner(o: { done: boolean; cleanStatus: unknown; mode: FilingMode | null | undefined }): OpenCleanBanner {
  if (o.done || !cleanStillOpen(o.cleanStatus)) return null
  return o.mode === 'hold' || o.mode === 'wait' ? o.mode : null
}

/** Back pressed: leave at once, or ask first. */
export function leaveDecision(o: { done: boolean; formChanged: boolean; walkTouched: boolean }): 'leave' | 'ask' {
  if (o.done) return 'leave'
  return o.formChanged || o.walkTouched ? 'ask' : 'leave'
}

/** Has the form changed since `baseline` (formKey at load or at the last save)?
 *  No baseline (no record loaded): nothing to lose. */
export function formChanged(baseline: string | null | undefined, now: InspectionForm): boolean {
  return typeof baseline === 'string' && formKey(now) !== baseline
}

/** The ask's buttons, in order: Stay (the safe one), Save progress (when the
 *  form can save right now), Leave. */
export type LeaveChoice = 'stay' | 'save' | 'leave'
export function leaveChoices(o: { canSave: boolean }): LeaveChoice[] {
  return o.canSave ? ['stay', 'save', 'leave'] : ['stay', 'leave']
}
