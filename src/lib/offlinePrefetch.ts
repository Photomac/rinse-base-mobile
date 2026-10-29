// The offline day pack: today's and tomorrow's stops saved on the phone while
// it has signal, so a crew member who cold-opens the app in a dead zone still
// has the day — the list, each stop's door code and arrival instructions, its
// checklist, supplies and walkthrough, and the prep card.
//
// Why: the read cache (dataCache.ts) only ever held what a screen had shown
// the last time it had signal. Home's copy saved at night held THAT day, so it
// came back empty the next morning, and a job never opened online had no door
// code at all. CKS Perfections, 2026-10-13: their manager opened the app at a
// no-service stop and could see nothing. They dispatch the night before, while
// phones sit on home Wi-Fi — that is when this runs.
//
// It warms the SAME reads the screens make (lib/jobReads.ts builds both), so
// the screens find the pack through their ordinary cachedRead() fallback; no
// screen knows the pack exists.
//
// - Details for the viewer's OWN stops only (job_assignments). The office's
//   phone is not a copy of the whole company's book; their prep card still
//   matches what Home shows them (Mine / Everyone).
// - Starts at most every 10 minutes unless forced (an assignment push, a
//   pull-to-refresh). Overlapping calls join the run in progress; a forced call
//   during one runs once more after it.
// - About 4 reads at a time, and the run stops at the first network failure:
//   on one bar it must not queue a hundred requests that will each time out.
// - No images: photo URLs come along inside rows, the files do not. One
//   exception, after the rows are saved: the photos of lines missed at the
//   last inspection of a stop's home (lib/carriedPhotoFiles), because there the
//   photo is the point. Capped, one at a time, stopping at the first failure.
// - After a saved run, stops nobody will need offline any more are dropped
//   from the cache (lib/cachePrune): the cache would otherwise only grow.
// - Runs only while the app is open. Downloading with the app never opened
//   needs a native background task (a store build) — not this file.
import { warmCache, pruneDataCache, cacheEpoch, writeCacheEntry, readCacheEntry, type CacheRead } from './dataCache'
import { noteCachedJobs, pruneJobCache } from './cachePrune'
import { dashTodayRead, homeDayRows, jobPackReads, prepJobs, prepReads, PREP_DAY_KEY, type PackRead } from './jobReads'
import { dayView, isMyJob, isOfficeRole } from './jobScope'
import { savedJobScope } from './useJobScope'
import { dayKey, todayKey, tomorrowKey } from './timezone'
import { carriedLinesRead } from './jobReads'
import { carriedFromRpc, photosToSave } from './carriedLines'
import { saveCarriedPhotos, pruneCarriedPhotos } from './carriedPhotoFiles'

export const DAY_PACK_THROTTLE_MS = 10 * 60_000
const WIDTH = 4

/** Stops whose details are worth carrying: not finished, not called off. */
const PACKED_STATUSES = ['pending_approval', 'scheduled', 'en_route', 'in_progress']

// Door code and checklist first, so a run cut short by the signal has saved
// what a crew member at the door needs before the nice-to-haves.
const FIRST = ['propmeta:', 'leadnotes:', 'chkrows:', 'tmpl:', 'jobmeta:', 'crewnote:', 'time:']
const rank = (r: CacheRead) => (FIRST.some(p => r.key.startsWith(p)) ? 0 : 1)

export interface DayPack {
  /** When the pack finished saving. */
  at: string
  /** The tenant days it covers (today, tomorrow at the time). */
  days: string[]
  /** Own stops saved, per tenant day. */
  stops: Record<string, number>
}

export type DayPackResult =
  | { status: 'saved'; pack: DayPack; reads: number }
  | { status: 'offline'; reads: number }
  | { status: 'failed'; reads: number }
  | { status: 'throttled' }
  | { status: 'skipped' }

const packKey = (userId: string) => `daypack:${userId}`

export function loadDayPack(userId: string): Promise<DayPack | null> {
  return readCacheEntry<DayPack>(packKey(userId))
}

/** Stops saved for today and later, or null when the pack holds no day from
 *  today on (nothing worth saying). */
export function stopsAhead(pack: DayPack | null, today: string): number | null {
  if (!pack) return null
  const ahead = pack.days.filter(d => d >= today)
  if (!ahead.length) return null
  return ahead.reduce((n, d) => n + (pack.stops[d] ?? 0), 0)
}

const listeners = new Set<(userId: string, pack: DayPack) => void>()
export function onDayPackChange(fn: (userId: string, pack: DayPack) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

const lastSaved = new Map<string, number>()
let running: Promise<DayPackResult> | null = null
let again: any = null

/**
 * Save today's and tomorrow's stops for offline. `rows` = Home's day read,
 * when the caller just made it live (saves reading it twice).
 */
export function prefetchDays(user: any, opts: { force?: boolean; rows?: any[] | null } = {}): Promise<DayPackResult> {
  if (!user?.id || !user?.tenant_id) return Promise.resolve({ status: 'skipped' })
  if (running) {
    if (opts.force) again = user
    return running
  }
  const last = lastSaved.get(user.id)
  if (!opts.force && last != null && Date.now() - last < DAY_PACK_THROTTLE_MS) {
    return Promise.resolve({ status: 'throttled' })
  }
  running = (async () => {
    try {
      let res = await runPack(user, opts.rows ?? null)
      while (again) {
        const next = again
        again = null
        res = await runPack(next, null)
      }
      return res
    } finally { running = null }
  })()
  return running
}

async function runPack(user: any, given: any[] | null): Promise<DayPackResult> {
  const epoch = cacheEpoch()
  const now = new Date()
  const today = todayKey()
  const tomorrow = tomorrowKey()
  const days = [today, tomorrow]
  let reads = 0

  let rows = given
  if (!rows) {
    const r = await warmCache(dashTodayRead(user, now), epoch)
    reads++
    if (!r.ok) return { status: r.status === 0 ? 'offline' : 'failed', reads }
    rows = (r.data as any[]) ?? []
  }

  const queue: PackRead[] = []
  const seen = new Set<string>()
  const add = (r: PackRead) => { if (!seen.has(r.key)) { seen.add(r.key); queue.push(r) } }

  // The viewer's own stops, today and tomorrow.
  const mine = rows.filter(j => isMyJob(j, user.id) &&
    days.includes(dayKey(j.scheduled_start)) && PACKED_STATUSES.includes(j.status))
  for (const job of mine) jobPackReads(job, user).forEach(add)
  noteCachedJobs(mine).catch(() => {})

  // The prep card Home will show each day, in the viewer's Mine / Everyone.
  const scope = isOfficeRole(user.role) ? await savedJobScope(user.id) : 'everyone'
  const linen: CacheRead[] = []
  let tenantRead: CacheRead | null = null
  for (const d of days) {
    const cleans = prepJobs(dayView(homeDayRows(rows, user, d), user.id, scope).jobs)
    if (!cleans.length) continue
    const p = prepReads(user, cleans, d)
    tenantRead = p.tenant
    add(p.addresses); add(p.stays); add(p.restock); add(p.checkFirst)
    linen.push(p.linen, p.extras)
  }
  // Linen lines only for a company that turned them on (tenants.crew_prep_linens).
  if (tenantRead) add({ ...tenantRead, then: t => ((t as any)?.crew_prep_linens ? linen : []) })

  queue.sort((a, b) => rank(a) - rank(b))
  const done = await runReads(queue, seen, epoch)
  reads += done.reads
  if (done.offline) return { status: 'offline', reads }
  // Signed out mid-run: the reads stopped and nothing was kept.
  if (epoch !== cacheEpoch()) return { status: 'skipped' }

  // Prep copies from days gone by (and the old un-dated keys) are dead weight.
  await pruneDataCache(k => {
    const m = PREP_DAY_KEY.exec(k)
    return !!m && (!m[3] || m[3] < today)
  })
  // Stops and properties nobody will need offline any more (lib/cachePrune).
  await pruneJobCache(user, mine).catch(() => {})

  const stops: Record<string, number> = {}
  for (const d of days) stops[d] = mine.filter(j => dayKey(j.scheduled_start) === d).length
  const pack: DayPack = { at: new Date().toISOString(), days, stops }
  await writeCacheEntry(packKey(user.id), pack, epoch)
  if (epoch !== cacheEpoch()) return { status: 'skipped' }
  lastSaved.set(user.id, Date.now())
  listeners.forEach(fn => { try { fn(user.id, pack) } catch { /* a listener's problem */ } })
  await saveStopPhotos(mine, epoch).catch(() => {})
  return { status: 'saved', pack, reads }
}

/** The photos of lines missed at the last inspection of each packed stop's
 *  home, from the rows just saved: saved as files, and files no packed stop
 *  needs any more deleted (only after a run that reached every one). */
async function saveStopPhotos(stops: any[], epoch: number): Promise<void> {
  const urls: string[] = []
  for (const job of stops) {
    const rows = await readCacheEntry(carriedLinesRead(job.id).key)
    for (const u of photosToSave(carriedFromRpc(rows))) if (!urls.includes(u)) urls.push(u)
  }
  if (epoch !== cacheEpoch()) return
  if (await saveCarriedPhotos(urls, epoch)) await pruneCarriedPhotos(urls)
}

/** WIDTH reads at a time; stop starting new ones at the first network
 *  failure, or once the cache is cleared (a sign-out) since `epoch`. */
async function runReads(queue: PackRead[], seen: Set<string>, epoch: number): Promise<{ offline: boolean; reads: number }> {
  let offline = false
  let reads = 0
  const worker = async () => {
    while (!offline && epoch === cacheEpoch()) {
      const r = queue.shift()
      if (!r) return
      const res = await warmCache(r, epoch)
      reads++
      if (!res.ok && res.status === 0) { offline = true; return }
      if (res.ok && r.then) {
        for (const n of r.then(res.data)) if (!seen.has(n.key)) { seen.add(n.key); queue.push(n) }
      }
    }
  }
  await Promise.all(Array.from({ length: WIDTH }, worker))
  return { offline, reads }
}

/** Push payloads that mean this phone's day changed (data.type). Only
 *  notify-crew-assigned pushes today; notify-reschedule emails the crew. */
export function isDayChangePush(data: any): boolean {
  return data?.type === 'job_assigned'
}

