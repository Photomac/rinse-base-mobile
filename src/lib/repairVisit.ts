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

// "Send for review" (rinse-base-app migration 20261031140206_repair_review_quote):
// a look-and-quote visit starts its notes with 🔍, so the job screen knows it
// offline too and doesn't offer "I need to come back". Its price and note go
// through RepairQuoteCard. A copy lives in the web app (incidentRepair.ts).
export const isLookAndQuoteNotes = (notes: string | null | undefined) => /^🔍/.test(String(notes || '').trimStart())

/** A typed price: a number with at most two decimals, or null. */
export function parseQuoteAmount(raw: string): number | null {
  const t = String(raw || '').replace(/[$€£,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) && n < 10000000 ? n : null
}

// The block the web's repairVisitNotes writes into the visit's notes: this
// header, then one link per line. A copy lives there (incidentRepair.ts):
// change both.
const PHOTO_HEADER = /^Incident photos \(\d+\):$/
const isLink = (line: string) => /^https?:\/\/\S+$/.test(line.trim())

/** The notes as the crew reads them: everything but the block of photo links. */
export function notesWithoutPhotoLinks(notes: string | null | undefined): string {
  const kept: string[] = []
  let inBlock = false
  for (const line of String(notes || '').split('\n')) {
    if (PHOTO_HEADER.test(line.trim())) { inBlock = true; continue }
    if (inBlock && isLink(line)) continue
    inBlock = false
    kept.push(line)
  }
  return kept.join('\n')
}

/** The links in that block: what to show until the incident has loaded, or offline. */
export function photoLinksInNotes(notes: string | null | undefined): string[] {
  const links: string[] = []
  let inBlock = false
  for (const line of String(notes || '').split('\n')) {
    if (PHOTO_HEADER.test(line.trim())) { inBlock = true; continue }
    if (inBlock && isLink(line)) links.push(line.trim())
    else inBlock = false
  }
  return links
}

/**
 * A small copy of a public storage photo, from Storage's image endpoint: a
 * phone photo is 2 MB and more, and a tech on one bar loads several at once.
 * Any other link is returned as it is.
 */
export function photoThumb(url: string, px: number): string {
  if (!url.includes('/storage/v1/object/public/')) return url
  return url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')
    + `${url.includes('?') ? '&' : '?'}width=${px * 3}&height=${px * 3}&resize=cover`
}
