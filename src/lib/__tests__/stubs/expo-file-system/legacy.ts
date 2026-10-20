// Stand-in for expo-file-system/legacy in the Node harnesses that bundle the
// photo and video queues only to ask which jobs they still hold
// (scripts/test-cache-prune.mjs, scripts/test-offline-day-pack.mjs alias the
// package to this folder). Nothing here touches a file. The saved photos of
// lines missed at the last inspection (lib/carriedPhotoFiles) live in an
// in-memory folder the day-pack scenarios read: globalThis.__harness.files,
// filled by downloadAsync (status from __harness.download(url), default 200;
// every url asked for in __harness.downloads).
const h: any = ((globalThis as any).__harness = (globalThis as any).__harness ?? {})
const files: Map<string, number> = (h.files = h.files ?? new Map())
export const documentDirectory = 'file:///harness/'
export const cacheDirectory = 'file:///harness-cache/'
export async function getInfoAsync(uri: string) {
  return files.has(uri) ? { exists: true, isDirectory: false, size: files.get(uri), uri } : { exists: false }
}
export async function makeDirectoryAsync() {}
export async function copyAsync() {}
export async function deleteAsync(uri: string) {
  const dir = uri.endsWith('/') ? uri : `${uri}/`
  for (const k of [...files.keys()]) if (k === uri || k.startsWith(dir)) files.delete(k)
}
export async function downloadAsync(url: string, uri: string) {
  ;(h.downloads = h.downloads ?? []).push(url)
  const status = h.download ? await h.download(url) : 200
  if (status === 200) files.set(uri, 2048)
  return { status, uri, headers: {} }
}
export async function readDirectoryAsync(dir: string) {
  return [...files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length))
}
export async function readAsStringAsync() { return '' }
export const EncodingType = { Base64: 'base64', UTF8: 'utf8' }
