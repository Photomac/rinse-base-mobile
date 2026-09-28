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

// Record state this device just wrote as the last good read, so a later read
// that falls back to the cache (no signal) can't bring back what the crew
// just changed. Without it, "Start my day" followed by a dead-zone reload
// served the pre-start "no shift open" and offered Start again.
export async function setCached(key: string, data: any): Promise<void> {
  try { await AsyncStorage.setItem(PREFIX + key, JSON.stringify(data ?? null)) } catch { /* best effort */ }
}

// Sign-out hygiene: drop every cached read (jobs, checklists, property info
// carry addresses and lockbox codes — they must not outlive the account on a
// shared device).
export async function clearDataCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys()
    const mine = keys.filter(k => k.startsWith(PREFIX))
    if (mine.length) await AsyncStorage.multiRemove(mine)
  } catch { /* best effort */ }
}
