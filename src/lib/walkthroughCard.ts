// The inspection walkthrough card (WalkthroughChecklist): what it reads, and
// how soon the saved copy shows. Shown on an inspection visit and on a clean
// booked as the inspection service.
//
// It reads in one round (the lines, their photos, the property's trash days),
// but on a link that swallows requests (CKS Perfections, 2026-10-15, one bar)
// that round waited out the 15 s read deadline behind a spinner before the
// saved copy showed, and nothing cleared the spinner if the load threw.
//
// So now, as the cleaning checklist does (lib/checklistCard):
// - The first load (`soon`) waits at most WALKTHROUGH_WAIT.ms for the live
//   answer, and not at all when the phone's last request already failed; then
//   the saved copy shows (dataCache readSoon). Answers queued offline overlay
//   it, as before. The live answer, when it comes, refreshes the card, unless
//   the inspector has answered something since the load began: the live
//   answer may predate it.
// - A reload (back from the photo screen) waits for the live answer, and never
//   steps back to the saved copy once the card shows something: the saved
//   copy predates answers that went through live.
// - The spinner goes in a finally, and a throw is reported.
//
// The reads are the shared builders in lib/jobReads, the ones the day pack
// saves (scripts/test-offline-day-pack.mjs checks this file too). Since
// 2026-10-20 that includes the lines missed at earlier inspections of the home
// (carriedLinesRead), shown above the sections.
import { readSoon, type SoonRead, type CacheRead } from './dataCache'
import { walkthroughLinesRead, walkthroughPhotosRead, trashDaysRead, carriedLinesRead, jobAddressId } from './jobReads'
import { overlayPending } from './outbox'
import { queuedJobPhotos } from './photoQueue'
import { lastTripFailed } from './netFetch'
import { reportClientError } from './errorReporter'
import type { WalkthroughLine } from './walkthrough'
import { carriedFromRpc, type CarriedLine } from './carriedLines'
import { savedCarriedPhotos } from './carriedPhotoFiles'

/** How long the first load's reads wait for the live answer. */
export const WALKTHROUGH_WAIT = { ms: 3_000 }

export interface WalkthroughView {
  lines: WalkthroughLine[]
  /** Photos per line, those still on the phone included. */
  photoCount: Record<string, number>
  pickupDays: number[] | null
  /** Lines missed at an earlier inspection of this home and not OK since
   *  (lib/carriedLines), with this visit's own row for each. */
  carried: CarriedLine[]
  /** Their photo url → the file the day pack saved, when there is one. */
  carriedFiles: Record<string, string>
}

const list = (x: any): any[] => (Array.isArray(x) ? x : [])
const NONE: SoonRead = { data: null, error: null, fromCache: false, late: null }

/** The lines missed last time never hold the card up: with nothing saved on
 *  the phone (a stop the pack never reached, a database without the rpc) the
 *  sections show without them, and they join when the live answer comes. */
async function carriedSoon(read: CacheRead, wait: number): Promise<SoonRead> {
  const r = readSoon(read, wait)
  // A reload waits for the live answer anyway, like every other read here.
  if (wait === Infinity) return r
  let timer: any
  const inTime = await Promise.race([r, new Promise<null>(res => { timer = setTimeout(() => res(null), wait + 250) })])
  clearTimeout(timer)
  if (inTime) return inTime
  return { data: null, error: null, fromCache: false, late: r.then(x => x.late ?? x) }
}

async function viewOf(job: any, [lines, photos, addr, carry]: { data: any; error?: any }[]): Promise<WalkthroughView> {
  // Answers queued offline overlay the rows (already scoped to this job).
  const rows = (await overlayPending('job_checklist_items', list(lines.data), v => v.job_id === job.id)) as WalkthroughLine[]
  const counts: Record<string, number> = {}
  for (const p of list(photos.data)) counts[p.checklist_item_id] = (counts[p.checklist_item_id] || 0) + 1
  // Photos still on the device count too: the photo screen captions a line's
  // photo with the line's text.
  try {
    const queued = await queuedJobPhotos(job.id)
    for (const q of queued) {
      const l = rows.find(r => r.task === q.caption)
      if (l) counts[l.id] = (counts[l.id] || 0) + 1
    }
  } catch {}
  // Before the web migration is applied the rpc doesn't exist: nothing carried.
  const carried = carry && !carry.error ? carriedFromRpc(carry.data) : []
  let carriedFiles: Record<string, string> = {}
  try { carriedFiles = await savedCarriedPhotos(carried.flatMap(l => l.photo_urls)) } catch {}
  return { lines: rows, photoCount: counts, pickupDays: (addr.data?.trash_pickup_days ?? null) as number[] | null, carried, carriedFiles }
}

/** Read the card. `saved`: the first answer holds at least one saved copy.
 *  `fresh` resolves to a newer view once late live answers are in, or to null. */
export async function readWalkthrough(job: any, wait: number):
  Promise<{ first: WalkthroughView; saved: boolean; fresh: Promise<WalkthroughView | null> }> {
  const addrId = jobAddressId(job)
  const reads = await Promise.all([
    readSoon(walkthroughLinesRead(job.id), wait),
    readSoon(walkthroughPhotosRead(job.id), wait),
    addrId ? readSoon(trashDaysRead(addrId), wait) : NONE,
    addrId ? carriedSoon(carriedLinesRead(job.id), wait) : NONE,
  ])
  const first = await viewOf(job, reads)
  const fresh = reads.some(r => r.late)
    ? (async () => {
        try {
          const settled = await Promise.all(reads.map(r => r.late ?? r))
          if (!reads.some((r, i) => r.late && !settled[i].fromCache)) return null
          return await viewOf(job, settled)
        } catch { return null }
      })()
    : Promise.resolve(null)
  return { first, saved: reads.some(r => r.fromCache), fresh }
}

/**
 * The card's loads. `show` puts a view on screen; `setLoading(false)` takes
 * the card's first spinner down. The newest load wins; one that began before
 * the inspector's last answer (edited()) doesn't overwrite what they see.
 */
export function walkthroughCard(ui: { show: (v: WalkthroughView) => void; setLoading: (on: boolean) => void }) {
  let loads = 0
  let edits = 0
  let shown = false
  const show = (v: WalkthroughView) => { shown = true; ui.show(v) }
  return {
    /** The inspector answered a line or a section, or wrote a note. */
    edited() { edits++ },
    /** `soon`: the card's first load. */
    async load(job: any, opts: { soon?: boolean } = {}): Promise<void> {
      const seq = ++loads
      const editsAtStart = edits
      const current = () => seq === loads && edits === editsAtStart
      try {
        const wait = opts.soon ? (lastTripFailed() ? 0 : WALKTHROUGH_WAIT.ms) : Infinity
        const { first, saved, fresh } = await readWalkthrough(job, wait)
        if (!current()) return
        if (!(shown && saved)) show(first)
        ui.setLoading(false)
        const later = await fresh
        if (later && current()) show(later)
      } catch (e: any) {
        reportClientError(`walkthrough card: ${e?.message || e}`, e?.stack, 'walkthrough')
      } finally {
        if (seq === loads) ui.setLoading(false)
      }
    },
  }
}
