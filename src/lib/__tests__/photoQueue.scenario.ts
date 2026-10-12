// Photo-queue scenario test. Run with: node scripts/test-photo-queue.mjs
//
// Exercises the REAL src/lib/photoQueue.ts (imports rewritten to
// photoQueue.mocks.ts by the runner) the way the crew app now uses it: photos
// are queued and the flush is kicked WITHOUT being awaited, while the crew
// keeps shooting or picks a batch from the library. The two failure modes that
// matter are a lost photo and a photo saved twice.
import { createHash, randomBytes } from 'node:crypto'
import {
  enqueuePhoto, flushQueue, pendingStatus, queuedJobPhotos, onPhotoQueueChange, photoQueueActive,
} from '../photoQueue'
import {
  net, files, fileBytes, bytesOf, unreadable, fsReads, rawQueue, setRawQueue, reported, release, MockFormData, fetchMock,
} from './photoQueue.mocks'

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
  fileBytes.set(uri, new Uint8Array(randomBytes(2000 + n)))
  return uri
}
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
function reset() {
  setRawQueue([])
  net.offline = false; net.hold = false; net.held = []; net.slow.clear()
  net.attempts = []; net.uploads = []; net.readFrom = []; net.rows = []; net.attaches = []
  net.attachResult = 'ok'; net.inserts = []; net.noTakenAtColumn = false; net.noSha256Column = false
  net.token = 'A'; net.storage.clear(); net.loseAnswer.clear(); net.refuseNew = false; net.heads = []; net.headFails = false
  unreadable.clear(); fsReads.length = 0; reported.length = 0
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

  // ── When it was taken (job_photos.taken_at, 2026-10-12) ──────────────────
  reset()
  const shotAt = Date.parse('2026-10-12T15:04:30Z')
  await enqueuePhoto({ ...base, uri: shot(), taken_at: shotAt })
  await enqueuePhoto({ ...base, uri: shot(), taken_at: null })
  await enqueuePhoto({ ...base, uri: shot() })
  await flushQueue()
  ok('taken_at: sent with the row as ISO, after every other field but the fingerprint',
    net.rows[0]?.taken_at === '2026-10-12T15:04:30.000Z' && Object.keys(net.rows[0]).slice(-2).join() === 'taken_at,photo_sha256')
  ok('…unknown (null, or a caller that says nothing): no taken_at sent', net.rows.length === 3 && !('taken_at' in net.rows[1]) && !('taken_at' in net.rows[2]))
  ok('…the queue time (created_at) is never sent', net.rows.every(r => !('created_at' in r)))

  // An entry queued by the bundle before this one has no taken_at at all.
  reset()
  const legacyUri = shot()
  setRawQueue([{ id: 'J1_old', localUri: legacyUri, fileName: 'T/J1/old.jpg', tenant_id: 'T', job_id: 'J1', user_id: 'U', photo_type: 'after', caption: null, visible_to_client: true, created_at: Date.now() - 60_000 }])
  await flushQueue()
  ok('an entry queued by an older bundle uploads as before, with no taken_at', net.rows.length === 1 && !('taken_at' in net.rows[0]) && rawQueue().length === 0)

  // The bundle can reach phones before the migration reaches the database.
  reset()
  net.noTakenAtColumn = true
  await enqueuePhoto({ ...base, uri: shot(), taken_at: shotAt })
  await flushQueue()
  ok('no taken_at column yet: the photo is still saved, without it, on the same pass',
    net.inserts.length === 2 && 'taken_at' in net.inserts[0] && !('taken_at' in net.inserts[1]) && net.rows.length === 1 && rawQueue().length === 0)

  // ── The file's fingerprint (job_photos.photo_sha256, 2026-10-12) ─────────
  reset()
  await enqueuePhoto({ ...base, uri: shot(), taken_at: shotAt })
  await enqueuePhoto({ ...base, uri: shot() })
  const [fp1, fp2] = rawQueue()
  await flushQueue()
  const sent1 = net.storage.get(fp1.fileName)!.bytes
  ok('photo_sha256: the SHA-256 of the very bytes the upload sent (node:crypto)',
    net.rows[0]?.photo_sha256 === sha256(sent1) && net.rows[1]?.photo_sha256 === sha256(net.storage.get(fp2.fileName)!.bytes))
  ok('…read from the same local file the upload sent, once each', fsReads.length === 2 && fsReads[0] === net.readFrom[0] && fsReads[1] === net.readFrom[1])
  ok('…64 lowercase hex characters (the column\'s CHECK)', net.rows.every(r => /^[0-9a-f]{64}$/.test(r.photo_sha256)))
  ok('body keys: as before, then taken_at, then photo_sha256 last',
    Object.keys(net.rows[0]).join() === 'tenant_id,job_id,user_id,photo_url,photo_type,caption,checklist_item_id,photo_requirement_id,visible_to_client,taken_at,photo_sha256')
  ok('…photo_sha256 last when taken_at is unknown too', Object.keys(net.rows[1]).pop() === 'photo_sha256' && !('taken_at' in net.rows[1]))
  const { photo_sha256: _fp, ...withoutFp } = net.rows[0]
  const grows = JSON.stringify(net.rows[0]).length - JSON.stringify(withoutFp).length
  ok('the request body grows by exactly 82 bytes (,"photo_sha256":"<64 hex>")', grows === 82)

  // Hashed once: a retry sends the hash it kept.
  reset()
  net.offline = true
  await enqueuePhoto({ ...base, uri: shot() })
  await flushQueue()
  const [kept] = rawQueue()
  ok('offline: the fingerprint is worked out once and kept on the queue entry', /^[0-9a-f]{64}$/.test(kept?.sha256) && fsReads.length === 1)
  await flushQueue()
  ok('…a second offline pass doesn\'t hash it again', fsReads.length === 1)
  net.offline = false
  await flushQueue()
  ok('signal back: saved with the kept hash, no third read', net.rows[0]?.photo_sha256 === kept.sha256 && fsReads.length === 1 && rawQueue().length === 0)
  ok('…and the kept hash is the stored file\'s', kept.sha256 === sha256(net.storage.get(kept.fileName)!.bytes))

  // An entry an older bundle already stored, row still owed: hashed from the
  // local file, which stays on the phone until the row is written.
  reset()
  const oldUri = shot()
  const oldBytes = bytesOf(oldUri)
  net.storage.set('T/J1/stored.jpg', { owner: 'A', bytes: oldBytes })
  setRawQueue([{ id: 'J1_stored', localUri: oldUri, fileName: 'T/J1/stored.jpg', tenant_id: 'T', job_id: 'J1', user_id: 'U', photo_type: 'after', caption: null, visible_to_client: true, created_at: 1, stored: true }])
  await flushQueue()
  ok('stored by an older bundle: no re-upload, row saved with the local file\'s hash',
    net.uploads.length === 0 && net.rows[0]?.photo_sha256 === sha256(oldBytes) && rawQueue().length === 0)

  // The file can't be read: the photo is saved anyway, without a fingerprint.
  reset()
  await enqueuePhoto({ ...base, uri: shot() })
  unreadable.add(rawQueue()[0].localUri)
  await flushQueue()
  ok('unreadable file: the row is saved without photo_sha256, same pass', net.rows.length === 1 && !('photo_sha256' in net.rows[0]) && rawQueue().length === 0)
  ok('…and it is reported', reported.some(m => m.includes('could not fingerprint')))

  // …and when the row then fails, a retry doesn't try to hash it again.
  reset()
  await enqueuePhoto({ ...base, uri: shot() })
  unreadable.add(rawQueue()[0].localUri)
  net.noTakenAtColumn = true; net.noSha256Column = true
  net.offline = true
  await flushQueue()
  ok('a fingerprint that failed is kept as null, not retried every pass', rawQueue()[0]?.sha256 === null && fsReads.length === 1)
  net.offline = false
  await flushQueue()
  ok('…and the photo still saves without one', net.rows.length === 1 && fsReads.length === 1 && rawQueue().length === 0)

  // A photo taken inside the incident form only joins its report: no hash.
  reset()
  files.add(`${DIR}incident.jpg`)
  setRawQueue([{ id: 'J1_inc', localUri: `${DIR}incident.jpg`, fileName: 'T/J1/incident_1.jpg', tenant_id: 'T', job_id: 'J1', user_id: 'U', photo_type: 'damage', caption: null, visible_to_client: false, incident_report_id: 'R2', created_at: 1 }])
  await flushQueue()
  ok('incident-form photo: attached, no job_photos row, never hashed', net.attaches.length === 1 && net.rows.length === 0 && fsReads.length === 0)

  // ── A database without photo_sha256 (PGRST204) ───────────────────────────
  reset()
  net.noSha256Column = true
  await enqueuePhoto({ ...base, uri: shot(), taken_at: shotAt })
  await flushQueue()
  ok('no photo_sha256 column: saved without it, keeping taken_at, on the same pass',
    net.inserts.length === 2 && 'photo_sha256' in net.inserts[0] && !('photo_sha256' in net.inserts[1]) &&
    net.rows.length === 1 && net.rows[0].taken_at === '2026-10-12T15:04:30.000Z' && rawQueue().length === 0)

  reset()
  net.noSha256Column = true; net.noTakenAtColumn = true
  await enqueuePhoto({ ...base, uri: shot(), taken_at: shotAt })
  await flushQueue()
  ok('neither new column: three tries, one row, the photo saved without both',
    net.inserts.length === 3 && net.rows.length === 1 && !('photo_sha256' in net.rows[0]) && !('taken_at' in net.rows[0]) && rawQueue().length === 0)

  // ── Shared phone: storage refuses the retry, but the file is there ───────
  // Crew A's upload lands, the answer is lost, A signs out, B signs in. Only
  // the uploader may write over a job photo (rinse-base-app #1391), so B's
  // retry is refused every time.
  reset()
  await enqueuePhoto({ ...base, uri: shot() })
  const [shared] = rawQueue()
  net.loseAnswer.add(shared.fileName)
  await flushQueue()
  ok('A: the file reached storage but the phone never heard back', net.storage.get(shared.fileName)?.owner === 'A' && rawQueue()[0]?.stored === undefined)
  net.token = 'B'
  const rShared = await flushQueue()
  ok('B: refused (4xx), but the file is there: marked stored and the row is written',
    rShared.uploaded === 1 && net.rows.length === 1 && rawQueue().length === 0 && net.heads.length === 1 && net.heads[0] === shared.fileName)
  ok('…A\'s file is untouched, and the row carries its hash', net.storage.get(shared.fileName)?.owner === 'A' &&
    net.rows[0].photo_sha256 === sha256(net.storage.get(shared.fileName)!.bytes))

  // The same crew member's retry after a lost answer may overwrite: no HEAD.
  reset()
  await enqueuePhoto({ ...base, uri: shot() })
  net.loseAnswer.add(rawQueue()[0].fileName)
  await flushQueue()
  await flushQueue()
  ok('same login retrying: the overwrite is allowed, nothing to ask', net.rows.length === 1 && net.heads.length === 0 && rawQueue().length === 0)

  // Refused and NOT there: still a server rejection, backed off, not lost.
  reset()
  net.refuseNew = true
  await enqueuePhoto({ ...base, uri: shot() })
  await flushQueue()
  const [refused] = rawQueue()
  ok('refused and not in storage: kept, failing, backing off, no row',
    refused?.lastErrorKind === 'server' && !refused.stored && (refused.nextAttemptAt ?? 0) > Date.now() && net.rows.length === 0 && net.heads.length === 1)
  ok('…the reason is storage\'s', /row-level security/.test(refused?.lastError ?? '') && (await pendingStatus('J1')).serverRejected === 1)

  // Refused, and the check gets no answer: not assumed stored.
  reset()
  await enqueuePhoto({ ...base, uri: shot() })
  net.loseAnswer.add(rawQueue()[0].fileName)
  await flushQueue()
  net.token = 'B'; net.headFails = true
  await flushQueue()
  const [unsure] = rawQueue()
  ok('refused and the check unanswered: kept as a server rejection, not marked stored', unsure?.lastErrorKind === 'server' && !unsure.stored && net.rows.length === 0)
  net.headFails = false
  await flushQueue({ force: true })
  ok('…the next try finds it and writes the row', net.rows.length === 1 && rawQueue().length === 0)

  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nAll photo-queue invariants hold.')
})().catch(e => { console.error(e); process.exit(1) })
