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

// A photo of each thing tapped (Catherine, 2026-10-23: "one photo of the oven
// for an oven tap, the grill for a grill tap. The photo is the review."). Each
// tapped item, and Other, is a slot; the request can't be saved until every
// slot has a photo. Each photo is queued with its slot's English label, which
// the server stores with it (job_damage_reports.photo_labels), so the office
// sees which photo is of what. labelKey shows the slot in the crew's language.
// LOCKSTEP with the web's deepCleanSlots / deepCleanSlotsFromTitle /
// deepCleanMissing (the test compares them).

export type DeepCleanSlot = { key: string; label: string; labelKey?: string }

const OTHER_KEY = 'other'

/** The photo slots for what is tapped: the regulars in list order, then
 *  Other (labelled with its words, or "Other" while it has none). */
export function deepCleanSlots(picked: readonly string[], otherOn: boolean, other?: string | null): DeepCleanSlot[] {
  const slots: DeepCleanSlot[] = DEEP_CLEAN_ITEMS.filter(i => picked.includes(i.id)).map(i => ({ key: i.id, label: i.label, labelKey: i.labelKey }))
  if (otherOn) slots.push({ key: OTHER_KEY, label: words(other) || 'Other' })
  return slots
}

/** Every slot has at least one photo (and there is a slot). */
export function deepCleanPhotosReady(slots: readonly DeepCleanSlot[], photos: Readonly<Record<string, readonly unknown[] | undefined>>): boolean {
  return slots.length > 0 && slots.every(s => (photos[s.key]?.length ?? 0) > 0)
}

/** The slots a filed request names, read back from its title: "Deep clean:
 *  Oven, Ceiling fans, porch lights" is Oven, Ceiling fans, then "porch
 *  lights" as Other. A title the tap-list didn't write (the walkthrough's
 *  "Deep clean needed: …", or any other report) is one slot. */
export function deepCleanSlotsFromTitle(title: string | null | undefined): DeepCleanSlot[] {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  const prefix = 'Deep clean: '
  if (!t.startsWith(prefix)) {
    const rest = t.replace(/^Deep clean needed:\s*/i, '')
    return rest ? [{ key: OTHER_KEY, label: rest }] : []
  }
  let rest = t.slice(prefix.length)
  const slots: DeepCleanSlot[] = []
  for (const i of DEEP_CLEAN_ITEMS) {
    if (rest === i.label) { slots.push({ key: i.id, label: i.label, labelKey: i.labelKey }); rest = ''; break }
    if (rest.startsWith(`${i.label}, `)) { slots.push({ key: i.id, label: i.label, labelKey: i.labelKey }); rest = rest.slice(i.label.length + 2) }
  }
  if (rest.trim()) slots.push({ key: OTHER_KEY, label: rest.trim() })
  return slots
}

/** The slots no labelled photo covers. */
export function deepCleanMissing(slots: readonly DeepCleanSlot[], photoLabels: Readonly<Record<string, string>> | null | undefined): DeepCleanSlot[] {
  const have = new Set(Object.values(photoLabels ?? {}))
  return slots.filter(s => !have.has(s.label))
}
