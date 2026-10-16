// Offline read cache — Phase 2 of offline support (Phase 1: profileCache.ts).
//
// Wraps a Supabase read so its last good result survives in AsyncStorage: a
// crew member who loaded their day online keeps jobs, checklists, and property
// info when the signal drops. Fallback fires ONLY on status 0 — postgrest-js
// maps fetch-level failures (no signal, DNS, server unreachable) to status 0,
// while real server answers (RLS denial, 4xx/5xx) keep their HTTP status. So
// a crew member whose access was revoked does NOT keep reading cached data:
// the server's "no" is honored, only the network's silence falls back.
//
// Writes are NOT queued here — ticking a checklist or clocking in still needs
// signal until the Phase 3 outbox. Screens surface `fromCache` as an offline
// banner so nobody mistakes saved data for live.
import AsyncStorage from '@react-native-async-storage/async-storage'

const PREFIX = 'dataCache:'

// Bumped by clearDataCache(). A warm that started before a sign-out must not
// write the previous account's rows back afterwards.
let epoch = 0

export async function cachedQuery<T = any>(
  key: string,
  query: PromiseLike<{ data: T | null; error: any }>,
): Promise<{ data: T | null; error: any; fromCache: boolean }> {
  const res: any = await query
  if (!res.error) {
    AsyncStorage.setItem(PREFIX + key, JSON.stringify(res.data ?? null)).catch(() => {})
    return { data: res.data, error: null, fromCache: false }
  }
  if (res.status === 0) {
    try {
      const raw = await AsyncStorage.getItem(PREFIX + key)
      if (raw != null) return { data: JSON.parse(raw), error: null, fromCache: true }
    } catch { /* fall through to the live error */ }
  }
  return { data: res.data, error: res.error, fromCache: false }
}

/** A cached read: its cache key and the query, built only when it runs.
 *  The builders live in lib/jobReads.ts, shared by the screens and the
 *  offline day pack so both use the same key and the same select. */
export interface CacheRead {
  key: string
  q: () => PromiseLike<any>
}

export function cachedRead<T = any>(r: CacheRead) {
  return cachedQuery<T>(r.key, r.q())
}

type ReadResult<T> = { data: T | null; error: any; fromCache: boolean }

/** A read that may be answered from the saved copy before the live answer is
 *  in. `late` is that live answer (or the saved copy again, if the network
 *  fails), still to come; null when this is already the final answer. */
export type SoonRead<T = any> = ReadResult<T> & { late: Promise<ReadResult<T>> | null }

/**
 * cachedRead() for a card that must not sit behind a spinner on a weak signal.
 * On a link that swallows requests, cachedRead() only falls back to the saved
 * copy when the read deadline runs out (15 s, netFetch.ts). This waits at most
 * `waitMs` for the live answer, then answers with the saved copy and hands
 * the live answer over in `late`. With nothing saved, or `waitMs` Infinity,
 * it waits for the live answer, as cachedRead() does.
 */
export async function readSoon<T = any>(r: CacheRead, waitMs: number): Promise<SoonRead<T>> {
  const live: Promise<ReadResult<T>> = cachedRead<T>(r)
    .catch(error => ({ data: null, error, fromCache: false }))
  if (waitMs === Infinity) return { ...(await live), late: null }
  let timer: any
  const inTime = await Promise.race([
    live,
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs) }),
  ])
  clearTimeout(timer)
  if (inTime) return { ...inTime, late: null }
  let raw: string | null = null
  try { raw = await AsyncStorage.getItem(PREFIX + r.key) } catch { /* nothing saved, then */ }
  if (raw != null) {
    try { return { data: JSON.parse(raw), error: null, fromCache: true, late: live } } catch { /* unreadable: wait */ }
  }
  return { ...(await live), late: null }
}

/**
 * Run a read for the cache only (the offline day pack): store a good answer
 * under the same key cachedRead() falls back to. Never reads the cache back.
 * `status` 0 = the network failed; any other failure is a server answer.
 * Nothing is stored once the cache has been cleared since `sinceEpoch`
 * (cacheEpoch() when the caller's run began).
 */
export async function warmCache(r: CacheRead, sinceEpoch: number = epoch): Promise<{ ok: boolean; status: number; data: any }> {
  let res: any
  try { res = await r.q() } catch { return { ok: false, status: 0, data: null } }
  if (res.error) return { ok: false, status: Number(res.status) || 0, data: null }
  if (sinceEpoch === epoch) {
    try { await AsyncStorage.setItem(PREFIX + r.key, JSON.stringify(res.data ?? null)) } catch { /* best effort */ }
  }
  return { ok: true, status: Number(res.status) || 200, data: res.data }
}

/** Changes on every clearDataCache(); pass it back to writeCacheEntry(). */
export function cacheEpoch(): number { return epoch }

/** A value kept with the cached reads (dropped with them at sign-out).
 *  Skipped when the cache was cleared since `sinceEpoch`. */
export async function writeCacheEntry(key: string, value: any, sinceEpoch: number): Promise<void> {
  if (sinceEpoch !== epoch) return
  try { await AsyncStorage.setItem(PREFIX + key, JSON.stringify(value)) } catch { /* best effort */ }
}

export async function readCacheEntry<T = any>(key: string): Promise<T | null> {
  try { const raw = await AsyncStorage.getItem(PREFIX + key); return raw == null ? null : JSON.parse(raw) } catch { return null }
}

/** Every cached read's key, without the prefix. */
export async function dataCacheKeys(): Promise<string[]> {
  try {
    return (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length))
  } catch { return [] }
}

/** Drop cached reads whose key (without the prefix) matches. */
export async function pruneDataCache(drop: (key: string) => boolean): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys())
      .filter(k => k.startsWith(PREFIX) && drop(k.slice(PREFIX.length)))
    if (keys.length) await AsyncStorage.multiRemove(keys)
  } catch { /* best effort */ }
}

// Sign-out hygiene: drop every cached read (jobs, checklists, property info
// carry addresses and lockbox codes — they must not outlive the account on a
// shared device).
export async function clearDataCache(): Promise<void> {
  epoch++
  try {
    const keys = await AsyncStorage.getAllKeys()
    const mine = keys.filter(k => k.startsWith(PREFIX))
    if (mine.length) await AsyncStorage.multiRemove(mine)
  } catch { /* best effort */ }
}
