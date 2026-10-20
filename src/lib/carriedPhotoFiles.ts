// The photos of lines missed at the last inspection, saved on the phone.
//
// The day pack carries rows, never image files (lib/offlinePrefetch.ts), so a
// photo URL in a saved row shows nothing at a home with no signal. For these
// lines the photo IS the point ("this is what got missed last time, here's
// the photo": CKS Perfections, 2026-10-19, whose homes sit in dead zones), so
// the pack saves their files too, capped (lib/carriedLines photosToSave: the
// first photo of each line, at most 8 a stop).
//
// - Files live in the cache directory under carried-photos/, named from the
//   URL. The OS may clear that directory; then the photo shows from the
//   network again, as it does today.
// - Saved one at a time; the first failure stops the run (one bar must not
//   queue a dozen downloads that each time out).
// - After a saved run, files no packed stop still needs are deleted; signing
//   out deletes them all (App.tsx, with the read cache).
import * as FileSystem from 'expo-file-system/legacy'
import { cacheEpoch } from './dataCache'

const DIR = `${FileSystem.cacheDirectory ?? ''}carried-photos/`

/** A stable file name for a URL: a 32-bit FNV-1a hash twice over, plus the
 *  image extension when the URL has one. */
export function carriedPhotoName(url: string): string {
  const fnv = (s: string, seed: number) => {
    let h = seed >>> 0
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return h.toString(16).padStart(8, '0')
  }
  const path = url.split(/[?#]/)[0]
  const ext = (/\.(jpe?g|png|webp|heic|heif|gif)$/i.exec(path)?.[1] ?? 'jpg').toLowerCase()
  return `${fnv(url, 0x811c9dc5)}${fnv(url, 0x01000193)}.${ext}`
}

const fileFor = (url: string) => DIR + carriedPhotoName(url)

/** url → the saved file's uri, for the urls that have one. */
export async function savedCarriedPhotos(urls: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!FileSystem.cacheDirectory) return out
  await Promise.all(urls.map(async u => {
    try {
      const f = fileFor(u)
      const info = await FileSystem.getInfoAsync(f)
      if (info.exists && !info.isDirectory && (info as any).size !== 0) out[u] = f
    } catch { /* not saved */ }
  }))
  return out
}

/** Save the files not saved yet. Returns false when the network failed. */
export async function saveCarriedPhotos(urls: string[], sinceEpoch: number = cacheEpoch()): Promise<boolean> {
  if (!FileSystem.cacheDirectory || !urls.length) return true
  try { await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }) } catch { /* exists */ }
  const have = await savedCarriedPhotos(urls)
  for (const u of urls) {
    if (have[u] || !/^https:\/\//i.test(u)) continue
    if (sinceEpoch !== cacheEpoch()) return true
    const f = fileFor(u)
    try {
      const res = await FileSystem.downloadAsync(u, f)
      if (res.status !== 200) {
        await FileSystem.deleteAsync(f, { idempotent: true }).catch(() => {})
        // A 4xx is this file gone (deleted, moved): skip it. Anything else is
        // the network or the server: stop.
        if (res.status >= 400 && res.status < 500) continue
        return false
      }
      // Signed out while it came down: it isn't this account's any more.
      if (sinceEpoch !== cacheEpoch()) {
        await FileSystem.deleteAsync(f, { idempotent: true }).catch(() => {})
        return true
      }
    } catch {
      await FileSystem.deleteAsync(f, { idempotent: true }).catch(() => {})
      return false
    }
  }
  return true
}

/** Delete the saved files no url in `keep` names. */
export async function pruneCarriedPhotos(keep: string[]): Promise<void> {
  if (!FileSystem.cacheDirectory) return
  const names = new Set(keep.map(carriedPhotoName))
  try {
    const files = await FileSystem.readDirectoryAsync(DIR)
    await Promise.all(files.filter(n => !names.has(n)).map(n => FileSystem.deleteAsync(DIR + n, { idempotent: true }).catch(() => {})))
  } catch { /* no directory yet */ }
}

/** Sign-out: every saved file goes. */
export async function clearCarriedPhotos(): Promise<void> {
  if (!FileSystem.cacheDirectory) return
  await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => {})
}
