// Test doubles for videoQueue.ts with BIG clips (over one 6 MB piece): the video
// queue's doubles (videosRequired.mocks), plus a file system that reads pieces
// and sends them with createUploadTask to a fake Supabase TUS server, as
// expo-file-system/legacy does on the phone. Swapped in by
// scripts/test-tus-upload.mjs at build time.
import { FileSystem as small, net } from './videosRequired.mocks'
export { AsyncStorage, net, reported, reportClientError, video, usableAccessToken, supabase, videoBusy } from './videosRequired.mocks'

/** The fake server, and the phone's file sizes. */
export const tus = {
  /** File size by clip id fragment (default 1 MB: one request, the old way). */
  sizes: new Map<string, number>(),
  uploads: new Map<string, { size: number; offset: number; path: string }>(),
  objects: new Map<string, number>(),
  calls: [] as string[],
  /** createUploadTask fails the next N pieces at once, before any byte (the phone's uploader misbehaving). */
  failPieces: 0,
  /** The server answers the next N pieces with 503 (trouble on the server's side, not the phone's uploader). */
  patch503: 0,
  /** The piece after this many pieces fails (the signal drops); -1: never. */
  dropAfterPieces: -1,
  pieces: 0,
  /** The TUS endpoint answers this to a create (404: not there). */
  createStatus: 0,
  reads: [] as Array<[number, number]>,
  /** A report clip's file is already in storage (an earlier try landed, its answer lost). */
  reportAlreadyThere: false,
  /** Size of each file the queue moved into its folder. */
  files: new Map<string, number>(),
}

const sizeOf = (uri: string) => {
  if (tus.files.has(uri)) return tus.files.get(uri)!
  for (const [k, v] of tus.sizes) if (String(uri).includes(k)) return v
  return 1_000_000
}

export const FileSystem = {
  ...small,
  async getInfoAsync(uri?: string) { const i = await small.getInfoAsync(uri); return { ...i, size: sizeOf(String(uri)) } },
  // The queue moves the camera's file into its own folder under the clip's id.
  async moveAsync({ from, to }: { from: string; to: string }) { tus.files.set(to, sizeOf(from)) },
  EncodingType: { Base64: 'base64' },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
  async readAsStringAsync(_uri: string, opts: { position: number; length: number }) {
    tus.reads.push([opts.position, opts.length])
    return 'A'.repeat(Math.ceil(opts.length / 3) * 4)
  },
  async writeAsStringAsync() {},
  createUploadTask(url: string, _file: string, opts: any, onProgress: (p: any) => void) {
    let cancelled = false
    return {
      async uploadAsync() {
        tus.calls.push('PATCH')
        if (!net.online) throw new Error('Network request failed')
        const id = url.split('/').pop()!
        const u = tus.uploads.get(id)
        if (!u) return { status: 404, headers: {}, body: '' }
        const offset = Number(opts.headers['Upload-Offset'])
        if (offset !== u.offset) return { status: 409, headers: {}, body: '' }
        if (tus.failPieces > 0) { tus.failPieces--; throw new Error('Network request failed') }
        if (tus.patch503 > 0) { tus.patch503--; return { status: 503, headers: {}, body: 'Service Unavailable' } }
        if (tus.dropAfterPieces >= 0 && tus.pieces >= tus.dropAfterPieces) { tus.dropAfterPieces = -1; throw new Error('Network request failed') }
        tus.pieces++
        const length = Math.min(6 * 1024 * 1024, u.size - u.offset)
        if (cancelled) return null
        u.offset += length
        onProgress({ totalBytesSent: length, totalBytesExpectedToSend: length })
        if (u.offset === u.size) { tus.objects.set(u.path, u.size); tus.uploads.delete(id) }
        return { status: 204, headers: { 'Upload-Offset': String(u.offset) }, body: '' }
      },
      async cancelAsync() { cancelled = true },
    }
  },
}

/** The TUS endpoint and the stored-object check, for the scenario's fetch. */
export function tusFetch(url: string, init: any): any {
  const headers = init?.headers ?? {}
  const json = (status: number, h: Record<string, string> = {}, body = '') => ({
    ok: status >= 200 && status < 300, status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => body,
  })
  if (url.endsWith('/storage/v1/upload/resumable') && init?.method === 'POST') {
    tus.calls.push('POST')
    if (tus.createStatus) return json(tus.createStatus)
    const meta = Object.fromEntries(String(headers['Upload-Metadata']).split(',').map((p: string) => { const [k, v] = p.split(' '); return [k, Buffer.from(v, 'base64').toString()] }))
    if (headers['x-upsert'] !== 'true' && (tus.objects.has(meta.objectName) || tus.reportAlreadyThere)) return json(400, {}, '{"error":"Duplicate","message":"Asset Already Exists"}')
    const id = `up${tus.uploads.size + tus.objects.size + 1}`
    tus.uploads.set(id, { size: Number(headers['Upload-Length']), offset: 0, path: meta.objectName })
    return json(201, { location: `${url}/${id}` })
  }
  if (url.includes('/storage/v1/upload/resumable/') && init?.method === 'HEAD') {
    tus.calls.push('HEAD')
    const u = tus.uploads.get(url.split('/').pop()!)
    return u ? json(200, { 'upload-offset': String(u.offset) }) : json(404)
  }
  if (url.includes('/storage/v1/object/authenticated/')) {
    const path = url.split('/storage/v1/object/authenticated/job-videos/')[1]
    const n = tus.objects.get(path)
    return n == null ? json(400) : json(206, { 'content-range': `bytes 0-0/${n}` })
  }
  return null
}
declare const Buffer: any
