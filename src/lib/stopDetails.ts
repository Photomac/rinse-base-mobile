// A stop's details on its screen (JobDetailScreen): the job's own extras, who
// is on it, and the property's notes. What they read, and how soon they show.
//
// CKS Perfections, 2026-10-15, job #1612, one bar and no data: the screen read
// these one after another (the job's extras, then the crew, then the property)
// and on a link that swallows requests each read waited out the 15 s read
// deadline before falling back to the saved copy. The arrival instructions,
// crew notes, bag colour, staging photos and beds/baths came ~45 s after the
// screen opened, the crew line ~30 s. The door code looked fine only because
// the screen shows the Home row's until the property's own read is in. The
// checklist card had the same wait (lib/checklistCard.ts).
//
// So now:
// - The three reads start at once, and each shows as soon as it is in.
// - A read with a saved copy waits at most STOP_DETAILS_WAIT.ms for the live
//   answer, and not at all when the phone's last request already failed; then
//   the saved copy shows (dataCache readSoon). The live answer, when it comes,
//   replaces it.
// - The laundry-on-site and pet-fee flags are the crew's to change on this
//   screen: an answer from a load that began before they changed one leaves
//   both alone.
// - Who is on the clean decides whether Clock in is offered (lib/jobScope
//   notAssignedHere, which trusts a live roster and a saved one only when the
//   job's own assignments agree). The roster is handed over only once it is
//   final: the live answer, or the saved copy once the live read has failed,
//   the same moment as before. A saved copy that shows sooner goes to the
//   crew line only, so it can't take Clock in away while the live answer is
//   on its way.
//
// The reads are the shared builders in lib/jobReads, the ones the day pack
// saves (scripts/test-offline-day-pack.mjs checks this file too).
import { readSoon } from './dataCache'
import { jobMetaRead, jobCrewRead, propMetaRead, jobAddressId } from './jobReads'
import { lastTripFailed } from './netFetch'
import type { Roster } from './jobScope'

/** How long a read with a saved copy waits for the live answer. */
export const STOP_DETAILS_WAIT = { ms: 3_000 }

export interface StopDetailsUi {
  /** The job's extras: smart-lock code, turnover times, client type, the
   *  booking's guests and pets. `flags`: its laundry-on-site and pet-fee flags
   *  may go on screen too (the crew hasn't changed either since the load began). */
  job: (row: any, flags: boolean) => void
  /** Everyone on the clean, lead first (the crew read's rows). */
  crew: (rows: any[]) => void
  /** Who the server lists on the clean, once final (see above). */
  roster: (r: Roster) => void
  /** The property: size, crew notes, door code, arrival instructions, bag
   *  colour, staging photos, pets. */
  property: (row: any) => void
}

const list = (x: any): any[] => (Array.isArray(x) ? x : [])

/** The screen's loads of its details. */
export function stopDetails(ui: StopDetailsUi) {
  let flagEdits = 0
  return {
    /** The crew changed the laundry-on-site or pet-fee flag on this screen. */
    flagEdited() { flagEdits++ },
    /** Every read at once. Resolves once each has its final answer. */
    async load(job: any): Promise<void> {
      const editsAtStart = flagEdits
      const flags = () => flagEdits === editsAtStart
      const wait = lastTripFailed() ? 0 : STOP_DETAILS_WAIT.ms
      const addrId = jobAddressId(job)
      await Promise.all([
        readSoon(jobMetaRead(job.id), wait).then(async r => {
          if (r.data) ui.job(r.data, flags())
          const late = await r.late
          if (late && !late.fromCache && late.data) ui.job(late.data, flags())
        }),
        readSoon(jobCrewRead(job.id), wait).then(async r => {
          if (r.late) ui.crew(list(r.data))
          const fin = r.late ? await r.late : r
          // As the screen always took cachedRead()'s answer: no rows (a server
          // refusal) is an empty crew and no roster.
          ui.crew(list(fin.data))
          if (fin.data) ui.roster({ ids: list(fin.data).map(a => a.user_id ?? a.users?.id).filter(Boolean), live: !fin.fromCache })
        }),
        addrId ? readSoon(propMetaRead(addrId), wait).then(async r => {
          if (r.data) ui.property(r.data)
          const late = await r.late
          if (late && !late.fromCache && late.data) ui.property(late.data)
        }) : null,
      ])
    },
  }
}
