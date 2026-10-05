// Photo-queue scenario test. Run with: node scripts/test-photo-queue.mjs
//
// Exercises the REAL src/lib/photoQueue.ts (imports rewritten to
// photoQueue.mocks.ts by the runner) the way the crew app now uses it: photos
// are queued and the flush is kicked WITHOUT being awaited, while the crew
// keeps shooting or picks a batch from the library. The two failure modes that
// matter are a lost photo and a photo saved twice.
import {
  enqueuePhoto, flushQueue, pendingStatus, queuedJobPhotos, onPhotoQueueChange, photoQueueActive,
} from '../photoQueue'
import { net, files, rawQueue, setRawQueue, reported, release, MockFormData, fetchMock } from './photoQueue.mocks'

;(globalThis as any).FormData = MockFormData
;(globalThis as any).fetch = fetchMock

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: timed out')
    await settle(2)
  }
}

const DIR = 'file:///app/NEW/Documents/pending_photos/'
const base = { tenant_id: 'T', job_id: 'J1', user_id: 'U', photo_type: 'after', caption: null, visible_to_client: true }
let n = 0
function shot(): string {
  const uri = `file:///app/NEW/Library/Caches/ImagePicker/${++n}.jpg`
  files.add(uri)
  return uri
}
function reset() {
  setRawQueue([])
  net.offline = false; net.hold = false; net.held = []; net.slow.clear()
  net.attempts = []; net.uploads = []; net.readFrom = []; net.rows = []; net.attaches = []
  net.attachResult = 'ok'
}

;(async () => {
  const events: { uploadedJobId?: string }[] = []
  onPhotoQueueChange(e => events.push(e))

  // ── Keep shooting while a photo uploads ──────────────────────────────────
  reset()
  net.hold = true
  await enqueuePhoto({ ...base, uri: shot() })
  const first = flushQueue()
  await until(() => net.held.length === 1)
  ok('a pass is running while the first upload is in flight', photoQueueActive())
  ok('the in-flight photo is listed as uploading', (await queuedJobPhotos('J1'))[0]?.uploading === true)

  await enqueuePhoto({ ...base, uri: shot() })
  const second = flushQueue()
  ok('a flush during a pass joins it instead of starting a second one', second === first)
  ok('the photo taken mid-pass is listed as waiting, not uploading',
    (await queuedJobPhotos('J1')).filter(p => p.uploading).length === 1)

  release()
  const r1 = await first
  ok('the mid-pass photo goes in the same flush (re-run), not at the next trigger', r1.uploaded === 2 && r1.remaining === 0)
  ok('each photo uploaded exactly once', net.uploads.length === 2 && new Set(net.uploads).size === 2 && net.rows.length === 2)
  ok('no pass left running', !photoQueueActive())
  ok('local copies deleted once uploaded', ![...files].some(f => f.startsWith(DIR)))
  ok('an "uploaded" event per photo for its job', events.filter(e => e.uploadedJobId === 'J1').length === 2)

  // ── A library batch: many photos queued at once ──────────────────────────
  reset()
  await Promise.all(Array.from({ length: 20 }, () => enqueuePhoto({ ...base, uri: shot() })))
  ok('20 photos queued at once: all 20 kept (writers take turns)', rawQueue().length === 20)
  ok('20 distinct storage names (no photo overwrites another)', new Set(rawQueue().map(e => e.fileName)).size === 20)
  const kicks = Array.from({ length: 20 }, () => flushQueue())
  ok('20 kicks share one run', kicks.every(k => k === kicks[0]))
  const rBatch = await kicks[0]
  ok('the batch uploads, once each', rBatch.uploaded === 20 && net.uploads.length === 20 && new Set(net.uploads).size === 20)

  // ── App closed mid-pass: what landed must not be sent again ──────────────
  reset()
  net.hold = true
  await enqueuePhoto({ ...base, uri: shot() })
  await enqueuePhoto({ ...base, uri: shot() })
  const [a, b] = rawQueue()
  const closing = flushQueue()
  await until(() => net.held.length === 1)
  net.held.shift()!()                 // the first upload finishes…
  await until(() => net.held.length === 1 && net.uploads.length === 1)
  const stored = rawQueue()
  ok('…and is out of the stored queue before the next upload ends', stored.length === 1 && stored[0].id === b.id && !stored.some(e => e.id === a.id))
  release()
  await closing

  // ── No signal: the pass stops, nothing spins, nothing is lost ────────────
  reset()
  net.offline = true
  await enqueuePhoto({ ...base, uri: shot() })
  await enqueuePhoto({ ...base, uri: shot() })
  const off1 = flushQueue()
  flushQueue()                         // a second kick while offline
  const rOff = await off1
  ok('offline: both stay queued', rOff.uploaded === 0 && rOff.remaining === 2)
  const [o1, o2] = rawQueue()
  ok('offline: the pass stopped at the first miss (one attempt, no re-run loop)', o1.attempts === 1 && o2.attempts === undefined)
  ok('offline: "waiting", not "failing"', (await pendingStatus()).serverRejected === 0)
  net.offline = false
  const rBack = await flushQueue()
  ok('signal back: both upload', rBack.uploaded === 2 && rawQueue().length === 0)

  // ── A queue entry whose file is gone can't block the photos behind it ────
  reset()
  setRawQueue([{
    id: 'ghost', localUri: `${DIR}ghost.jpg`, fileName: 'T/J1/ghost.jpg', tenant_id: 'T', job_id: 'J1',
    user_id: 'U', photo_type: 'after', caption: null, visible_to_client: true, created_at: 1,
  }])
  await enqueuePhoto({ ...base, uri: shot() })
  const rGhost = await flushQueue()
  ok('missing-file entry dropped and reported', !rawQueue().some(e => e.id === 'ghost') && reported.some(m => m.includes('no longer on the phone')))
  ok('…and the photo behind it uploads', rGhost.uploaded === 1 && rawQueue().length === 0)

  // ── iOS moved the app folder (app update): the photo is still found ──────
  reset()
  files.add(`${DIR}moved.jpg`)
  setRawQueue([{
    id: 'moved', localUri: 'file:///app/OLD/Documents/pending_photos/moved.jpg', fileName: 'T/J1/moved.jpg',
    tenant_id: 'T', job_id: 'J1', user_id: 'U', photo_type: 'after', caption: null, visible_to_client: true, created_at: 1,
  }])
  ok('listed from today\'s folder', (await queuedJobPhotos('J1'))[0]?.localUri === `${DIR}moved.jpg`)
  const rMoved = await flushQueue()
  ok('uploaded from today\'s folder, not dropped', rMoved.uploaded === 1 && net.readFrom[0] === `${DIR}moved.jpg`)

  // ── A photo that keeps timing out goes to the back ───────────────────────
  reset()
  await enqueuePhoto({ ...base, uri: shot() })
  await enqueuePhoto({ ...base, uri: shot() })
  const [big, small] = rawQueue()
  net.slow.add(big.fileName)
  await flushQueue()
  ok('timeout: counted, and the pass stopped (reads as no signal)', rawQueue().find(e => e.id === big.id)?.timeouts === 1 && net.uploads.length === 0)
  await flushQueue()
  ok('next pass: the other photo goes first and lands', net.uploads[0] === small.fileName && !rawQueue().some(e => e.id === small.id))
  ok('…the slow one is still queued, not lost', rawQueue().length === 1 && rawQueue()[0].id === big.id)

  // ── Damage photo flagged for a report that is still in the outbox ────────
  reset()
  net.attachResult = 'no_report'
  await enqueuePhoto({ ...base, uri: shot(), photo_type: 'issue', incident_report_id: 'R1' })
  await flushQueue()
  const [flagged] = rawQueue()
  ok('flagged: saved as a job photo now', net.rows.length === 1 && net.rows[0].photo_type === 'issue')
  ok('flagged: attach waits, row_saved kept', !!flagged && flagged.row_saved === true && flagged.stored === true)
  ok('flagged: not shown twice (server list has it) and not counted as pending',
    (await queuedJobPhotos('J1')).length === 0 && (await pendingStatus('J1')).count === 0)
  net.attachResult = 'ok'
  await flushQueue({ force: true })
  ok('report lands: attached, and no second job_photos row', net.attaches.length === 2 && net.rows.length === 1 && rawQueue().length === 0)

  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nAll photo-queue invariants hold.')
})().catch(e => { console.error(e); process.exit(1) })
