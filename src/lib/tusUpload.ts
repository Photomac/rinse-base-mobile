// Resumable uploads of walkthrough, line and report clips: Supabase Storage's
// TUS endpoint, in 6 MB pieces, picking up where the server left off after a
// dropped connection or an app restart. Pure: no React Native, no expo, no
// supabase (lib/videoQueue.ts hands it the real network, file and queues;
// scripts/test-tus-upload.mjs runs it against a fake TUS server).
//
// WHY (CKS 2026-11-16). A clip went up as ONE request. A failure restarted it
// from 0 bytes, and the request had a total time limit (20 KB/s, 4 to 45 min)
// that a slower link could never meet. 14 days to 11/16: 33 of 526 clips (6.3%)
// hit "keeps failing", CKS 9.6%; they landed a median 2 h 15 m late, the worst
// 51.7 h. 6 of the 35 reports were that time limit firing ("Aborted").
//
// HOW.
//   - Supabase's rules: pieces of exactly 6 MB (the last one shorter), an
//     upload address that lasts 24 hours, one writer per address (409 for a
//     second), and overwriting without x-upsert answered 400 "Asset Already
//     Exists". So the address is kept (saveState) and reused for 23 hours; a
//     report clip (never overwritten, rinse-base-app 20261112161937) asks for
//     no overwrite, and "already exists" means an earlier try landed.
//   - Every resume starts by asking the server how much it has (HEAD,
//     Upload-Offset). The server's number is the truth, never ours.
//   - No total time limit. A piece that makes no progress for TUS_STALL_MS is
//     cancelled (on iPhone the background upload never gives up on its own,
//     even with no signal). A gap in the watch ticks means the app was
//     suspended: the piece may well have gone on without us, so the clock
//     restarts rather than calling it stuck.
//   - Giving way. A piece doesn't start while clock-in/out, Complete or any
//     other save is waiting to send or sending, or photos or an SOS are on
//     their way; it waits for a quiet moment, at most YIELD_MAX_HOLD_MS. A
//     piece already going gives way (is cancelled, at most TAP_CANCELS times
//     a pass) when an SOS goes, when a save has waited TAP_WAIT_MS for an
//     answer (the link is choking), or when a new save was queued. Photos
//     don't cancel a piece; they go between pieces.

export const TUS_CHUNK = 6 * 1024 * 1024
/** Supabase keeps an upload address 24 h; a fresh one after 23. */
export const TUS_MAX_AGE_MS = 23 * 3_600_000
/** A piece with no progress this long is cancelled. */
export const TUS_STALL_MS = 60_000
export const YIELD_POLL_MS = 2_000
/** After giving way, this long with nothing else sending before a piece goes. */
export const YIELD_QUIET_MS = 2_000
/** Never wait longer than this for a quiet moment (an op stuck in the outbox
 *  must not freeze the videos for good). */
export const YIELD_MAX_HOLD_MS = 3 * 60_000
/** A save that has waited this long for an answer while a piece goes: the
 *  piece gives way. */
export const TAP_WAIT_MS = 2_000
/** Pieces cancelled to give way, at most, per pass. */
export const TAP_CANCELS = 3
/** Watch ticks further apart than this: the app was suspended in between. */
const SUSPENDED_GAP_MS = 10_000
const TRACE_MAX = 12

export interface TusState {
  /** The upload address the server gave. */
  url: string
  createdAt: number
  size: number
  /** Bytes the server had at the last answer (for the crew's progress line). */
  offset?: number
  /** The last few things that happened to this clip, for its error report. */
  trace?: string[]
}

export interface HttpAnswer {
  status: number
  header(name: string): string | null
  body?: string
}

export interface ChunkSend {
  /** The server's answer, or null once cancelled. */
  done: Promise<HttpAnswer | null>
  cancel(): void
}

/** What else is going over the network right now. */
export interface Busy {
  /** Saves waiting in the outbox (clock in/out, Complete, notes, …). */
  outbox: number
  /** How long the oldest save on its way has waited for an answer (0: none). */
  writeWaitMs: number
  /** Photos uploading or waiting. */
  photos: boolean
  /** An SOS on its way. */
  sos: boolean
}

export interface TusIO {
  /** The TUS endpoint, …/storage/v1/upload/resumable. */
  endpoint: string
  /** The access token, or null when it lapsed and can't be renewed (no signal). */
  token(): Promise<string | null>
  /** A small request (create, offset). Throws when nothing came back. */
  request(method: 'POST' | 'HEAD', url: string, headers: Record<string, string>): Promise<HttpAnswer>
  /** Read [offset, offset+length) of the file and start sending it as a PATCH.
   *  Throws when the file can't be read. */
  sendChunk(url: string, offset: number, length: number, headers: Record<string, string>, onProgress: (sent: number) => void): Promise<ChunkSend>
  /** The stored object's size, or null when it isn't there (or unknown). */
  objectSize(): Promise<number | null>
  loadState(): Promise<TusState | null>
  saveState(s: TusState | null): Promise<void>
  busy(): Promise<Busy>
  now(): number
  sleep(ms: number): Promise<void>
  /** Bytes the server has, and whether the clip is waiting for other work. */
  progress?(sent: number, total: number, paused: boolean): void
}

export interface TusClip {
  /** Object path inside the bucket. */
  path: string
  bucket: string
  size: number
  mime: string
  /** False for a report clip: its file is never overwritten. */
  upsert: boolean
}

export type TusResult =
  | { ok: true; alreadyThere?: boolean; trace: string[] }
  | {
      ok: false
      kind: 'network' | 'server'
      message: string
      /** The server has more of this clip than when the pass began. */
      progressed: boolean
      sent: number
      noToken?: boolean
      /** The server has no resumable endpoint: send it the old way. */
      unsupported?: boolean
      trace: string[]
    }

const ascii64 = (s: string): string => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i) & 0xff, b = s.charCodeAt(i + 1) & 0xff, c = s.charCodeAt(i + 2) & 0xff
    const n = (a << 16) | ((i + 1 < s.length ? b : 0) << 8) | (i + 2 < s.length ? c : 0)
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < s.length ? A[(n >> 6) & 63] : '=') + (i + 2 < s.length ? A[n & 63] : '=')
  }
  return out
}

/** Upload-Metadata: comma-separated "key base64(value)" pairs. */
export function tusMetadata(clip: TusClip): string {
  // The path is ASCII (uuids, tenant and job ids, a fixed prefix and .mp4/.mov).
  return [
    ['bucketName', clip.bucket], ['objectName', clip.path], ['contentType', clip.mime], ['cacheControl', '3600'],
  ].map(([k, v]) => `${k} ${ascii64(v)}`).join(',')
}

const MB = (n: number) => (n / 1_048_576).toFixed(1)
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19)
const already = (a: HttpAnswer) => a.status === 409 || /already exists|duplicate/i.test(a.body ?? '')

export async function tusUpload(clip: TusClip, io: TusIO): Promise<TusResult> {
  let state = await io.loadState()
  const trace: string[] = [...(state?.trace ?? [])]
  const note = (s: string) => {
    trace.push(`${hhmmss(io.now())} ${s}`)
    if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX)
  }
  let offset = 0
  let firstOffset: number | null = null
  const fail = (kind: 'network' | 'server', message: string, extra: { noToken?: boolean; unsupported?: boolean } = {}): TusResult => {
    note(`${kind}: ${message}`)
    if (state) io.saveState({ ...state, offset, trace }).catch(() => {})
    return { ok: false, kind, message, progressed: firstOffset != null && offset > firstOffset, sent: offset, trace, ...extra }
  }
  const kindOf = (status: number): 'network' | 'server' => (status >= 500 || status === 0 ? 'network' : 'server')

  let token = await io.token()
  if (!token) return fail('network', 'No signed-in session yet', { noToken: true })
  const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, 'Tus-Resumable': '1.0.0', ...extra })

  // How much the server has. 'gone': the address is no good any more.
  const askOffset = async (): Promise<number | 'gone' | TusResult> => {
    let a: HttpAnswer
    try { a = await io.request('HEAD', state!.url, headers()) } catch (e: any) { return fail('network', e?.message || 'Network request failed') }
    if (a.status >= 200 && a.status < 300) {
      const n = Number(a.header('upload-offset'))
      return Number.isFinite(n) && n >= 0 ? n : fail('server', `no Upload-Offset (HTTP ${a.status})`)
    }
    if (a.status === 404 || a.status === 410 || a.status === 403) return 'gone'
    if (a.status === 409 || a.status === 423) return fail('network', `upload busy (HTTP ${a.status}): an earlier piece is still going`)
    return fail(kindOf(a.status), `HTTP ${a.status} asking how much landed`)
  }

  // The address is gone mid-upload. The last piece may have landed with its
  // answer lost (Supabase may forget a finished upload's address): the stored
  // file says. Otherwise a new upload next pass.
  const whenGone = async (why: string): Promise<TusResult> => {
    const there = await io.objectSize().catch(() => null)
    if (there === clip.size) { note('already stored'); await io.saveState(null); return { ok: true, trace } }
    await io.saveState(null)
    state = null
    return fail('network', `${why}; a new upload next pass`)
  }

  let restarts = 0
  // ── Find or make the upload ──
  for (;;) {
    if (state && (state.size !== clip.size || io.now() - state.createdAt > TUS_MAX_AGE_MS)) {
      note('upload address too old, starting a new one')
      state = null
    }
    if (state) {
      const got = await askOffset()
      if (typeof got === 'object') return got
      if (got !== 'gone') { offset = got; break }
      // The address is gone. The last piece may have landed with its answer lost.
      const there = await io.objectSize().catch(() => null)
      if (there === clip.size) { note('already stored'); await io.saveState(null); return { ok: true, trace } }
      note('upload address gone, starting a new one')
      state = null
    }
    if (restarts++ > 1) return fail('server', 'the server keeps dropping the upload')
    let a: HttpAnswer
    try {
      a = await io.request('POST', io.endpoint, headers({
        'Upload-Length': String(clip.size),
        'Upload-Metadata': tusMetadata(clip),
        'x-upsert': clip.upsert ? 'true' : 'false',
      }))
    } catch (e: any) { return fail('network', e?.message || 'Network request failed') }
    if (a.status === 201 && a.header('location')) {
      const loc = a.header('location')!
      state = { url: /^https?:\/\//.test(loc) ? loc : new URL(loc, io.endpoint).toString(), createdAt: io.now(), size: clip.size, offset: 0 }
      note(`new upload, ${MB(clip.size)} MB`)
      await io.saveState({ ...state, trace })
      offset = 0
      break
    }
    // A report clip's file is never overwritten: "already exists" means an
    // earlier try landed and its answer was lost.
    if (!clip.upsert && (a.status === 400 || a.status === 409) && already(a)) {
      note('already stored (no overwrite)')
      await io.saveState(null)
      return { ok: true, alreadyThere: true, trace }
    }
    if (a.status === 404 || a.status === 405 || a.status === 501) return fail('server', `no resumable uploads here (HTTP ${a.status})`, { unsupported: true })
    return fail(kindOf(a.status), `HTTP ${a.status}${a.body ? `: ${a.body.slice(0, 120)}` : ''} starting the upload`)
  }
  firstOffset = offset
  io.progress?.(offset, clip.size, false)

  // ── The pieces ──
  let tapCancels = 0
  let conflicts = 0
  while (offset < clip.size) {
    await giveWay(io, note, () => io.progress?.(offset, clip.size, true))
    io.progress?.(offset, clip.size, false)
    token = await io.token()
    if (!token) return fail('network', 'No signed-in session yet', { noToken: true })
    const length = Math.min(TUS_CHUNK, clip.size - offset)
    const outboxAtStart = (await io.busy()).outbox
    let lastProgress = io.now()
    let send: ChunkSend
    try {
      send = await io.sendChunk(state!.url, offset, length, headers({
        'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream',
      }), (sent) => { lastProgress = io.now(); io.progress?.(offset + Math.min(sent, length), clip.size, false) })
    } catch (e: any) {
      return fail('network', `couldn't read the clip: ${e?.message || e}`)
    }
    const started = io.now()
    // Watch it: its answer, or a reason to cancel.
    let answer: HttpAnswer | null = null
    let cancelled: 'stall' | 'giveway' | null = null
    let settled = false
    const done = send.done.then(a => { settled = true; answer = a }, () => { settled = true; answer = null })
    let lastTick = io.now()
    while (!settled) {
      await Promise.race([done, io.sleep(YIELD_POLL_MS)])
      if (settled) break
      const now = io.now()
      if (now - lastTick > SUSPENDED_GAP_MS) {
        // Evidence the server can't give: the app was away (screen locked).
        note(`app away ${Math.round((now - lastTick) / 1000)} s during the piece at ${MB(offset)} MB`)
        lastProgress = now
      }
      lastTick = now
      if (now - lastProgress >= TUS_STALL_MS) { cancelled = 'stall'; break }
      if (tapCancels < TAP_CANCELS) {
        const b = await io.busy()
        if (b.sos || b.writeWaitMs >= TAP_WAIT_MS || b.outbox > outboxAtStart) { cancelled = 'giveway'; break }
      }
    }
    if (cancelled) {
      send.cancel()
      await Promise.race([done, io.sleep(5_000)])
      note(cancelled === 'stall' ? `piece at ${MB(offset)} MB: no progress for ${TUS_STALL_MS / 1000} s, cancelled` : `piece at ${MB(offset)} MB gave way to other work`)
      if (cancelled === 'giveway') tapCancels++
      // How much of it landed is the server's to say.
      const got = await askOffset()
      if (typeof got === 'object') return got
      if (got === 'gone') return whenGone('upload address gone after a cancel')
      offset = got
      await io.saveState({ ...state!, offset, trace })
      if (cancelled === 'stall') return fail('network', `no progress for ${TUS_STALL_MS / 1000} s`)
      continue
    }
    const a = answer as HttpAnswer | null
    if (!a) {
      // Ended without an answer (the request failed): ask what landed.
      const got = await askOffset()
      if (typeof got === 'object') return got
      if (got === 'gone') return whenGone('Network request failed')
      const moved = got > offset
      offset = got
      await io.saveState({ ...state!, offset, trace })
      return fail('network', moved ? `Network request failed (piece partly landed, ${MB(offset)} MB on the server)` : 'Network request failed')
    }
    if (a.status === 204 || a.status === 200) {
      const n = Number(a.header('upload-offset'))
      const secs = Math.max(1, (io.now() - started) / 1000)
      offset = Number.isFinite(n) && n > offset ? n : offset + length
      note(`piece to ${MB(offset)} MB, ${Math.round(length / 1024 / secs)} KB/s`)
      await io.saveState({ ...state!, offset, trace })
      io.progress?.(offset, clip.size, false)
      continue
    }
    if (a.status === 409 || a.status === 423) {
      // The offset moved under us, or another piece still holds the upload.
      if (++conflicts > 3) return fail('network', `HTTP ${a.status} sending a piece, ${conflicts} times`)
      if (a.status === 423) await io.sleep(YIELD_POLL_MS)
      const got = await askOffset()
      if (typeof got === 'object') return got
      if (got === 'gone') return whenGone(`HTTP ${a.status}, then the upload address was gone`)
      offset = got
      continue
    }
    if (a.status === 404 || a.status === 410) return whenGone(`upload address gone (HTTP ${a.status})`)
    return fail(kindOf(a.status), `HTTP ${a.status}${a.body ? `: ${a.body.slice(0, 120)}` : ''} sending a piece`)
  }
  note('stored')
  await io.saveState(null)
  return { ok: true, trace }
}

/** Wait until nothing more urgent is going over the network: right away when
 *  nothing is, else until it has been quiet for YIELD_QUIET_MS, and never
 *  longer than YIELD_MAX_HOLD_MS. */
async function giveWay(io: TusIO, note: (s: string) => void, paused: () => void): Promise<void> {
  const start = io.now()
  let quietSince: number | null = null
  let waited = false
  for (;;) {
    const b = await io.busy()
    const busy = b.outbox > 0 || b.writeWaitMs > 0 || b.photos || b.sos
    const now = io.now()
    if (!busy) {
      if (!waited) return
      if (quietSince == null) quietSince = now
      if (now - quietSince >= YIELD_QUIET_MS) { note(`waited ${Math.round((now - start) / 1000)} s for other work`); return }
    } else {
      quietSince = null
      if (!waited) paused()
      waited = true
    }
    if (now - start >= YIELD_MAX_HOLD_MS) { note('other work still going after 3 min; sending a piece anyway'); return }
    await io.sleep(YIELD_POLL_MS)
  }
}
