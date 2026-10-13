// Keeps the offline read cache (lib/dataCache) from growing for ever.
//
// Every stop opened on the phone, and every stop the offline day pack saves,
// leaves ~15-25 cached reads keyed by the job (checklist rows, punches, crew,
// next arrival, supplies log...) and a handful keyed by the property (door
// code, checklist template, rooms, supplies). Nothing ever removed them.
// Measured on prod 2026-10-13: a CKS stop holds ~9 KB, a Rhyne stop ~38 KB
// (its checklist rows alone average 32 KB), and a busy CKS cleaner works 131
// stops a month. Android's AsyncStorage refuses writes past 6 MB, and the
// write outbox, the photo queue and the sign-in live in the same database: a
// full cache would stop clock-ins and photos from being saved.
//
// A stop's keys are dropped only when ALL of these hold:
// - its day is more than KEEP_DAYS behind today (company zone), or unknown;
// - nobody opened it on this phone, and the day pack didn't save it, for
//   KEEP_DAYS;
// - it is not one of the stops the day pack just saved (today / tomorrow);
// - it is not in Needs closing (in progress or en route from an earlier day);
// - no photo, video or crew-note "Got it" for it is waiting to send.
// Nothing at all is dropped while the write outbox holds anything (an op often
// names only a checklist row or a time entry, not its job), or before Home has
// saved its Needs closing list (without it an old open stop can't be told from
// a finished one).
//
// A property's keys go once no stop still kept is there, and not at all while
// a kept stop's property is unknown.
//
// Which job or property a key belongs to: jobReads.cacheKeyOwner(). When a
// stop is for and when it was last opened: an index (dataCache:cachedJobs)
// written by the stop's screen and the day pack (noteCachedJobs). A stop found
// with keys and no entry (saved before this existed) gets KEEP_DAYS of grace
// from then. Everything else in the cache — Home, Schedule, company settings,
// the prep card's day keys, the crew-note retry list — is never touched here.
import { cacheEpoch, dataCacheKeys, pruneDataCache, readCacheEntry, writeCacheEntry } from './dataCache'
import { cacheKeyOwner, jobAddressId } from './jobReads'
import { dayKey, todayKey } from './timezone'
import { shiftYmd } from './nextArrival'
import { pendingOpCount } from './outbox'
import { queuedPhotoJobIds } from './photoQueue'
import { queuedVideoJobIds } from './videoQueue'
import { pendingAckJobIds } from './crewNote'

export const KEEP_DAYS = 7
const DAY_MS = 24 * 3600_000
const INDEX = 'cachedJobs'

/** What the phone knows about a stop it may hold keys for. */
interface Seen {
  /** Its company day; absent when unknown. */
  d?: string
  /** Its property: null = it has none, absent = unknown. */
  a?: string | null
  /** When it was last opened here or saved by the day pack (ms). */
  t: number
}
type Index = Record<string, Seen>
const asIndex = (v: any): Index => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

// Index writes and prunes take turns: two read-change-write passes over the
// same key would lose each other's changes.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

// Stops noted since launch, in order, so a prune spares one opened while it ran.
let seq = 0
const noted = new Map<string, { seq: number; a: string | null | undefined }>()

/** A job row's property: its id, null when it has none, undefined when the row
 *  can't tell (the stop's screen then looks the property up by street). */
function propertyOf(job: any): string | null | undefined {
  const id = jobAddressId(job)
  if (id) return id
  return job?.client_addresses?.street ? undefined : null
}

/** Remember these stops as opened (or saved) just now, with their day and property. */
export function noteCachedJobs(jobs: any[]): Promise<void> {
  const epoch = cacheEpoch()
  const t = Date.now()
  const fresh: [string, Seen][] = []
  for (const j of jobs ?? []) {
    if (!j?.id) continue
    const s: Seen = { t }
    const d = dayKey(j.scheduled_start)
    if (d) s.d = d
    const a = propertyOf(j)
    if (a !== undefined) s.a = a
    noted.set(j.id, { seq: ++seq, a })
    fresh.push([j.id, s])
  }
  if (!fresh.length) return Promise.resolve()
  return serial(async () => {
    const idx = asIndex(await readCacheEntry(INDEX))
    for (const [id, s] of fresh) idx[id] = s
    await writeCacheEntry(INDEX, idx, epoch)
  })
}

export type PruneResult =
  | { status: 'pruned'; stops: number; properties: number; keys: number }
  | { status: 'held'; reason: 'outbox' | 'no-needs-closing' }

/**
 * Drop the cached reads of stops and properties nobody will need offline.
 * Runs after the day pack saves; `keep` = the stops it just saved.
 */
export function pruneJobCache(user: any, keep: any[] = []): Promise<PruneResult> {
  const mark = seq
  const epoch = cacheEpoch()
  return serial(async (): Promise<PruneResult> => {
    if (await pendingOpCount() > 0) return { status: 'held', reason: 'outbox' }
    const open = await readCacheEntry<any[]>(`dash:stranded:${user.id}`)
    if (!Array.isArray(open)) return { status: 'held', reason: 'no-needs-closing' }

    // Kept whatever their day: Needs closing, the day pack's stops, and any
    // stop with something waiting to send.
    const held = new Map<string, string | null | undefined>()
    for (const j of [...open, ...keep]) if (j?.id) held.set(j.id, propertyOf(j))
    const waiting = await Promise.all([queuedPhotoJobIds(), queuedVideoJobIds(), pendingAckJobIds()])
    for (const id of waiting.flat()) if (!held.has(id)) held.set(id, null)

    const idx = asIndex(await readCacheEntry(INDEX))
    const now = Date.now()
    const stops = new Set<string>()
    const properties = new Set<string>()
    for (const k of await dataCacheKeys()) {
      const o = cacheKeyOwner(k)
      if (o && 'job' in o) stops.add(o.job)
      else if (o) properties.add(o.property)
    }
    // Saved before the index existed, or by a screen that doesn't note:
    // KEEP_DAYS of grace from now.
    for (const id of stops) if (!idx[id]) idx[id] = { t: now }

    const dayFloor = shiftYmd(todayKey(), -KEEP_DAYS)
    const seenFloor = now - KEEP_DAYS * DAY_MS
    const dropStops = new Set<string>()
    for (const [id, s] of Object.entries(idx)) {
      if (held.has(id) || s.t >= seenFloor || (!!s.d && s.d >= dayFloor)) continue
      dropStops.add(id)
      delete idx[id]
    }

    // A property stays while any stop still kept is there; one kept stop at an
    // unknown property keeps them all.
    const pinned = new Set<string>()
    let unknown = false
    for (const a of [...Object.values(idx).map(s => s.a), ...held.values()]) {
      if (a === undefined) unknown = true
      else if (a) pinned.add(a)
    }
    const dropProperties = new Set(unknown ? [] : [...properties].filter(a => !pinned.has(a)))

    // A stop opened while this ran keeps its keys, and its property's.
    let late: { stops: Set<string>; properties: Set<string>; anyProperty: boolean } | null = null
    const openedSince = () => {
      if (!late) {
        late = { stops: new Set(), properties: new Set(), anyProperty: false }
        for (const [id, n] of noted) {
          if (n.seq <= mark) continue
          late.stops.add(id)
          if (n.a) late.properties.add(n.a)
          else if (n.a === undefined) late.anyProperty = true
        }
      }
      return late
    }
    let keys = 0
    await pruneDataCache(k => {
      const o = cacheKeyOwner(k)
      if (!o) return false
      const l = openedSince()
      const drop = 'job' in o
        ? dropStops.has(o.job) && !l.stops.has(o.job)
        : dropProperties.has(o.property) && !l.anyProperty && !l.properties.has(o.property)
      if (drop) keys++
      return drop
    })
    // Not written back once signed out since the prune was asked for.
    await writeCacheEntry(INDEX, idx, epoch)
    for (const [id, n] of noted) if (n.seq <= mark) noted.delete(id)
    return { status: 'pruned', stops: dropStops.size, properties: dropProperties.size, keys }
  })
}
