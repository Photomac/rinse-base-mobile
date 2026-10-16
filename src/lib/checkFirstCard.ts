// The Check first card on a stop's screen (JobDetailScreen): what it reads,
// and how soon the saved copy shows. The rules are in lib/checkFirst.ts.
//
// The card read in two rounds: the property's lines and the company's switch,
// then (only where there are lines) the clean's ticks, line photos and start.
// On a link that swallows requests each round waited out the 15 s read
// deadline before falling back to the saved copy, so the card came ~30 s
// after the screen opened (CKS Perfections, 2026-10-15, job #1612, one bar),
// and a Start tapped before then went ahead without the Check first window.
//
// So now, on opening the screen (`soon`):
// - The clean's reads go out with the lines wherever the phone's saved copy
//   says the property has some; elsewhere only once the lines say so. Most
//   properties have none, and on a weak link every extra request slows the
//   rest.
// - A read with a saved copy waits at most CHECK_FIRST_WAIT.ms for the live
//   answer, and not at all when the phone's last request already failed; then
//   the saved copy shows (dataCache readSoon).
// - The live answer, when it comes, refreshes the card, unless the crew has
//   ticked or photographed a line since the load began: the answer may
//   predate it.
// Every other load (after a tick, when a photo lands, at Complete) waits for
// the live answer, as before: the saved copy predates a tick that went
// through live, and would take it off the card and out of Complete's check.
//
// Every read fails soft: no answer shows no card and blocks nothing. Ticks
// queued offline overlay the copy, and a line photo still on the phone counts
// as taken (the gate asks for its row separately once it lands).
//
// The reads are the shared builders in lib/jobReads, the ones the day pack
// saves (scripts/test-offline-day-pack.mjs checks this file too).
import { readSoon, readCacheEntry, type SoonRead } from './dataCache'
import {
  checkFirstLinesRead, checkFirstTenantRead, checkFirstTicksRead, checkFirstPhotosRead, checkFirstStartRead,
  jobAddressId,
} from './jobReads'
import { activeLines, type CheckFirstLine, type CheckFirstTick } from './checkFirst'
import { overlayPending } from './outbox'
import { queuedJobPhotos, type QueuedJobPhoto } from './photoQueue'
import { lastTripFailed } from './netFetch'
import type { CheckFirstView } from '../components/CheckFirst'

/** How long a read with a saved copy waits for the live answer. */
export const CHECK_FIRST_WAIT = { ms: 3_000 }

// readSoon() then waits for the live answer (or cachedRead()'s fallback), as
// the loads after a tick must.
const LIVE = Infinity

const list = (x: any): any[] => (Array.isArray(x) ? x : [])

type Clean = [SoonRead, SoonRead, SoonRead]

/** The card for these lines, from the clean's ticks, line photos and start. */
async function viewOf(job: any, lines: CheckFirstLine[], ten: any, [tickRes, photoRes, startRes]: { data: any }[]): Promise<CheckFirstView> {
  const queued = await queuedJobPhotos(job.id).catch((): QueuedJobPhoto[] => [])
  const ticks = (await overlayPending('job_check_first_ticks', list(tickRes.data),
    v => v.job_id === job.id)) as CheckFirstTick[]
  const photos: Record<string, string> = {}
  for (const p of list(photoRes.data)) if (p.check_first_line_id && !photos[p.check_first_line_id]) photos[p.check_first_line_id] = p.photo_url
  const saving: string[] = []
  for (const q of queued) {
    if (!q.check_first_line_id) continue
    saving.push(q.check_first_line_id)
    if (!photos[q.check_first_line_id]) photos[q.check_first_line_id] = q.localUri
  }
  return {
    lines, ticks, photos, saving,
    required: ten?.check_first_required === true,
    jobStartedAt: startRes.data?.started_at ?? null,
  }
}

/**
 * Read the card for `job` (a clean at a property). `first` is null when the
 * property has no lines. `fresh` resolves to the card once late live answers
 * are in (`view` null: no lines now), or to null when nothing newer came.
 */
export async function readCheckFirst(job: any, user: any, opts: { soon?: boolean } = {}):
  Promise<{ first: CheckFirstView | null; fresh: Promise<{ view: CheckFirstView | null } | null> }> {
  const addrId = jobAddressId(job)
  if (!addrId) return { first: null, fresh: Promise.resolve(null) }
  const waitNow = () => (opts.soon ? (lastTripFailed() ? 0 : CHECK_FIRST_WAIT.ms) : LIVE)
  const wait = waitNow()
  const clean = (w: number) => Promise.all([
    readSoon(checkFirstTicksRead(job.id), w),
    readSoon(checkFirstPhotosRead(job.id), w),
    readSoon(checkFirstStartRead(job.id), w),
  ]) as Promise<Clean>
  const linesP = readSoon(checkFirstLinesRead(addrId), wait)
  const tenP = readSoon(checkFirstTenantRead(user.tenant_id), wait)
  const saved = await readCacheEntry(checkFirstLinesRead(addrId).key)
  let cleanP: Promise<Clean> | null = activeLines(list(saved)).length ? clean(wait) : null
  const [linesR, tenR] = await Promise.all([linesP, tenP])

  const lines = activeLines(list(linesR.data) as CheckFirstLine[])
  // Asked again: by now the lines' round may have failed.
  if (lines.length) cleanP ??= clean(waitNow())
  const cleanR = lines.length ? await cleanP! : null
  const first = cleanR ? await viewOf(job, lines, tenR.data, cleanR) : null

  const reads = [linesR, tenR, ...(cleanR ?? [])]
  if (!reads.some(r => r.late)) return { first, fresh: Promise.resolve(null) }
  const fresh = (async () => {
    try {
      const settled = await Promise.all(reads.map(r => r.late ?? r))
      if (!reads.some((r, i) => r.late && !settled[i].fromCache)) return null
      const [L, Tn, ...C] = settled
      const nowLines = activeLines(list(L.data) as CheckFirstLine[])
      if (!nowLines.length) return { view: null }
      // The lines came late, and the clean's reads were never sent: send them now.
      const c = C.length ? C : await clean(LIVE)
      return { view: await viewOf(job, nowLines, Tn.data, c) }
    } catch { return null }
  })()
  return { first, fresh }
}

/**
 * The card's loads. `show` puts the card on screen (null: no card). The newest
 * load wins; one that began before the crew's last tick or line photo
 * (edited()) doesn't overwrite what they see.
 */
export function checkFirstCard(ui: { show: (v: CheckFirstView | null) => void }) {
  let loads = 0
  let edits = 0
  return {
    /** The crew ticked or photographed a line. */
    edited() { edits++ },
    /** Resolves to the first answer (what Complete checks), shown or not. */
    async load(job: any, user: any, opts: { soon?: boolean } = {}): Promise<CheckFirstView | null> {
      const seq = ++loads
      const editsAtStart = edits
      const current = () => seq === loads && edits === editsAtStart
      const { first, fresh } = await readCheckFirst(job, user, opts)
      if (current()) ui.show(first)
      fresh.then(later => { if (later && current()) ui.show(later.view) }).catch(() => {})
      return first
    },
  }
}
