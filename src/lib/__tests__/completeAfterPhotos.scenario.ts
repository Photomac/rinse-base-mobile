// Complete-after-photos scenario. Run with: node scripts/test-complete-after-photos.mjs
//
// The REAL outbox.ts and photoQueue.ts together on one phone (imports
// rewritten to completeAfterPhotos.mocks.ts by the runner), against a server
// whose completion gate refuses a Complete while the clean has no after photo
// row, as enforce_job_completion_gate does. The failure this exists for
// (2026-10-16): a Complete queued offline reached the server before its
// photos, was refused five times and parked, and the clock-out queued before
// it had landed, so the clean stayed open with its crew clocked out.
// And (2026-10-25): online, the gate naming only photos still on this phone,
// the Complete goes at the tap (lib/photoBlockers) instead of keeping the crew
// clocked in until they upload; anything the phone can't answer still stops it.
//
// The runner also builds mutants (the hold removed, refused photos holding
// forever, incident photos counted) and requires each one to FAIL here, so a
// green run is evidence and not an accident.
import { randomBytes } from 'node:crypto'
import { writeThrough, flushOutbox, pendingOpCount, rejectedOps, onCompletePastRefusedPhotos } from '../outbox'
import { enqueuePhoto, enqueueIncidentPhoto, persistCapturedPhoto, flushQueue, photosOnPhone, photosOnTheWay, announcePhotos } from '../photoQueue'
import { completeWhileUploading } from '../photoBlockers'
import { readHoldAnswer, whoHasThePhotos } from '../photosOnTheWay'
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
  net.records.clear(); net.recordCalls = []; net.noRecordsTable = false; net.refuseRecordsFor.clear()
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

  // ── Online, the gate waiting on a shot this phone is still sending ───────
  // JobDetailScreen.completeJob asked the gate and it named a shot still on
  // the phone. It used to refuse ("Photos still uploading") and the crew stayed
  // clocked in until the upload went: hours on one bar (Celebrity Clean,
  // 10/24). Every blocker is a photo on its way from here, so the clock-out
  // and the Complete go at the tap, and the Complete waits in the outbox.
  const shotGate = (...reqs: string[]) => (jobId: string) => reqs
    .filter(r => !net.rows.some(row => row.job_id === jobId && row.photo_requirement_id === r))
    .map(r => ({ code: 'missing_required_area_photo', requirement_id: r }))
  await reset()
  db.gate = shotGate('KITCHEN')
  net.hold = true
  await enqueuePhoto({ ...base, uri: shot(), photo_requirement_id: 'KITCHEN' })
  const shotUp = flushQueue()
  await until(() => net.held.length === 1, 'the shot upload to start')
  ok('online, the gate wants a shot this phone is still sending: Complete goes',
    completeWhileUploading(db.gate('J1'), await photosOnPhone('J1')).kind === 'go')
  const tap = await tapComplete()
  ok('…clocked out at the tap, live', tap.out.queued === false && !tap.out.error && db.log[0]?.filters.includes('id=eq.TE-J1'))
  ok('…the Complete waits behind the shot, no error to show',
    tap.done.queued === true && !tap.done.error && db.jobs.get('J1') === 'in_progress' && (await parked()) === 0)
  release()
  await shotUp
  await landed('the Complete after the shot')
  const lastComplete = () => completes()[completes().length - 1]
  ok('…the shot lands: the Complete goes by itself and is accepted',
    completes().length === 2 && !lastComplete().refused && lastComplete().rowsAtTheTime === 1 && (await parked()) === 0)

  // What no photo on this phone answers still stops it, or the held Complete
  // would reach a gate that refuses it and park.
  await reset()
  net.offline = true // nothing uploads from here on: it's what's on the phone that counts
  await enqueuePhoto({ ...base, uri: shot(), photo_requirement_id: 'KITCHEN' })
  const kitchenOnPhone = await photosOnPhone('J1')
  const kitchen = { code: 'missing_required_area_photo', requirement_id: 'KITCHEN' }
  const bath = { code: 'missing_required_area_photo', requirement_id: 'BATH' }
  const named = completeWhileUploading([kitchen, bath], kitchenOnPhone)
  ok('a shot not on this phone (never taken, or a teammate\'s on theirs): named, no Complete',
    named.kind === 'name' && named.left.length === 1 && named.left[0].requirement_id === 'BATH')
  const line = completeWhileUploading([kitchen, { code: 'unchecked_required_item', checklist_item_id: 'L1' }], kitchenOnPhone)
  ok('…an unticked required line is named too', line.kind === 'name' && line.left[0].code === 'unchecked_required_item')
  ok('…none answered from here: "still uploading", as before', completeWhileUploading([bath], kitchenOnPhone).kind === 'wait')
  ok('…another clean\'s photo answers nothing', completeWhileUploading([kitchen], await photosOnPhone('J2')).kind === 'wait')
  ok('the after photo: a queued after photo answers it', completeWhileUploading([{ code: 'no_after_photo' }], kitchenOnPhone).kind === 'go')

  await reset()
  net.offline = true
  await enqueuePhoto({ ...base, uri: shot(), check_first_line_id: 'CF1' })
  const cfOnPhone = await photosOnPhone('J1')
  ok('…a Check first photo is not the after photo', completeWhileUploading([{ code: 'no_after_photo' }], cfOnPhone).kind === 'wait')
  ok('…it answers its own Check first line',
    completeWhileUploading([{ code: 'check_first_photo_missing', requirement_id: 'CF1' }], cfOnPhone).kind === 'go')

  await reset()
  net.offline = true
  await enqueueIncidentPhoto({ localUri: await persistCapturedPhoto(shot(), 'J1'), tenant_id: 'T', job_id: 'J1', user_id: 'U', incident_report_id: 'R1' })
  ok('an incident-form photo answers nothing (it only joins its report)',
    completeWhileUploading([{ code: 'no_after_photo' }], await photosOnPhone('J1')).kind === 'wait')

  await reset()
  net.offline = true
  await enqueuePhoto({ ...base, photo_type: 'checklist', uri: shot(), checklist_item_id: 'L1', caption: 'Wipe the oven' })
  await enqueuePhoto({ ...base, photo_type: 'checklist', uri: shot(), caption: 'Mop the floor' })
  const linesOnPhone = await photosOnPhone('J1')
  ok('a checklist line\'s photo answers its line',
    completeWhileUploading([{ code: 'missing_required_photo', checklist_item_id: 'L1', task: 'Wipe the oven' }], linesOnPhone).kind === 'go')
  ok('…an unlinked photo answers by its caption, as the gate matches it',
    completeWhileUploading([{ code: 'missing_required_photo', checklist_item_id: 'L2', task: 'Mop the floor' }], linesOnPhone).kind === 'go')
  ok('…a photo linked to another line doesn\'t, whatever its caption',
    completeWhileUploading([{ code: 'missing_required_photo', checklist_item_id: 'L3', task: 'Wipe the oven' }], linesOnPhone).kind === 'wait')

  await reset()
  net.refuseNew = true
  await enqueuePhoto({ ...base, uri: shot(), photo_requirement_id: 'KITCHEN' })
  for (let i = 0; i < 3; i++) await flushQueue({ force: true })
  ok('a shot the server refused 3 times answers nothing (the outbox stops waiting on it too)',
    rawQueue()[0]?.refusals === 3 && completeWhileUploading([kitchen], await photosOnPhone('J1')).kind === 'wait')

  // ── Photos on their way: what the server hears (lib/photosOnTheWay) ──────
  // A lead's Complete waiting only on a TEAMMATE's shots, still on the
  // teammate's phone on one bar, can be held on the server (rinse-base-app
  // 20261025160000) only if the server knows those shots were taken. Each phone
  // records every photo it takes, at capture: a small request that doesn't
  // wait behind the 2 MB file.
  await reset()
  net.hold = true // the file is stuck on the bar
  const takenAt = Date.now() - 60_000
  await enqueuePhoto({ ...base, user_id: 'TEAMMATE', uri: shot(), photo_type: 'before', photo_requirement_id: 'KITCHEN', taken_at: takenAt })
  await until(() => net.records.size === 1, 'the record of the shot')
  const rec = [...net.records.values()][0]
  ok('a photo taken: the server hears of it at capture, before the file', net.uploads.length === 0 && net.rows.length === 0)
  ok('…with what the gate matches on, where the file will land, and when it was taken',
    rec.object_name === rawQueue()[0].fileName && rec.job_id === 'J1' && rec.tenant_id === 'T' && rec.user_id === 'TEAMMATE'
    && rec.photo_requirement_id === 'KITCHEN' && rec.photo_type === 'before' && rec.taken_at === new Date(takenAt).toISOString()
    && rec.checklist_item_id === null && rec.check_first_line_id === null && rec.caption === null)
  await until(() => rawQueue()[0]?.announced === true, 'the shot marked as told')
  const toldCalls = net.recordCalls.length
  const heldUp = flushQueue()
  await until(() => net.held.length === 1, 'the stuck upload to start')
  await settle()
  ok('…told once: a pass doesn\'t send it again', net.recordCalls.length === toldCalls)
  release()
  await heldUp
  ok('…and the shot itself lands as always', net.rows.length === 1 && rawQueue().length === 0)

  // No signal when it was taken: the next pass tells the server, alongside the upload.
  await reset()
  net.offline = true
  await enqueuePhoto({ ...base, uri: shot(), photo_type: 'after' })
  await settle()
  ok('no signal at capture: nothing heard yet', net.records.size === 0 && !rawQueue()[0].announced)
  net.offline = false
  net.hold = true
  const later = flushQueue()
  await until(() => net.records.size === 1, 'the pass to record it')
  ok('…the next pass records it while the file is still going', net.rows.length === 0 && net.held.length === 1)
  release()
  await later

  // Only photos that become job_photos rows are on their way to the gate.
  await reset()
  net.offline = true
  await enqueueIncidentPhoto({ localUri: await persistCapturedPhoto(shot(), 'J1'), tenant_id: 'T', job_id: 'J1', user_id: 'U', incident_report_id: 'R1' })
  net.offline = false
  await announcePhotos()
  ok('an incident-form photo is not recorded (it only joins its report)', net.records.size === 0 && net.recordCalls.length === 0)

  // A clean from another account on a shared phone: the server refuses that
  // record. The rest still go, one at a time; nothing is retried forever.
  await reset()
  net.offline = true
  await enqueuePhoto({ ...base, uri: shot(), photo_type: 'after' })
  await enqueuePhoto({ ...base, job_id: 'J9', uri: shot(), photo_type: 'after' })
  net.offline = false
  net.refuseRecordsFor.add('J9')
  await announcePhotos()
  ok('a refused batch goes again one at a time: the good record lands',
    net.records.size === 1 && [...net.records.values()][0].job_id === 'J1')
  ok('…both marked told, the refusal reported', rawQueue().every(p => p.announced) && reported.some(r => r.includes('refused 1 photo record')))
  const callsThen = net.recordCalls.length
  await announcePhotos()
  ok('…and not sent again', net.recordCalls.length === callsThen)

  // A photo whose file is gone never lands: its record is taken back, or a
  // teammate's Complete would be held for it.
  await reset()
  await enqueuePhoto({ ...base, uri: shot(), photo_type: 'after' })
  await until(() => rawQueue()[0]?.announced === true, 'the photo marked as told')
  files.delete(rawQueue()[0].localUri)
  await flushQueue()
  await until(() => net.records.size === 0, 'the record of a photo that will never land to go')
  ok('a photo whose file is gone is dropped and its record taken back', rawQueue().length === 0 && net.rows.length === 0)

  // What the Complete sends as this phone's own photos (p_on_phone).
  await reset()
  net.offline = true
  await enqueuePhoto({ ...base, photo_type: 'checklist', uri: shot(), checklist_item_id: 'L1', caption: 'Wipe the oven' })
  await enqueuePhoto({ ...base, job_id: 'J2', uri: shot(), photo_type: 'after' })
  const sent = await photosOnTheWay('J1')
  ok('the Complete sends this clean\'s photos, as recorded',
    sent.length === 1 && sent[0].object_name === rawQueue()[0].fileName && sent[0].checklist_item_id === 'L1' && sent[0].caption === 'Wipe the oven')

  // The server's answer, read.
  const held = readHoldAnswer<any>({ result: 'held', completed: false, waiting_on: [{ user_id: 'T2', name: 'Chloe NeSmith', photos: 3 }] }, null)
  ok('held: with whose phones', held.kind === 'held' && !held.completed && held.waitingOn.length === 1)
  ok('…would_hold, when only asked', readHoldAnswer<any>({ result: 'would_hold', waiting_on: [] }, null).kind === 'would_hold')
  ok('…blocked names what nothing answers', (() => {
    const b = readHoldAnswer<any>({ result: 'blocked', blockers: [{ code: 'no_after_photo' }] }, null)
    return b.kind === 'blocked' && b.blockers[0].code === 'no_after_photo'
  })())
  ok('…no answer (no signal, a server without it): unavailable, never clear',
    readHoldAnswer(null, { message: 'TypeError: Network request failed' }).kind === 'unavailable'
    && readHoldAnswer(null, { code: 'PGRST202', message: 'Could not find the function public.complete_when_photos_land' }).kind === 'unavailable'
    && readHoldAnswer({ result: 'something new' }, null).kind === 'unavailable')
  ok('…an empty blocked list is no answer, not a go', readHoldAnswer({ result: 'blocked', blockers: [] }, null).kind === 'unavailable')
  const who = whoHasThePhotos([
    { user_id: 'U', name: 'Amayah Young', photos: 2 },
    { user_id: 'T2', name: 'Chloe NeSmith', photos: 3 },
    { user_id: 'T3', name: ' Marin  Leslie', photos: 1 },
  ], 'U')
  ok('the crew is told whose phones: teammates by first name, their own counted apart',
    JSON.stringify(who) === JSON.stringify({ teammates: ['Chloe', 'Marin'], mine: 2 }))

  // Last: a server without the table (the app updated before the migration).
  // The photos upload as always and the server isn't asked again until the
  // app restarts (so this case can't be followed by another).
  await reset()
  net.noRecordsTable = true
  await enqueuePhoto({ ...base, uri: shot(), photo_type: 'after' })
  await flushQueue()
  await enqueuePhoto({ ...base, uri: shot(), photo_type: 'after' })
  await flushQueue()
  await settle()
  ok('a server without job_photos_on_the_way: photos upload as always, asked once', net.rows.length === 2 && net.recordCalls.length === 1)

  finished = true
  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nA queued Complete waits for its photos.')
})().catch(e => { console.error(e); process.exit(1) })
