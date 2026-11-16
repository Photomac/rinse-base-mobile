// Resumable clip uploads (lib/tusUpload.ts). Run with: node scripts/test-tus-upload.mjs
//
// The REAL tusUpload.ts against a fake Supabase TUS server that keeps Supabase's
// rules (6 MB pieces, Upload-Offset, one writer, 24 h addresses, 400 "Asset
// Already Exists" without x-upsert), on a virtual clock: sleep() moves the
// clock instead of waiting, so a 3-minute hold runs in milliseconds.
import {
  tusUpload, tusMetadata, TUS_CHUNK, TUS_MAX_AGE_MS, TUS_STALL_MS, YIELD_MAX_HOLD_MS, TAP_CANCELS,
  type TusIO, type TusState, type HttpAnswer, type Busy, type ChunkSend, type TusClip,
} from '../tusUpload'

declare const Buffer: any
declare const process: any

let failures = 0
const ok = (name: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'}  ${name}${pass ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const MB = 1_048_576
const tick = () => new Promise(r => setImmediate(r))
const answer = (status: number, headers: Record<string, string> = {}, body?: string): HttpAnswer => ({
  status, body, header: (n: string) => headers[n.toLowerCase()] ?? null,
})

const ENDPOINT = 'https://p.supabase.co/storage/v1/upload/resumable'

interface Upload { size: number; offset: number; path: string; upsert: boolean; busy: boolean }

class World {
  clock = 1_800_000_000_000
  uploads = new Map<string, Upload>()
  objects = new Map<string, number>()
  calls: string[] = []
  offline = false
  /** Created uploads' addresses come back relative (as some servers do). */
  relativeLocation = false
  createStatus: number | null = null
  createBody = ''
  /** The next piece drops after this many bytes landed. */
  dropNextAfter: number | null = null
  /** The next piece never answers until cancelled; progress stops too. */
  hangNext = false
  /** The next piece answers once the clock passes this, with no progress events on the way. */
  slowUntil: number | null = null
  /** The final piece lands but its answer is lost. */
  loseFinalAnswer = false
  /** The server forgets a finished upload's address (as Supabase may). */
  forgetFinished = true
  /** PATCH answers this status this many times. */
  patchStatus: { status: number; times: number } | null = null
  /** What else is going over the network, per busy() call. */
  busyFn: (n: number) => Busy = () => ({ outbox: 0, writeWaitMs: 0, photos: false, sos: false })
  busyCalls = 0
  state: TusState | null = null
  tokenNull = false
  progress: Array<[number, boolean]> = []
  pieces: number[] = [] // lengths sent
  bytesSent = 0

  io(): TusIO {
    let ids = 0
    return {
      endpoint: ENDPOINT,
      token: async () => (this.tokenNull ? null : 'tok'),
      request: async (method, url, headers) => {
        if (this.offline) throw new TypeError('Network request failed')
        this.calls.push(method)
        if (method === 'POST') {
          if (this.createStatus) return answer(this.createStatus, {}, this.createBody)
          const meta = Object.fromEntries(headers['Upload-Metadata'].split(',').map(p => { const [k, v] = p.split(' '); return [k, Buffer.from(v, 'base64').toString()] }))
          const upsert = headers['x-upsert'] === 'true'
          if (!upsert && this.objects.has(meta.objectName)) return answer(400, {}, JSON.stringify({ statusCode: '409', error: 'Duplicate', message: 'Asset Already Exists' }))
          const id = `u${++ids}-${Math.random().toString(36).slice(2, 6)}`
          this.uploads.set(id, { size: Number(headers['Upload-Length']), offset: 0, path: meta.objectName, upsert, busy: false })
          return answer(201, { location: this.relativeLocation ? `/storage/v1/upload/resumable/${id}` : `${ENDPOINT}/${id}` })
        }
        const u = this.uploads.get(url.split('/').pop()!)
        if (!u) return answer(404)
        if (u.busy) return answer(423)
        return answer(200, { 'upload-offset': String(u.offset), 'upload-length': String(u.size) })
      },
      sendChunk: async (url, offset, length, headers, onProgress): Promise<ChunkSend> => {
        this.calls.push('PATCH')
        this.pieces.push(length)
        const id = url.split('/').pop()!
        const u = this.uploads.get(id)
        let cancel = () => {}
        const done = new Promise<HttpAnswer | null>((resolve) => {
          cancel = () => { if (u) u.busy = false; resolve(null) }
          if (this.offline) { resolve(null); return }
          if (!u) { resolve(answer(404)); return }
          if (this.patchStatus && this.patchStatus.times > 0) { this.patchStatus.times--; resolve(answer(this.patchStatus.status)); return }
          if (Number(headers['Upload-Offset']) !== u.offset) { resolve(answer(409)); return }
          if (headers['Content-Type'] !== 'application/offset+octet-stream') { resolve(answer(415)); return }
          if (length !== Math.min(TUS_CHUNK, u.size - offset)) { resolve(answer(400, {}, 'pieces must be 6 MB')); return }
          if (this.dropNextAfter != null) {
            const landed = this.dropNextAfter
            this.dropNextAfter = null
            u.offset += landed; this.bytesSent += landed
            onProgress(landed)
            resolve(null)
            return
          }
          if (this.hangNext) { this.hangNext = false; u.busy = true; return }
          const finish = () => {
            u.offset += length; this.bytesSent += length
            onProgress(length)
            if (u.offset === u.size) { this.objects.set(u.path, u.size); if (this.forgetFinished) this.uploads.delete(id) }
            if (u.offset === u.size && this.loseFinalAnswer) { this.loseFinalAnswer = false; resolve(null); return }
            resolve(answer(204, { 'upload-offset': String(u.offset) }))
          }
          if (this.slowUntil != null) {
            const until = this.slowUntil
            this.slowUntil = null
            const wait = () => { if (this.clock >= until) finish(); else setImmediate(wait) }
            setImmediate(wait)
            return
          }
          setImmediate(finish)
        })
        return { done, cancel: () => cancel() }
      },
      objectSize: async () => null,
      loadState: async () => this.state,
      saveState: async (s) => { this.state = s ? JSON.parse(JSON.stringify(s)) : null },
      busy: async () => this.busyFn(this.busyCalls++),
      now: () => this.clock,
      sleep: async (ms) => { this.clock += ms; await tick() },
      progress: (sent, _total, paused) => { this.progress.push([sent, paused]) },
    }
  }
}
const withObjects = (w: World): TusIO => ({ ...w.io(), objectSize: async () => null })
const clip = (size: number, extra: Partial<TusClip> = {}): TusClip => ({ path: 'T/J/walkthrough_c1.mov', bucket: 'job-videos', size, mime: 'video/mp4', upsert: true, ...extra })
const SIZE = Math.round(25.7 * MB) // Anya's clip, 11/14

const scenarios: Record<string, () => Promise<void>> = {

  async fresh() {
    const w = new World()
    const r = await tusUpload(clip(SIZE), w.io())
    ok('a 25.7 MB clip lands', r.ok, true)
    ok('in 6 MB pieces, the last one shorter', w.pieces.map(n => +(n / MB).toFixed(1)), [6, 6, 6, 6, 1.7])
    ok('one create, five pieces, no offset questions', w.calls, ['POST', 'PATCH', 'PATCH', 'PATCH', 'PATCH', 'PATCH'])
    ok('the stored object is the whole clip', w.objects.get('T/J/walkthrough_c1.mov'), SIZE)
    ok('its upload state is cleared', w.state, null)
    ok('progress reached the whole size', w.progress[w.progress.length - 1], [SIZE, false])
  },

  async metadata() {
    const m = tusMetadata(clip(10, { path: 'a1/b2/report_c3.mp4' }))
    const pairs = Object.fromEntries(m.split(',').map(p => { const [k, v] = p.split(' '); return [k, Buffer.from(v, 'base64').toString()] }))
    ok('Upload-Metadata carries the bucket, object, type and cache', pairs, { bucketName: 'job-videos', objectName: 'a1/b2/report_c3.mp4', contentType: 'video/mp4', cacheControl: '3600' })
  },

  async dropAndResume() {
    const w = new World()
    w.dropNextAfter = null
    // Two pieces land, the third drops after 2 MB.
    let n = 0
    const io = w.io()
    const send = io.sendChunk
    io.sendChunk = async (...a) => { if (++n === 3) w.dropNextAfter = 2 * MB; return send(...a) }
    const first = await tusUpload(clip(SIZE), io)
    ok('the signal drops mid-piece: not landed yet', first.ok, false)
    ok('…a network failure that got further (not "stuck")', first.ok ? null : [first.kind, first.progressed], ['network', true])
    ok('…the server has 14 MB, and the phone knows it', first.ok ? null : +(first.sent / MB).toFixed(1), 14)
    ok('…the upload address is kept for next time', !!w.state?.url, true)
    // Next pass, maybe after the app was killed: a new io, the saved state.
    w.calls = []
    w.bytesSent = 0
    const second = await tusUpload(clip(SIZE), w.io())
    ok('next pass: lands', second.ok, true)
    ok('…it asked the server how much it had first, and made no new upload', w.calls.slice(0, 2), ['HEAD', 'PATCH'])
    ok('…and sent only what was missing', +(w.bytesSent / MB).toFixed(1), 11.7)
    ok('…the object is whole', w.objects.get('T/J/walkthrough_c1.mov'), SIZE)
  },

  async lostFinalAnswer() {
    const w = new World()
    w.loseFinalAnswer = true
    const io = w.io()
    io.objectSize = async () => w.objects.get('T/J/walkthrough_c1.mov') ?? null
    const r = await tusUpload(clip(SIZE), io)
    ok('the last piece landed but its answer was lost, and the server forgot the address: taken as stored', r.ok, true)
    ok('…by checking the stored object\'s size, not sending it again', w.pieces.length, 5)
  },

  async oldAddress() {
    const w = new World()
    w.state = { url: `${ENDPOINT}/stale`, createdAt: w.clock - TUS_MAX_AGE_MS - 1, size: SIZE, offset: 12 * MB }
    const r = await tusUpload(clip(SIZE), w.io())
    ok('an address over 23 h old: a new upload from the start', [r.ok, w.calls[0], w.pieces.length], [true, 'POST', 5])
  },

  async goneAddress() {
    const w = new World()
    w.state = { url: `${ENDPOINT}/forgotten`, createdAt: w.clock, size: SIZE, offset: 12 * MB }
    const r = await tusUpload(clip(SIZE), withObjects(w))
    ok('an address the server forgot (404): checked, then a new upload', [r.ok, w.calls.slice(0, 2)], [true, ['HEAD', 'POST']])
  },

  async reportNoOverwrite() {
    const w = new World()
    w.objects.set('T/J/report_c1.mov', SIZE)
    const r = await tusUpload(clip(SIZE, { path: 'T/J/report_c1.mov', upsert: false }), w.io())
    ok('a report clip asks for no overwrite; "Asset Already Exists" = an earlier try landed', r.ok && (r as any).alreadyThere, true)
    ok('…nothing sent again', w.pieces.length, 0)
    const w2 = new World()
    w2.createStatus = 409
    const r2 = await tusUpload(clip(SIZE, { path: 'T/J/report_c1.mov', upsert: false }), w2.io())
    ok('…a 409 for it reads the same way', r2.ok && (r2 as any).alreadyThere, true)
    const w3 = new World()
    w3.objects.set('T/J/walkthrough_c1.mov', 3 * MB)
    const r3 = await tusUpload(clip(SIZE), w3.io())
    ok('a walkthrough clip overwrites its own earlier file (x-upsert), as before', [r3.ok, w3.objects.get('T/J/walkthrough_c1.mov')], [true, SIZE])
  },

  async refusedAndUnsupported() {
    const w = new World()
    w.createStatus = 403
    w.createBody = '{"message":"new row violates row-level security policy"}'
    const r = await tusUpload(clip(SIZE), w.io())
    ok('the rules refuse it: a server refusal, with the reason', r.ok ? null : [r.kind, /row-level security/.test(r.message)], ['server', true])
    const w2 = new World()
    w2.createStatus = 404
    const r2 = await tusUpload(clip(SIZE), w2.io())
    ok('no resumable endpoint: flagged, so the queue sends it the old way', r2.ok ? null : r2.unsupported, true)
    const w3 = new World()
    w3.createStatus = 503
    const r3 = await tusUpload(clip(SIZE), w3.io())
    ok('a 5xx counts as the network (try again)', r3.ok ? null : r3.kind, 'network')
    const w4 = new World()
    w4.tokenNull = true
    const r4 = await tusUpload(clip(SIZE), w4.io())
    ok('no usable sign-in (lapsed, no signal): nothing sent', r4.ok ? null : [r4.noToken, w4.calls.length], [true, 0])
    const w5 = new World()
    w5.offline = true
    const r5 = await tusUpload(clip(SIZE), w5.io())
    ok('no signal at all: a network failure, no progress', r5.ok ? null : [r5.kind, r5.progressed], ['network', false])
  },

  async stall() {
    const w = new World()
    let n = 0
    const io = w.io()
    const send = io.sendChunk
    io.sendChunk = async (...a) => { if (++n === 2) w.hangNext = true; return send(...a) }
    const started = w.clock
    const r = await tusUpload(clip(SIZE), io)
    ok('a piece with no progress is cancelled (the phone\'s uploader never gives up on its own)', r.ok ? null : [r.kind, /no progress/.test(r.message)], ['network', true])
    ok('…after about a minute, not 45', Math.round((w.clock - started) / 1000) <= TUS_STALL_MS / 1000 + 10, true)
    ok('…it asked the server how much landed', w.calls.includes('HEAD'), true)
    ok('…the first piece is still banked', r.ok ? null : +(r.sent / MB).toFixed(1), 6)
    ok('…and the trace says so', r.ok ? null : r.trace.some(t => /no progress for 60 s, cancelled/.test(t)), true)
  },

  async suspendedIsNotAStall() {
    // The app was suspended (screen locked) while a piece went on in the
    // background: the watch ticks are far apart, and no progress events came.
    const w = new World()
    const io = w.io()
    let gap = true
    io.sleep = async (ms) => { w.clock += gap ? 90_000 : ms; gap = false; await tick() }
    let n = 0
    const send = io.sendChunk
    io.sendChunk = async (...a) => { if (++n === 1) w.slowUntil = w.clock + 95_000; return send(...a) }
    const r = await tusUpload(clip(SIZE), io)
    ok('a 90 s gap with no progress events is a suspended app, not a dead piece', r.ok, true)
    ok('…nothing was cancelled', r.trace.some(t => /cancelled/.test(t)), false)
    ok('…and the trace notes the app was away', r.trace.some(t => /app away 90 s/.test(t)), true)
  },

  async giveWayBeforePiece() {
    const w = new World()
    // A clock-out is waiting in the outbox for the first few looks.
    w.busyFn = (n) => ({ outbox: n < 4 ? 1 : 0, writeWaitMs: 0, photos: false, sos: false })
    const r = await tusUpload(clip(SIZE), w.io())
    ok('a piece waits while a save is waiting, then goes', r.ok, true)
    ok('…the crew saw "paused" while it waited', w.progress.some(([, p]) => p), true)
    ok('…and the trace says how long', r.trace.some(t => /waited \d+ s for other work/.test(t)), true)
  },

  async stuckOutboxDoesntFreeze() {
    const w = new World()
    w.busyFn = () => ({ outbox: 1, writeWaitMs: 0, photos: false, sos: false })
    const start = w.clock
    const r = await tusUpload(clip(SIZE), w.io())
    ok('a save stuck in the outbox for good doesn\'t freeze the video', r.ok, true)
    ok('…each piece waits at most 3 minutes', Math.round((w.clock - start) / 60_000), Math.round(5 * YIELD_MAX_HOLD_MS / 60_000))
    ok('…and a piece already going isn\'t cancelled for it (it didn\'t grow)', r.trace.some(t => /gave way/.test(t)), false)
  },

  async giveWayMidPiece() {
    const w = new World()
    let n = 0
    const io = w.io()
    const send = io.sendChunk
    io.sendChunk = async (...a) => { if (++n === 2) w.hangNext = true; return send(...a) }
    // While the second piece goes, Complete is tapped: its save waits 3 s.
    w.busyFn = (c) => ({ outbox: 0, writeWaitMs: n === 2 && c >= 3 && c < 6 ? 3_000 : 0, photos: false, sos: false })
    const r = await tusUpload(clip(SIZE), io)
    ok('a save waiting on a choking link: the piece gives way, then the clip still lands', r.ok, true)
    ok('…the trace says it gave way', r.trace.some(t => /gave way to other work/.test(t)), true)
    ok('…and it asked what landed before going on', w.calls.filter(c => c === 'HEAD').length, 1)
  },

  async giveWayIsCapped() {
    const w = new World()
    const io = w.io()
    const send = io.sendChunk
    io.sendChunk = async (...a) => { w.hangNext = w.pieces.length < TAP_CANCELS; return send(...a) }
    // A save that is always waiting (the outbox retrying on a weak link).
    w.busyFn = (c) => ({ outbox: 0, writeWaitMs: c % 3 === 2 ? 5_000 : 0, photos: false, sos: false })
    const r = await tusUpload(clip(SIZE), io)
    ok(`gives way at most ${TAP_CANCELS} times a pass, then sends`, [r.ok, r.trace.filter(t => /gave way/.test(t)).length], [true, TAP_CANCELS])
  },

  async photosDontCancelSosDoes() {
    const w = new World()
    let n = 0
    const io = w.io()
    const send = io.sendChunk
    io.sendChunk = async (...a) => { if (++n === 1) w.slowUntil = w.clock + 20_000; return send(...a) }
    w.busyFn = (c) => ({ outbox: 0, writeWaitMs: 0, photos: c >= 2, sos: false })
    const r = await tusUpload(clip(7 * MB), io)
    ok('photos starting mid-piece don\'t cancel it', [r.ok, r.trace.some(t => /gave way/.test(t))], [true, false])
    const w2 = new World()
    let m = 0
    const io2 = w2.io()
    const send2 = io2.sendChunk
    io2.sendChunk = async (...a) => { if (++m === 1) w2.hangNext = true; return send2(...a) }
    w2.busyFn = (c) => ({ outbox: 0, writeWaitMs: 0, photos: false, sos: c >= 2 && c < 4 })
    const r2 = await tusUpload(clip(7 * MB), io2)
    ok('an SOS mid-piece: the piece gives way', [r2.ok, r2.trace.some(t => /gave way/.test(t))], [true, true])
  },

  async conflicts() {
    const w = new World()
    const io = w.io()
    let n = 0
    const send = io.sendChunk
    io.sendChunk = async (...a) => { if (++n === 2) w.patchStatus = { status: 409, times: 1 }; return send(...a) }
    const r = await tusUpload(clip(SIZE), io)
    ok('a 409 on a piece: asks the offset and carries on', [r.ok, w.calls.filter(c => c === 'HEAD').length], [true, 1])
    const w2 = new World()
    w2.patchStatus = { status: 409, times: 99 }
    const r2 = await tusUpload(clip(SIZE), w2.io())
    ok('…but not forever', r2.ok ? null : [r2.kind, /4 times/.test(r2.message)], ['network', true])
    const w3 = new World()
    w3.relativeLocation = true
    const r3 = await tusUpload(clip(SIZE), w3.io())
    ok('a relative upload address is resolved against the endpoint', r3.ok, true)
  },
}

const name = process.argv[2]
const run = scenarios[name]
if (!run) { console.log(`unknown scenario ${name}`); process.exit(2) }
console.log(`\n— ${name}`)
run().then(() => process.exit(failures ? 1 : 0), (e: any) => { console.log(`✗  ${name} threw: ${e?.stack || e}`); process.exit(1) })
