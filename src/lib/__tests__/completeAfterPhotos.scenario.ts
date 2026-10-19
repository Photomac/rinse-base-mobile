// Complete-after-photos scenario. Run with: node scripts/test-complete-after-photos.mjs
//
// The REAL outbox.ts and photoQueue.ts together on one phone (imports
// rewritten to completeAfterPhotos.mocks.ts by the runner), against a server
// whose completion gate refuses a Complete while the clean has no after photo
// row, as enforce_job_completion_gate does. The failure this exists for
// (2026-10-16): a Complete queued offline reached the server before its
// photos, was refused five times and parked, and the clock-out queued before
// it had landed, so the clean stayed open with its crew clocked out.
//
// The runner also builds mutants (the hold removed, refused photos holding
// forever, incident photos counted) and requires each one to FAIL here, so a
// green run is evidence and not an accident.
import { randomBytes } from 'node:crypto'
import { writeThrough, flushOutbox, pendingOpCount, rejectedOps, onCompletePastRefusedPhotos } from '../outbox'
import { enqueuePhoto, enqueueIncidentPhoto, persistCapturedPhoto, flushQueue } from '../photoQueue'
import {
  net, db, files, fileBytes, rawQueue, setRawQueue, reported, release, releaseWrites, MockFormData, fetchMock, AsyncStorage,
} from './completeAfterPhotos.mocks'

;(globalThis as any).FormData = MockFormData
;(globalThis as any).fetch = fetchMock

let failures = 0
// A step awaiting something that never settles would otherwise end the run
// quietly, with exit code 0, before the failures are counted.
let finished = false
process.on('beforeExit', () => {
  if (!finished) { console.error('\nA step never finished: the scenario stalled'); process.exit(1) }
})
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`until: timed out waiting for ${what}`)
    await settle(2)
  }
}

const base = { tenant_id: 'T', job_id: 'J1', user_id: 'U', photo_type: 'after', caption: null, visible_to_client: true }
let n = 0
function shot(): string {
  const uri = `file:///app/NEW/Library/Caches/ImagePicker/${++n}.jpg`
  files.add(uri)
  fileBytes.set(uri, new Uint8Array(randomBytes(2000 + n)))
  return uri
}

// writeThrough kicks a flush without awaiting it, and a flush called while one
// runs returns at once. One started while offline must finish before the test
// flushes, or the test's own flush does nothing (outbox.scenario.ts settles too).
async function backOnline() { db.online = true; await settle() }

// The server marks the clean completed before the outbox has taken the op out
// of its queue: wait for both.
async function landed(what: string) {
  await until(() => db.jobs.get('J1') === 'completed', what)
  for (let i = 0; i < 100 && (await pendingOpCount()) > 0; i++) await settle(2)
}

const defaultGate = db.gate
async function reset() {
  setRawQueue([])
  net.offline = false; net.hold = false; net.held = []; net.slow.clear()
  net.attempts = []; net.uploads = []; net.readFrom = []; net.rows = []; net.attaches = []
  net.attachResult = 'ok'; net.inserts = []; net.token = 'A'; net.storage.clear(); net.loseAnswer.clear()
  net.refuseNew = false; net.heads = []; net.headFails = false
  net.loseInsertAnswer = false; net.holdInsert = false; net.selectFails = false; net.selects = []
  db.online = true; db.log = []; db.jobs.clear(); db.holdWrite = null; db.heldWrites = []; db.gate = defaultGate
  await AsyncStorage.setItem('writeOutbox', '[]')
  await AsyncStorage.setItem('writeOutboxRejected', '[]')
  reported.length = 0
  db.jobs.set('J1', 'in_progress')
}

// JobDetailScreen.completeJobNoPhotoCheck: clock out, then the Complete.
async function tapComplete(job = 'J1') {
  const at = new Date().toISOString()
  const out = await writeThrough({ table: 'job_time_entries', op: 'update', match: { id: `TE-${job}` }, values: { clocked_out_at: at, duration_minutes: 60 } })
  const done = await writeThrough({ table: 'jobs', op: 'update', match: { id: job }, values: { status: 'completed', completed_at: at, completed_by_user_id: 'U' } })
  return { out, done }
}
const clockInNextClean = () => writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: {
  id: 'TE-J2', job_id: 'J2', user_id: 'U', clocked_in_at: new Date().toISOString(), entry_type: 'work', source: 'manual',
} })
const completes = (job = 'J1') => db.log.filter(e => e.table === 'jobs' && e.filters.includes(`id=eq.${job}`) && e.values?.status === 'completed')
const outboxOps = async (): Promise<any[]> => JSON.parse((await AsyncStorage.getItem('writeOutbox')) || '[]')
const parked = async () => (await rejectedOps()).length
const afterRowOnServer = () => net.rows.push({ job_id: 'J1', photo_type: 'after', photo_url: 'https://cdn.test/job-photos/T/J1/earlier.jpg' })

;(async () => {
  // ── Complete queued while a photo is still uploading ─────────────────────
  await reset()
  net.hold = true
  await enqueuePhoto({ ...base, uri: shot() })
  const uploading = flushQueue()
  await until(() => net.held.length === 1, 'the upload to start')
  // The blocker check and the writes get no answer: the screen fails open and
  // queues the clock-out and the Complete.
  db.online = false
  const tapped = await tapComplete()
  ok('offline Complete while the photo uploads: clock-out and Complete queued',
    tapped.out.queued && tapped.done.queued && (await pendingOpCount()) === 2)
  await clockInNextClean()
  // Signal back for small writes, the photo still going: every outbox flush the
  // app makes (Dashboard load, the screen opening, Profile, the next write).
  await backOnline()
  for (let i = 0; i < 6; i++) { await settle(); await flushOutbox() }
  ok('signal back, photo still uploading: the clock-out lands', db.log[0]?.filters.includes('id=eq.TE-J1'))
  ok('…the next clean\'s clock-in goes past the waiting Complete', db.log.some(e => e.values?.id === 'TE-J2'))
  ok('…the Complete is not sent, so the gate never refuses it', completes().length === 0)
  const [waitingOp] = await outboxOps()
  ok('…it stays queued, not counted, not parked, not reported',
    (await pendingOpCount()) === 1 && waitingOp?.values?.status === 'completed' && !waitingOp.rejects &&
    (await parked()) === 0 && reported.length === 0)
  release() // the upload finishes and its row is written
  await uploading
  // No flushOutbox() here: the photo landing is what sends it.
  await landed('the Complete after the photo')
  ok('upload done: the Complete goes by itself, after the photo row',
    completes().length === 1 && completes()[0].rowsAtTheTime === 1 && !completes()[0].refused)
  ok('…the clean is completed, both queues empty', (await pendingOpCount()) === 0 && rawQueue().length === 0)
  ok('…nothing refused, parked or reported', db.log.every(e => !e.refused) && (await parked()) === 0 && reported.length === 0)

  // ── A weak bar: the photo keeps timing out (no signal, not a refusal) ─────
  await reset()
  await enqueuePhoto({ ...base, uri: shot() })
  net.slow.add(rawQueue()[0].fileName) // only the upload timeout ends it
  db.online = false
  await tapComplete()
  await backOnline()
  // The App.tsx drain: photos, then the outbox, even after a no-signal pass.
  for (let i = 0; i < 3; i++) { await flushQueue(); await flushOutbox() }
  ok('weak bar: the photo times out every pass and stays queued',
    rawQueue().length === 1 && rawQueue()[0].timeouts === 3 && rawQueue()[0].lastErrorKind === 'network')
  ok('…the Complete waits, uncounted', completes().length === 0 && (await pendingOpCount()) === 1 && !(await outboxOps())[0].rejects)
  net.slow.clear()
  await flushQueue()
  await landed('the Complete after a better bar')
  ok('…a better bar: the photo lands, then the Complete, accepted', completes().length === 1 && !completes()[0].refused)

  // ── The server keeps refusing the photo ──────────────────────────────────
  await reset()
  net.refuseNew = true
  await enqueuePhoto({ ...base, uri: shot() })
  db.online = false
  await tapComplete()
  await backOnline()
  const told: any[] = []
  const offTold = onCompletePastRefusedPhotos(e => told.push(e))
  for (let i = 0; i < 2; i++) { await flushQueue({ force: true }); await flushOutbox() }
  ok('photo refused twice: the Complete still waits (a passing refusal clears)',
    completes().length === 0 && rawQueue()[0]?.refusals === 2 && told.length === 0)
  await flushQueue({ force: true }); await flushOutbox()
  ok('…refused a 3rd time: the Complete goes and the server decides',
    completes().length === 1 && !!completes()[0].refused?.startsWith('RB_BLOCKED'))
  ok('…the crew is told, with the server\'s reason', told.length === 1 && told[0].jobId === 'J1' && /row-level security/.test(told[0].error))
  ok('…and the office (System Health)', reported.some(m => m.includes('past 1 photo the server keeps refusing')))
  for (let i = 0; i < 4; i++) { await settle(); await flushOutbox() }
  ok('…the gate needs that photo: refused 5 times, parked and reported, as any refusal',
    (await pendingOpCount()) === 0 && (await parked()) === 1 && reported.some(m => m.includes('dropped update on jobs after 5 rejections')))
  ok('…told once, not once a flush', told.length === 1)
  ok('…the photo itself is kept, failing, not lost', rawQueue().length === 1 && rawQueue()[0].lastErrorKind === 'server')

  // Same, and the gate doesn't need it (another after photo is on the server).
  await reset()
  afterRowOnServer()
  net.refuseNew = true
  await enqueuePhoto({ ...base, uri: shot() })
  db.online = false
  await tapComplete()
  await backOnline()
  for (let i = 0; i < 3; i++) { await flushQueue({ force: true }); await flushOutbox() }
  ok('refused photo the gate doesn\'t need: after the 3rd refusal the Complete lands',
    db.jobs.get('J1') === 'completed' && completes().length === 1 && !completes()[0].refused)
  ok('…the crew is told the photo is failing', told.length === 2 && told[1].refused === 1)
  offTold()

  // ── Photos the gate doesn't count don't hold it ──────────────────────────
  // A photo taken inside the incident form only joins its report.
  await reset()
  afterRowOnServer()
  net.hold = true
  await enqueueIncidentPhoto({ localUri: await persistCapturedPhoto(shot(), 'J1'), tenant_id: 'T', job_id: 'J1', user_id: 'U', incident_report_id: 'R1' })
  const incidentUp = flushQueue()
  await until(() => net.held.length === 1, 'the incident photo upload to start')
  db.online = false
  await tapComplete()
  await backOnline()
  await flushOutbox()
  ok('an incident-form photo still uploading doesn\'t hold the Complete', db.jobs.get('J1') === 'completed' && rawQueue().length === 1)
  release()
  await incidentUp

  // A damage photo flagged for a report: its job_photos row is saved, only the
  // attach to a report still in the outbox is outstanding.
  await reset()
  afterRowOnServer()
  net.attachResult = 'no_report'
  await enqueuePhoto({ ...base, photo_type: 'damage', uri: shot(), incident_report_id: 'R2' })
  await flushQueue()
  ok('flagged damage photo: row saved, the attach outstanding', rawQueue()[0]?.row_saved === true && net.rows.length === 2)
  db.online = false
  await tapComplete()
  await backOnline()
  await flushOutbox()
  ok('…it doesn\'t hold the Complete', db.jobs.get('J1') === 'completed')

  // ── The app closed and opened again while the Complete waits ─────────────
  await reset()
  await enqueuePhoto({ ...base, uri: shot() })
  net.offline = true // the photo can't go
  db.online = false
  await tapComplete()
  await backOnline()
  await flushQueue(); await flushOutbox()
  ok('photo can\'t go: the clock-out lands, the Complete waits', db.log.length === 1 && completes().length === 0)
  delete require.cache[require.resolve('../outbox')]
  delete require.cache[require.resolve('../photoQueue')]
  const queue2: typeof import('../photoQueue') = require('../photoQueue')
  const outbox2: typeof import('../outbox') = require('../outbox')
  await outbox2.flushOutbox()
  ok('app reopened: the Complete still waits', completes().length === 0 && (await outbox2.pendingOpCount()) === 1)
  net.offline = false
  await queue2.flushQueue()
  await landed('the reopened app to send the Complete')
  ok('…the reopened app sends it once the photo lands', completes().length === 1 && !completes()[0].refused)

  // ── A live Complete refused for the photo still uploading ────────────────
  // The blocker check had no answer, so the screen sent the Complete live; the
  // gate refused it. It is queued behind the photo, not shown as an error.
  await reset()
  net.hold = true
  await enqueuePhoto({ ...base, uri: shot() })
  const liveUp = flushQueue()
  await until(() => net.held.length === 1, 'the upload to start')
  const live = await tapComplete()
  ok('live Complete refused for the uploading photo: queued, no error to show',
    live.out.queued === false && live.done.queued === true && !live.done.error)
  ok('…the clock-out landed; the gate was asked once', db.log[0]?.filters.includes('id=eq.TE-J1') && completes().length === 1 && !!completes()[0].refused)
  release()
  await liveUp
  await landed('the queued live Complete')
  ok('…sent again after the photo row, accepted, nothing parked',
    completes().length === 2 && !completes()[1].refused && completes()[1].rowsAtTheTime === 1 && (await parked()) === 0)

  // ── The photo lands while a flush is mid-pass ────────────────────────────
  await reset()
  net.hold = true
  await enqueuePhoto({ ...base, uri: shot() })
  const midUp = flushQueue()
  await until(() => net.held.length === 1, 'the upload to start')
  db.online = false
  await tapComplete()
  await clockInNextClean()
  db.holdWrite = (_t, _o, values) => values?.id === 'TE-J2' // its answer is slow
  db.online = true
  // Whichever flush gets there first (the one the last write kicked, or this one).
  const pass = flushOutbox()
  await until(() => db.heldWrites.length === 1, 'the flush to pass the waiting Complete')
  ok('mid-flush: the Complete was passed over, the next clean\'s write is in flight', completes().length === 0)
  release()
  await midUp // the photo landed while that flush was still going
  releaseWrites()
  await pass
  await landed('the flush that was mid-pass to send the Complete')
  ok('photo landed mid-flush: that flush goes round and sends the Complete, no other trigger',
    (await pendingOpCount()) === 0 && completes().length === 1 && !completes()[0].refused)

  finished = true
  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nA queued Complete waits for its photos.')
})().catch(e => { console.error(e); process.exit(1) })
