// Big clips through the real video queue (CKS 2026-11-16).
// Run with: node scripts/test-tus-upload.mjs
//
// The REAL videoQueue.ts and tusUpload.ts beside the REAL outbox.ts. A clip over
// one 6 MB piece goes up resumably: announced as before, sent in pieces, and when
// the signal drops it picks up where the server left off instead of starting at
// 0. Its job_videos row lands exactly as before. It is reported as stuck only
// when it stops getting anywhere, and the report says how far it got. A small
// clip still goes as one request; a server with no resumable endpoint gets the
// one request too. A report clip still never overwrites.
import { enqueueVideo, flushVideoQueue, queuedJobVideos } from '../videoQueue'
import { net, reported, tus, tusFetch } from './tusQueue.mocks'

declare const process: any

let failures = 0
const ok = (name: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'}  ${name}${pass ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const MB = 1_048_576
const settle = () => new Promise(r => setTimeout(r, 10))
const AT = '2026-11-14T21:30:00.000Z'
const save = (job: string, type: 'before' | 'after' | 'report' = 'after', extra: any = {}) => enqueueVideo({
  uri: `file:///cache/${job}.mov`, tenant_id: 'T', job_id: job, user_id: 'U', video_type: type, duration_seconds: 73, recorded_at: AT, ...extra,
})
const rows = (table: string, job: string) => net.applied.filter(a => a.table === table).flatMap(a => (Array.isArray(a.values) ? a.values : [a.values])).filter((r: any) => r.job_id === job)
const oneShots: string[] = []

;(globalThis as any).FormData = class { parts: any = {}; append(k: string, v: any) { this.parts[k] = v } }
;(globalThis as any).fetch = async (url: string, init: any) => {
  if (url.includes('/auth/v1/health')) {
    if (!net.online) throw new TypeError('Network request failed')
    return { ok: true, status: 200, text: async () => '' }
  }
  if (!net.online) throw new TypeError('Network request failed')
  const t = tusFetch(url, init)
  if (t) return t
  // The one request, as before (a clip up to 6 MB, or no resumable endpoint).
  oneShots.push(url)
  return { ok: true, status: 200, text: async () => '' }
}

;(async () => {
  net.online = true
  net.answering = true

  // ── A big clip, start to finish ──
  tus.sizes.set('J1', Math.round(25.7 * MB))
  await save('J1')
  await settle()
  ok('a big clip is announced on its way as before', rows('job_videos_on_the_way', 'J1').length, 1)
  const first = await flushVideoQueue()
  ok('it lands in one pass', [first.uploaded, first.remaining], [1, 0])
  ok('…as one create and five pieces, never the one big request', [tus.calls.filter(c => c === 'POST').length, tus.calls.filter(c => c === 'PATCH').length, oneShots.length], [1, 5, 0])
  ok('…each piece read from its place in the file', tus.reads.map(([p]) => Math.round(p / MB)), [0, 6, 12, 18, 24])
  const row = rows('job_videos', 'J1')[0]
  ok('its job_videos row lands exactly as before (id, type, path, size)', [row?.video_type, /walkthrough_.*\.mov$/.test(row?.storage_path), row?.size_bytes], ['after', true, Math.round(25.7 * MB)])

  // ── The signal drops partway, then comes back ──
  tus.calls = []; tus.reads = []; tus.pieces = 0
  tus.sizes.set('J2', Math.round(25.7 * MB))
  tus.dropAfterPieces = 2
  await save('J2')
  await settle()
  const dropped = await flushVideoQueue()
  ok('the signal drops after two pieces: the clip is still on the phone', dropped.remaining, 1)
  const q2 = (await queuedJobVideos('J2'))[0]
  ok('…not "stuck": it got somewhere', q2?.stuck, false)
  ok('…and the crew see how far it got', q2 ? +(q2.sent_bytes! / MB).toFixed(1) : null, 12)
  tus.calls = []; tus.reads = []
  const back = await flushVideoQueue()
  ok('signal back: it lands', [back.uploaded, back.remaining], [1, 0])
  ok('…asking the server where it stopped, with no new upload', tus.calls.slice(0, 2), ['HEAD', 'PATCH'])
  ok('…and sending only the missing pieces', tus.reads.map(([p]) => Math.round(p / MB)), [12, 18, 24])
  ok('…one row', rows('job_videos', 'J2').length, 1)

  // ── The phone's piece uploader fails at once, every time (the server answers) ──
  tus.calls = []; tus.reads = []
  tus.sizes.set('J3', Math.round(14.9 * MB))
  tus.failPieces = 99
  await save('J3')
  await settle()
  reported.length = 0
  for (let i = 0; i < 3; i++) await flushVideoQueue({ force: true })
  const switched = reported.filter(m => /resumable upload failing on this phone/.test(m))
  ok('three passes of the uploader failing at once: reported once, as switching to one request', switched.length, 1)
  ok('…naming the clip, its size and the trace', /^videoQueue: clip [0-9a-f-]{36} resumable upload failing on this phone \(3 tries, 14\.9 MB\): .* \| switching to one request \| .*piece failed at once/.test(switched[0] ?? ''), true)
  ok('…and not as "keeps failing" (it isn\'t stuck yet)', reported.filter(m => /keeps failing/.test(m)).length, 0)
  const b3 = oneShots.length
  tus.calls = []
  await flushVideoQueue()
  ok('the next pass sends it the old way, as one request, and it lands', [oneShots.length - b3, tus.calls.filter(c => c === 'PATCH').length, (await queuedJobVideos('J3')).length], [1, 0, 0])
  ok('…one row', rows('job_videos', 'J3').length, 1)
  tus.failPieces = 0

  // ── The server keeps refusing pieces (503): the link's trouble, not the phone's ──
  tus.calls = []; tus.reads = []
  tus.sizes.set('J8', Math.round(14.9 * MB))
  tus.patch503 = 99
  await save('J8')
  await settle()
  reported.length = 0
  for (let i = 0; i < 3; i++) await flushVideoQueue({ force: true })
  const stuck = reported.filter(m => /keeps failing/.test(m))
  ok('no progress for three passes on the server\'s side: reported once as "keeps failing", as before', stuck.length, 1)
  ok('…with the old start, so the error log reads the same', /^videoQueue: clip [0-9a-f-]{36} keeps failing \(3 tries, 14\.9 MB, file present\): /.test(stuck[0] ?? ''), true)
  ok('…plus how far it got and what happened on the phone', /0\.0 MB on the server \| .*new upload, 14\.9 MB/.test(stuck[0] ?? ''), true)
  ok('…it keeps its resumable upload (no switch)', reported.filter(m => /switching to one request/.test(m)).length, 0)
  ok('…and the crew see it as stuck', (await queuedJobVideos('J8'))[0]?.stuck, true)
  tus.patch503 = 0
  await flushVideoQueue({ force: true })
  ok('the server recovers: it lands, resumably', [(await queuedJobVideos('J8')).length, tus.calls.includes('PATCH')], [0, true])

  // ── A small clip: the one request, as before ──
  tus.calls = []
  const before = oneShots.length
  await save('J4')
  await settle()
  await flushVideoQueue()
  ok('a 1 MB clip goes as one request, no resumable upload', [oneShots.length - before, tus.calls.length, rows('job_videos', 'J4').length], [1, 0, 1])

  // ── No resumable endpoint on the server: the one request ──
  tus.calls = []
  tus.sizes.set('J5', 20 * MB)
  tus.createStatus = 404
  const b5 = oneShots.length
  await save('J5')
  await settle()
  await flushVideoQueue()
  ok('no resumable endpoint: the same pass sends it the old way', [tus.calls, oneShots.length - b5, rows('job_videos', 'J5').length], [['POST'], 1, 1])
  tus.createStatus = 0

  // ── A big report clip ──
  tus.calls = []
  tus.sizes.set('J6', 20 * MB)
  await save('J6', 'report', { incident_report_id: 'R6' })
  await settle()
  await flushVideoQueue()
  ok('a big report clip goes up resumably', [tus.calls[0], tus.calls.filter(c => c === 'PATCH').length], ['POST', 4])
  ok('…its row goes to incident_report_videos, not job_videos', [rows('incident_report_videos', 'J6').length, rows('job_videos', 'J6').length], [1, 0])

  // ── A report clip whose file already landed (answer lost): never overwritten ──
  tus.calls = []
  tus.sizes.set('J7', 20 * MB)
  tus.reportAlreadyThere = true
  await save('J7', 'report', { incident_report_id: 'R7' })
  await settle()
  await flushVideoQueue()
  ok('"Asset Already Exists" for a report clip: taken as landed, nothing sent again', [tus.calls, rows('incident_report_videos', 'J7').length], [['POST'], 1])
  tus.reportAlreadyThere = false

  process.exit(failures ? 1 : 0)
})().catch((e: any) => { console.log(`✗  threw: ${e?.stack || e}`); process.exit(1) })
