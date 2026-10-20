// The "Missed at the last inspection" card on a clean (CarriedLinesCard): what
// it reads, and how soon the saved copy shows. Rules: lib/carriedLines.ts.
//
// One read (carriedLinesRead, the builder the day pack saves). Like the other
// cards on a weak signal (lib/checklistCard): the first load waits at most
// CARRIED_WAIT.ms for the live answer, and not at all when the phone's last
// request already failed; then the saved copy shows, and the live answer
// replaces it when it comes. Photos show from the files the day pack saved
// when there are any (lib/carriedPhotoFiles), else from the network.
import { readSoon } from './dataCache'
import { carriedLinesRead } from './jobReads'
import { carriedFromRpc, type CarriedLine } from './carriedLines'
import { savedCarriedPhotos } from './carriedPhotoFiles'
import { lastTripFailed } from './netFetch'
import { reportClientError } from './errorReporter'

export const CARRIED_WAIT = { ms: 3_000 }

export interface CarriedView {
  lines: CarriedLine[]
  /** Photo url → the file saved on this phone, when there is one. */
  files: Record<string, string>
}

async function viewOf(data: unknown): Promise<CarriedView> {
  const lines = carriedFromRpc(data)
  let files: Record<string, string> = {}
  try { files = await savedCarriedPhotos(lines.flatMap(l => l.photo_urls)) } catch { /* the network copy shows */ }
  return { lines, files }
}

/** The card's load: `show` gets the first view and then a newer one, if the
 *  live answer comes after the saved copy. */
export async function loadCarried(job: any, show: (v: CarriedView) => void): Promise<void> {
  try {
    const r = await readSoon(carriedLinesRead(job.id), lastTripFailed() ? 0 : CARRIED_WAIT.ms)
    show(await viewOf(r.data))
    if (r.late) {
      const late = await r.late
      if (!late.fromCache && !late.error) show(await viewOf(late.data))
    }
  } catch (e: any) {
    reportClientError(`carried lines card: ${e?.message || e}`, e?.stack, 'walkthrough')
  }
}
