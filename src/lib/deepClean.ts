// "Needs a deep clean" (CKS Perfections, 2026-10-22): a report type in Report
// an issue, for cleaners and inspectors, when a home needs more than a
// turnover: cobwebs everywhere, dirty fans, an oven or grill past a normal
// wipe-down. The office reviews it like every incident and sends it to the
// host as a deep-clean proposal (web Issues page).
//
// The crew tap what needs it, plus Other in a few words. The chips show
// t(labelKey); the report's title lists the English labels ("Deep clean:
// Oven, Ceiling fans, porch lights") so the office and the host read one
// vocabulary whatever language the crew works in (the linen title does the
// same).
//
// Pure (no React, no Supabase) so scripts/test-deep-clean.mjs runs it.
// LOCKSTEP: rinsebase-app src/lib/deepClean.ts carries the same ids, labels
// and title rule; the test compares the two when that repo is on the machine.

export const DEEP_CLEAN_ITEMS = [
  { id: 'oven',        label: 'Oven',            labelKey: 'ir_deep_oven' },
  { id: 'grill',       label: 'Grill',           labelKey: 'ir_deep_grill' },
  { id: 'cobwebs_in',  label: 'Cobwebs inside',  labelKey: 'ir_deep_cobwebs_in' },
  { id: 'cobwebs_out', label: 'Cobwebs outside', labelKey: 'ir_deep_cobwebs_out' },
  { id: 'blinds',      label: 'Blinds',          labelKey: 'ir_deep_blinds' },
  { id: 'fans',        label: 'Ceiling fans',    labelKey: 'ir_deep_fans' },
] as const

/** Other's words, at most this long: they go into the title. */
export const DEEP_CLEAN_OTHER_MAX = 80

export const isDeepClean = (reportType: string | null | undefined) => reportType === 'deep_clean'

const words = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, DEEP_CLEAN_OTHER_MAX).trim()

/** The report's title: the picked items in list order, then Other's words.
 *  '' while nothing is picked. */
export function deepCleanTitle(picked: readonly string[], other?: string | null): string {
  const parts: string[] = DEEP_CLEAN_ITEMS.filter(i => picked.includes(i.id)).map(i => i.label)
  const extra = words(other)
  if (extra) parts.push(extra)
  return parts.length ? `Deep clean: ${parts.join(', ')}` : ''
}

/** Ready to save: something picked, and Other, when ticked, says what. */
export function deepCleanReady(picked: readonly string[], otherOn: boolean, other?: string | null): boolean {
  if (otherOn && !words(other)) return false
  return otherOn || DEEP_CLEAN_ITEMS.some(i => picked.includes(i.id))
}
