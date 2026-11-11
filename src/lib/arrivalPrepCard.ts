// The "From the arrival prep" card on a turnover (ArrivalPrepCard): what it
// reads, and how soon the saved copy shows. Rules: lib/arrivalPrep.ts.
//
// One read (arrivalPrepRead, the builder the day pack saves): the link, the
// arrival, who was on it, its photos and its video ids together, so the card
// never waits on a second round. Like the other cards on a weak signal
// (lib/carriedLinesCard): the first load waits at most ARRIVAL_WAIT.ms for
// the live answer, and not at all when the phone's last request already
// failed; then the saved copy shows, and the live answer replaces it when it
// comes. The photo files are not saved on the phone (only the rows are), so
// with no signal a thumbnail shows its empty square (components/ShotThumb).
import { readSoon } from './dataCache'
import { arrivalPrepRead } from './jobReads'
import { arrivalFromRows, type ArrivalPrepView } from './arrivalPrep'
import { lastTripFailed } from './netFetch'
import { reportClientError } from './errorReporter'

export const ARRIVAL_WAIT = { ms: 3_000 }

/** The card's load: `show` gets the first view (null: nothing linked) and
 *  then a newer one, if the live answer comes after the saved copy. */
export async function loadArrivalPrep(job: any, show: (v: ArrivalPrepView | null) => void): Promise<void> {
  try {
    const r = await readSoon(arrivalPrepRead(job.id), lastTripFailed() ? 0 : ARRIVAL_WAIT.ms)
    if (!r.error) show(arrivalFromRows(r.data))
    if (r.late) {
      const late = await r.late
      if (!late.fromCache && !late.error) show(arrivalFromRows(late.data))
    }
  } catch (e: any) {
    reportClientError(`arrival prep card: ${e?.message || e}`, e?.stack, 'arrival_prep')
  }
}
