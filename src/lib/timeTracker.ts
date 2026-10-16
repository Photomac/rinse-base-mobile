// The time tracker on a stop's screen (JobDetailScreen): the viewer's own
// punches on the clean, or the whole job's for desk staff on a clean they
// aren't crew on. They drive the timer and Clock in / Pause / Resume / Complete.
//
// CKS Perfections, 2026-10-15, one bar and no data: the tracker read its
// entries with one cachedRead(), which on a link that swallows requests waits
// out the 15 s read deadline before falling back to the saved copy. Until
// then the card offered Clock in on a clean she was already clocked into.
// The rest of the stop's screen had the same wait (lib/checklistCard,
// lib/stopDetails, lib/checkFirstCard).
//
// So now:
// - The screen-opening load (`soon`), and the first load of the whole job's
//   clock once the screen widens to it, wait at most TIME_TRACKER_WAIT.ms for
//   the live answer, and not at all when the phone's last request already
//   failed; then the saved copy shows (dataCache readSoon). The live answer,
//   when it comes, replaces it. Every other load (after a punch) waits for
//   the live answer.
// - A saved copy never takes anything off the screen: it is merged into what
//   is there (mergeEntries). An entry on screen stays, and an entry closed in
//   either copy stays closed: an entry only ever goes from running to closed
//   (Resume starts a new one). So a copy from before a punch can neither hide
//   a running entry nor show a paused one running again.
// - A live answer replaces the screen only when its load began after this
//   screen's last punch. An older one may predate the punch, so it is merged
//   the same way, and (dataCache saves every live answer as it comes) the
//   merged list is written back as the saved copy, or the punch would be
//   missing there.
// - Every punch made here (punched()) shows at once and is written into the
//   phone's saved copies (savePunch()), whether it landed or queued. So a
//   screen opened later on a dead link shows it, even once the outbox has
//   delivered it and no longer lays it over the copy. The arrival auto
//   clock-in (a background task, lib/arrivalGeofence) saves its entry the
//   same way.
//
// Punches still queued in the outbox overlay every answer, as before.
//
// The read is the shared builder in lib/jobReads, the one the day pack saves
// (scripts/test-offline-day-pack.mjs checks this file too).
import { readSoon, readCacheEntry, writeCacheEntry, cacheEpoch, type SoonRead } from './dataCache'
import { timeEntriesRead } from './jobReads'
import { overlayPending } from './outbox'
import { lastTripFailed } from './netFetch'

/** How long the screen-opening load waits for the live answer. */
export const TIME_TRACKER_WAIT = { ms: 3_000 }

const list = (x: any): any[] => (Array.isArray(x) ? x : [])
const oldestFirst = (a: any, b: any) => String(a.clocked_in_at).localeCompare(String(b.clocked_in_at))

/**
 * `base` with `over` laid on it, by id: every entry in either, `over`'s copy
 * of one in both, except that a closed copy beats a running one. Oldest first.
 */
export function mergeEntries(base: any[], over: any[]): any[] {
  const byId = new Map<string, any>()
  for (const e of [...base, ...over]) {
    const had = byId.get(e.id)
    byId.set(e.id, had?.clocked_out_at && !e.clocked_out_at ? { ...e, ...had } : { ...had, ...e })
  }
  return [...byId.values()].sort(oldestFirst)
}

/**
 * A punch written into this phone's saved copies of the clean's clock: the
 * viewer's own (when the punch is theirs), and the whole job's (when the phone
 * has one, or the punch is somebody else's, which only desk staff record).
 * Never throws.
 */
export async function savePunch(row: any, viewerId: string): Promise<void> {
  if (!row?.id || !row.job_id) return
  const since = cacheEpoch()
  const own = row.user_id === viewerId
  const copies = [
    ...(own ? [{ key: timeEntriesRead(row.job_id, viewerId, false).key, always: true }] : []),
    { key: timeEntriesRead(row.job_id, viewerId, true).key, always: !own },
  ]
  for (const { key, always } of copies) {
    const saved = await readCacheEntry(key)
    if (!Array.isArray(saved) && !always) continue
    await writeCacheEntry(key, mergeEntries(list(saved), [row]), since)
  }
}

/** The tracker's loads, and the punches made on its screen. `show` puts the
 *  entries on screen, oldest first. */
export function timeTracker(ui: { show: (rows: any[]) => void }) {
  let loads = 0
  let punches = 0
  // What is on screen, and whether it is the whole job's clock (null: nothing yet).
  let rows: any[] = []
  let shownWhole: boolean | null = null
  const put = (next: any[], whole: boolean) => { rows = next; shownWhole = whole; ui.show(next) }
  return {
    /** A punch made on this screen (clock-in, pause, resume, clock-out), landed
     *  or queued. Resolves once it is in the saved copies. */
    punched(row: any, user: any): Promise<void> {
      punches++
      put(mergeEntries(rows, [row]), shownWhole ?? false)
      return savePunch(row, user.id)
    },
    /** `wholeJob`: desk staff on a clean they aren't crew on. Resolves once the
     *  final answer is in. */
    async load(job: any, user: any, wholeJob: boolean, opts: { soon?: boolean } = {}): Promise<void> {
      const seq = ++loads
      const punchesAtStart = punches
      const since = cacheEpoch()
      const key = timeEntriesRead(job.id, user.id, wholeJob).key
      const inScope = (e: any) => wholeJob || e.user_id === user.id
      // The screen opening, or this clock shown for the first time.
      const soon = opts.soon || shownWhole !== wholeJob
      const wait = soon ? (lastTripFailed() ? 0 : TIME_TRACKER_WAIT.ms) : Infinity
      const take = async (res: SoonRead) => {
        const got = await overlayPending('job_time_entries', list(res.data), v => v.job_id === job.id && inScope(v))
        const live = !res.fromCache && !res.error
        if (live && punches !== punchesAtStart) await writeCacheEntry(key, mergeEntries(got, rows.filter(inScope)), since)
        if (seq !== loads) return
        put(live && punches === punchesAtStart ? got.sort(oldestFirst) : mergeEntries(got, rows.filter(inScope)), wholeJob)
      }
      const first = await readSoon(timeEntriesRead(job.id, user.id, wholeJob), wait)
      await take(first)
      const late = await first.late
      if (late && !late.fromCache && !late.error) await take({ ...late, late: null })
    },
  }
}
