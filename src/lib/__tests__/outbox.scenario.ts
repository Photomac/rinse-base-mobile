// Offline write-outbox scenario test. Run with: node scripts/test-outbox.mjs
//
// Exercises the REAL src/lib/outbox.ts (imports rewritten to outbox.mocks.ts
// by the runner) through the lifecycle the feature exists for: a crew member
// in a dead zone clocks in, works, completes — then signal returns. Asserts
// the invariants the file's header comments promise. A queued time entry is
// somebody's pay: double rows and lost rows are the two failure modes.
//
// Timing note: writeThrough fires flushOutbox() without awaiting it, and
// flushOutbox is guarded against re-entry — so tests SETTLE (macrotask tick)
// before counting flushes, or the fire-and-forget flush eats one iteration.
// That guard is by design; the settle is the test accommodating it.
import { writeThrough, flushOutbox, pendingOpCount, rejectedOps, overlayPending, uuid4, onCompletePastRefusedPhotos } from '../outbox'
import { net, reported, photos, photoLanded } from './outbox.mocks'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const settle = () => new Promise(r => setTimeout(r, 10))

;(async () => {
  // ── Dead zone: writes must queue, never error, never reorder ─────────────
  const entryId = uuid4()
  let r = await writeThrough({
    table: 'job_time_entries', op: 'upsert', onConflict: 'id',
    values: { id: entryId, job_id: 'J1', clocked_in_at: 't0' },
  })
  ok('offline upsert queues (no error)', r.queued === true && r.error === null)

  r = await writeThrough({ table: 'jobs', op: 'update', match: { id: 'J1' }, values: { status: 'in_progress' } })
  ok('second write queues behind pending, no live attempt', r.queued === true && net.applied.length === 0)
  ok('two ops pending', (await pendingOpCount()) === 2)

  await flushOutbox()
  ok('offline flush drops nothing', (await pendingOpCount()) === 2)

  const rows = await overlayPending('job_time_entries', [], v => v.job_id === 'J1')
  ok('overlayPending surfaces the queued entry on cached reads', rows.length === 1 && rows[0].id === entryId)

  // ── Signal returns: strict FIFO drain ────────────────────────────────────
  await settle()
  net.online = true
  await flushOutbox()
  ok('online flush drains the queue', (await pendingOpCount()) === 0)
  ok('replay order preserved (time entry lands before job status)',
    net.applied[0]?.table === 'job_time_entries' && net.applied[1]?.table === 'jobs')

  // ── Poisoned op: parks after MAX_REJECTS, reports, does not dam the queue ─
  net.rejectTables.add('job_time_entries')
  net.online = false
  await writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: { id: uuid4(), job_id: 'J2' } })
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'J2' }, values: { status: 'completed' } })
  await settle()
  net.online = true
  for (let i = 0; i < 5; i++) { await settle(); await flushOutbox() }
  const rej = await rejectedOps()
  ok('poisoned op parked after 5 rejection flushes', rej.length === 1 && rej[0].table === 'job_time_entries')
  ok('drop reported to the error channel', reported.length === 1 && reported[0].includes('job_time_entries'))
  ok('ops behind the poison proceed once it parks', (await pendingOpCount()) === 0 &&
    net.applied.some(a => a.table === 'jobs' && a.values.status === 'completed'))
  net.rejectTables.clear()

  // ── Day shift started twice (one open shift per person on the server) ────
  // A queued Start that loses to a shift already open must not be retried
  // into the park list, and the hours on both sides must survive.
  const T = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 8, d, h, m)).toISOString()
  const shiftParkedBefore = (await rejectedOps()).length
  const shiftReportedBefore = reported.length
  const shiftStart = (id: string, user: string, at: string) => writeThrough({
    table: 'job_time_entries', op: 'upsert', onConflict: 'id',
    values: { id, user_id: user, job_id: null, entry_type: 'shift', clocked_in_at: at },
  })
  const shiftEnd = (id: string, at: string, mins: number) => writeThrough({
    table: 'job_time_entries', op: 'update', match: { id },
    values: { clocked_out_at: at, duration_minutes: mins },
  })

  // S1 same day: phone offline starts X at 14:00 and ends it at 22:00; the
  // web had started O at 14:05. O becomes the day: 14:00 to 22:00.
  await settle(); net.online = false; net.applied.length = 0
  const X1 = uuid4()
  net.openShifts.set('u1', { id: 'O1', clocked_in_at: T(28, 14, 5) })
  await shiftStart(X1, 'u1', T(28, 14))
  await shiftEnd(X1, T(28, 22), 480)
  await settle(); net.online = true; await flushOutbox()
  ok('S1 same-day conflict drains the queue', (await pendingOpCount()) === 0)
  ok('S1 no second shift row landed', !net.applied.some(a => a.op === 'upsert' && a.values.id === X1))
  ok('S1 the open shift keeps the earlier start', net.applied.some(a => a.op === 'update' && a.filters.includes('id=eq.O1') && a.values.clocked_in_at === T(28, 14)))
  ok('S1 End my day closes the open shift, minutes from 14:00',
    net.applied.some(a => a.op === 'update' && a.filters.includes('id=eq.O1') && a.values.clocked_out_at === T(28, 22) && a.values.duration_minutes === 480))

  // S2 a whole earlier shift queued offline (06:00-10:00) while O (14:00) is
  // open: recorded closed, its End folded in, O untouched.
  await settle(); net.online = false; net.applied.length = 0
  const X2 = uuid4()
  net.openShifts.set('u2', { id: 'O2', clocked_in_at: T(28, 14) })
  await shiftStart(X2, 'u2', T(28, 6))
  await shiftEnd(X2, T(28, 10), 240)
  await settle(); net.online = true; await flushOutbox()
  ok('S2 earlier whole shift recorded closed',
    net.applied.some(a => a.op === 'upsert' && a.values.id === X2 && a.values.clocked_out_at === T(28, 10) && a.values.duration_minutes === 240))
  ok('S2 its End was folded in, the open shift untouched', !net.applied.some(a => a.op === 'update') && net.openShifts.get('u2')?.id === 'O2')
  ok('S2 queue drained', (await pendingOpCount()) === 0)

  // S3 a start from yesterday that was never ended, replayed after today's O
  // (13:00) exists: closed at its 16 h cap, flagged; an End tapped later on a
  // screen still showing it goes to O.
  await settle(); net.online = false; net.applied.length = 0
  const X3 = uuid4()
  net.openShifts.set('u3', { id: 'O3', clocked_in_at: T(28, 13) })
  await shiftStart(X3, 'u3', T(27, 14))
  await settle(); net.online = true; await flushOutbox()
  ok('S3 forgotten earlier-day start recorded closed at 16 h, labelled',
    net.applied.some(a => a.op === 'upsert' && a.values.id === X3 && a.values.clocked_out_at === T(28, 6)
      && a.values.duration_minutes === 960 && a.values.pause_reason === 'Auto-closed: a new day was started'))
  const r3 = await shiftEnd(X3, T(28, 21), 1860)
  ok('S3 a later End for the lost start closes the running shift, minutes from its start',
    r3.error === null && net.applied.some(a => a.op === 'update' && a.filters.includes('id=eq.O3') && a.values.duration_minutes === 480))

  // S4 the open shift is ended between the refused insert and the read-back:
  // retried (not resolved into anything), then lands on the next flush.
  await settle(); net.online = false; net.applied.length = 0
  const X4 = uuid4()
  net.openShifts.set('u4', { id: 'O4', clocked_in_at: T(28, 8) })
  await shiftStart(X4, 'u4', T(28, 9))
  await settle(); net.online = true; net.hideOpenOnRead = true
  await flushOutbox()
  ok('S4 unresolved conflict stays queued', (await pendingOpCount()) === 1)
  net.hideOpenOnRead = false; net.openShifts.delete('u4')
  await settle(); await flushOutbox()
  ok('S4 lands once the other shift is closed', (await pendingOpCount()) === 0 && net.applied.some(a => a.op === 'upsert' && a.values.id === X4))

  ok('S1-S4 nothing parked, nothing reported', (await rejectedOps()).length === shiftParkedBefore && reported.length === shiftReportedBefore)

  // S5 online with an empty queue: the refusal goes back to the caller (the
  // Dashboard shows the running shift), nothing is queued.
  await settle(); net.applied.length = 0
  net.openShifts.set('u5', { id: 'O5', clocked_in_at: T(28, 8) })
  const r5 = await shiftStart(uuid4(), 'u5', T(28, 8, 30))
  ok('S5 live conflict returned as 23505, not queued', r5.error?.code === '23505' && r5.queued === false && (await pendingOpCount()) === 0)

  // S6 CKS 2026-10-10 (Mia, Lilly): the day running since 07:28, a reload in a
  // dead zone offered Start again and the 10:10 tap queued. That used to be
  // refused five times, parked and shown as "your hours may be missing". Now
  // it settles into the running shift, which keeps its 07:28 start, and End
  // my day tapped later on the queued start's id closes the running one.
  await settle(); net.online = false; net.applied.length = 0
  const parkedBefore6 = (await rejectedOps()).length
  const reportedBefore6 = reported.length
  const X6 = uuid4()
  net.openShifts.set('u6', { id: 'O6', clocked_in_at: T(10, 14, 28) })
  await shiftStart(X6, 'u6', T(10, 17, 10))
  await settle(); net.online = true
  for (let i = 0; i < 5; i++) { await settle(); await flushOutbox() }
  ok('S6 second Start on a running day: queue drained', (await pendingOpCount()) === 0)
  ok('S6 …nothing parked, nothing reported', (await rejectedOps()).length === parkedBefore6 && reported.length === reportedBefore6)
  ok('S6 …no second shift row, the running one keeps 07:28',
    !net.applied.some(a => a.op === 'upsert' && a.values.id === X6) && !net.applied.some(a => a.op === 'update')
    && net.openShifts.get('u6')?.clocked_in_at === T(10, 14, 28))
  const r6 = await shiftEnd(X6, T(10, 22, 38), 328)
  ok('S6 End my day on the queued start closes the running shift, 07:28 to 15:38',
    r6.error === null && net.applied.some(a => a.op === 'update' && a.filters.includes('id=eq.O6')
      && a.values.clocked_out_at === T(10, 22, 38) && a.values.duration_minutes === 490)
    && !net.openShifts.has('u6'))

  // ── A replace-all save: new rows first, then delete what they replace ────
  // (JobInventoryScreen.save's shape until it went id-stable; see
  // inventoryLogSave.scenario.ts). The delete must never run on its own.
  net.rejectTables.clear()
  r = await writeThrough({ table: 'job_inventory_log', op: 'delete', match: {}, values: {} })
  ok('a delete with no filter is refused, not queued', !!r.error && !r.queued && (await pendingOpCount()) === 0)

  net.online = false
  const before = rejectedOps().then(x => x.length)
  const idA = uuid4(), idB = uuid4()
  const saveRows = [
    { id: idA, job_id: 'J3', inventory_id: 'TP', qty_used: 2, needs_restock: false },
    { id: idB, job_id: 'J3', inventory_id: 'SOAP', qty_used: 0, needs_restock: true },
  ]
  const g = uuid4()
  r = await writeThrough({ table: 'job_inventory_log', op: 'upsert', onConflict: 'id', values: saveRows, group: g })
  ok('offline supplies save: new rows queue (one op, both rows)', r.queued === true && (await pendingOpCount()) === 1)
  r = await writeThrough({ table: 'job_inventory_log', op: 'delete', match: { job_id: 'J3' }, values: {},
    keep: { column: 'id', values: [idA, idB] }, group: g })
  ok('…then the delete of the old rows queues behind it', r.queued === true && (await pendingOpCount()) === 2)

  const oldRows = [{ id: 'OLD1', job_id: 'J3', inventory_id: 'TP', qty_used: 9 }, { id: 'OLD2', job_id: 'J3', inventory_id: 'BAGS', qty_used: 1 }]
  const shown = await overlayPending('job_inventory_log', oldRows, v => v.job_id === 'J3')
  ok('reopened offline, the screen shows the queued save — not the old rows, not both',
    shown.length === 2 && shown.every(x => x.id === idA || x.id === idB))

  await settle()
  net.online = true
  net.applied.length = 0
  await flushOutbox()
  ok('online: upsert lands before the delete', net.applied[0]?.op === 'upsert' && net.applied[1]?.op === 'delete')
  ok('…the upsert carries both rows in one request', Array.isArray(net.applied[0]?.values) && net.applied[0].values.length === 2)
  ok('…the delete is scoped to the job and spares the new rows',
    net.applied[1]?.filters.includes('job_id=eq.J3') && net.applied[1]?.filters.includes(`id=not.in.(${idA},${idB})`))

  // Grouped parking: if the new rows are rejected for good, the delete that
  // assumes they landed must park with them, or the job's log is wiped.
  net.online = false
  const g2 = uuid4(), idC = uuid4()
  await writeThrough({ table: 'job_inventory_log', op: 'upsert', onConflict: 'id', values: [{ id: idC, job_id: 'J4' }], group: g2 })
  await writeThrough({ table: 'job_inventory_log', op: 'delete', match: { job_id: 'J4' }, values: {}, keep: { column: 'id', values: [idC] }, group: g2 })
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'J4' }, values: { status: 'completed' } })
  await settle()
  net.online = true
  net.rejectTables.add('job_inventory_log')
  net.rejectOp = 'upsert'
  net.applied.length = 0
  for (let i = 0; i < 5; i++) { await settle(); await flushOutbox() }
  const parked = (await rejectedOps()).length - (await before)
  ok('rejected supplies rows park after 5 flushes, their delete parks WITH them', parked === 2)
  ok('…the delete never ran', !net.applied.some(a => a.op === 'delete'))
  ok('…and the unrelated op behind them still lands', (await pendingOpCount()) === 0 &&
    net.applied.some(a => a.table === 'jobs' && a.values.status === 'completed'))

  // Forward-only status writes (CKS #1083, 2026-09-30). A start queued behind
  // a stuck op can replay after the job was completed; its IN filter must
  // travel with it to the server, and the offline overlay must not show a
  // completed job as started again.
  net.online = false
  net.rejectTables.clear()
  net.rejectOp = null
  const STARTABLE = ['pending_approval', 'scheduled', 'en_route', 'in_progress']
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'J5' }, matchIn: { status: STARTABLE }, values: { status: 'in_progress' } })
  const startShown = await overlayPending('jobs', [
    { id: 'J5', status: 'completed' },
  ])
  ok('overlay: a queued start does not reopen a completed job', startShown[0].status === 'completed')
  const shown2 = await overlayPending('jobs', [{ id: 'J5', status: 'scheduled' }])
  ok('overlay: …but still starts a scheduled one', shown2[0].status === 'in_progress')
  await settle()
  net.online = true
  net.applied.length = 0
  await flushOutbox()
  const startWrite = net.applied.find(a => a.table === 'jobs' && a.values.status === 'in_progress')
  ok('replayed start carries its status IN filter to the server',
    !!startWrite && startWrite.filters.includes('id=eq.J5') &&
    startWrite.filters.includes(`status=in.(${STARTABLE.join(',')})`))

  // A queued Complete waits for its clean's photos (2026-10-16). Offline, the
  // clock-out and the Complete queue while the photos are still on the phone;
  // the gate refuses the Complete until they land. Sent first, it was refused
  // five times and parked, leaving the clean open with its crew clocked out.
  // Held, it is not sent, not counted, and goes once they land. Ops for that
  // clean behind it wait with it; the next clean's go past.
  const completedP = (id: string) => net.applied.filter(a => a.table === 'jobs' && a.filters.includes(`id=eq.${id}`) && a.values?.status === 'completed')
  net.online = false
  net.applied.length = 0
  const rejectedBeforeP = (await rejectedOps()).length
  const reportedBeforeP = reported.length
  let completeTries = 0
  net.beforeWrite = (table, _op, values) => { if (table === 'jobs' && values?.status === 'completed') completeTries++ }
  photos.set('P1', { waiting: 2, refused: 0, lastServerError: null })
  net.blocked.set('P1', ['no_after_photo'])
  await writeThrough({ table: 'job_time_entries', op: 'update', match: { id: 'TE-P1' }, values: { clocked_out_at: '2026-10-16T15:00:00.000Z', duration_minutes: 60 } })
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'P1' }, values: { status: 'completed', completed_at: '2026-10-16T15:00:00.000Z' } })
  await writeThrough({ table: 'job_inventory_log', op: 'upsert', onConflict: 'id', values: [{ id: uuid4(), job_id: 'P1', inventory_id: 'TP', qty_used: 1 }] })
  await writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: {
    id: 'TE-P2', job_id: 'P2', user_id: 'U1', clocked_in_at: '2026-10-16T15:20:00.000Z', entry_type: 'work', source: 'manual',
  } })
  await settle()
  net.online = true
  for (let i = 0; i < 6; i++) { await settle(); await flushOutbox() }
  ok('Complete waiting on photos: the clock-out queued before it lands', net.applied[0]?.filters.includes('id=eq.TE-P1'))
  ok('…the Complete is never sent (the gate is never asked)', completeTries === 0 && completedP('P1').length === 0)
  ok('…the next clean\'s clock-in goes past it', net.applied[1]?.values?.id === 'TE-P2')
  ok('…the supplies save for the same clean waits behind it',
    !net.applied.some(a => a.table === 'job_inventory_log') && (await pendingOpCount()) === 2)
  const nothingParked = (await rejectedOps()).length === rejectedBeforeP
  ok('…six flushes later nothing is counted, parked or reported', nothingParked && reported.length === reportedBeforeP)
  photos.delete('P1')
  net.blocked.delete('P1')
  photoLanded('P1')
  await settle(); await settle()
  ok('photos landed: the Complete goes at once, with no other trigger', completedP('P1').length === 1 && completeTries === 1)
  ok('…then the supplies save queued behind it', net.applied[net.applied.length - 1]?.table === 'job_inventory_log' && (await pendingOpCount()) === 0)
  ok('…nothing parked, nothing reported', (await rejectedOps()).length === rejectedBeforeP && reported.length === reportedBeforeP)

  // A photo the server keeps refusing gives way (photoQueue says when): the
  // Complete goes and the server decides, and the crew and the office are told.
  const pastRefused: any[] = []
  const offPast = onCompletePastRefusedPhotos(e => pastRefused.push(e))
  net.online = false
  photos.set('P3', { waiting: 0, refused: 1, lastServerError: 'HTTP 400: new row violates row-level security policy' })
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'P3' }, values: { status: 'completed' } })
  await settle()
  net.online = true
  await flushOutbox()
  ok('refused photo, gate satisfied: the Complete lands', completedP('P3').length === 1 && (await pendingOpCount()) === 0)
  ok('…the crew is told once, with the server\'s reason',
    pastRefused.length === 1 && pastRefused[0].jobId === 'P3' && pastRefused[0].error.includes('row-level security'))
  ok('…and the office (System Health)', reported.length === reportedBeforeP + 1 && reported[reported.length - 1].includes('past 1 photo'))

  // Same, and the gate needs that photo: the server's refusal counts as any
  // other, so the Complete parks after five and is reported. Told once.
  net.online = false
  photos.set('P4', { waiting: 0, refused: 2, lastServerError: 'HTTP 400: refused' })
  net.blocked.set('P4', ['no_after_photo'])
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'P4' }, values: { status: 'completed' } })
  await settle()
  net.online = true
  for (let i = 0; i < 4; i++) { await settle(); await flushOutbox() }
  ok('refused photo the gate needs: the refusals are counted (4 flushes, still queued)',
    (await pendingOpCount()) === 1 && pastRefused.length === 2)
  await settle()
  await flushOutbox()
  ok('…parked on the 5th and reported', (await pendingOpCount()) === 0 &&
    (await rejectedOps()).length === rejectedBeforeP + 1 && reported[reported.length - 1].includes('dropped update on jobs'))
  ok('…the crew was told once, not once a flush', pastRefused.length === 2)
  offPast()
  net.blocked.delete('P4')
  photos.delete('P3'); photos.delete('P4')

  // Live: queue empty, the blocker check had no answer so the Complete was
  // sent, and the gate refused it for photos this phone is still sending. It
  // is queued behind them instead of returned as an error.
  photos.set('P5', { waiting: 1, refused: 0, lastServerError: null })
  net.blocked.set('P5', ['no_after_photo', 'missing_required_area_photo'])
  r = await writeThrough({ table: 'jobs', op: 'update', match: { id: 'P5' }, values: { status: 'completed' } })
  ok('live Complete refused for photos still on the phone: queued, no error', r.queued === true && !r.error && (await pendingOpCount()) === 1)
  await settle()
  await flushOutbox()
  ok('…and held, uncounted', (await pendingOpCount()) === 1 && !(await rejectedOps()).some(x => x.match?.id === 'P5'))
  photos.delete('P5'); net.blocked.delete('P5')
  photoLanded('P5')
  await settle(); await settle()
  ok('…sent once they land', completedP('P5').length === 1 && (await pendingOpCount()) === 0)

  // Any other refusal is the caller's to show, as before: a blocker no photo
  // answers, or photo blockers with no photo on the phone.
  photos.set('P6', { waiting: 1, refused: 0, lastServerError: null })
  net.blocked.set('P6', ['no_after_photo', 'unchecked_required_item'])
  r = await writeThrough({ table: 'jobs', op: 'update', match: { id: 'P6' }, values: { status: 'completed' } })
  ok('live Complete refused for a ticked-item blocker too: the error is returned', !r.queued && String(r.error?.message).startsWith('RB_BLOCKED'))
  photos.delete('P6')
  net.blocked.set('P6', ['no_after_photo'])
  r = await writeThrough({ table: 'jobs', op: 'update', match: { id: 'P6' }, values: { status: 'completed' } })
  ok('…and for photos the phone doesn\'t have', !r.queued && String(r.error?.message).startsWith('RB_BLOCKED') && (await pendingOpCount()) === 0)
  net.blocked.delete('P6')

  // A photo queued between the check and the send: the refusal is not counted,
  // the Complete waits for it.
  net.online = false
  net.blocked.set('P7', ['no_after_photo'])
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'P7' }, values: { status: 'completed' } })
  net.beforeWrite = (table, _op, values) => {
    if (table === 'jobs' && values?.status === 'completed') photos.set('P7', { waiting: 1, refused: 0, lastServerError: null })
  }
  await settle()
  net.online = true
  for (let i = 0; i < 6; i++) { await settle(); await flushOutbox() }
  ok('photo queued mid-send: the refusal is not counted, the Complete waits',
    (await pendingOpCount()) === 1 && !(await rejectedOps()).some(x => x.match?.id === 'P7'))
  net.beforeWrite = null
  photos.delete('P7'); net.blocked.delete('P7')
  photoLanded('P7')
  await settle(); await settle()
  ok('…and goes once it lands', completedP('P7').length === 1 && (await pendingOpCount()) === 0)

  // A clean's clock started twice (job_time_entries_one_open_per_job, 23505).
  // The tap queued in a dead zone; meanwhile the arrival auto clock-in (or
  // the web) opened an entry for the same person on the same clean. The
  // queued start must fold into the running entry, not park, and the
  // clock-out queued behind it must close THAT entry with the right minutes.
  net.online = false
  net.applied.length = 0
  const rejectedBefore = (await rejectedOps()).length
  const reportedBefore = reported.length
  const tapId = uuid4()
  await writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: {
    id: tapId, job_id: 'J6', user_id: 'U1', clocked_in_at: '2026-10-02T23:40:24.000Z', entry_type: 'work', source: 'manual',
  } })
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'J6' }, matchIn: { status: STARTABLE }, values: { status: 'in_progress' } })
  await writeThrough({ table: 'job_time_entries', op: 'update', match: { id: tapId }, values: {
    clocked_out_at: '2026-10-03T01:46:53.000Z', duration_minutes: 126,
  } })
  net.openWork.set('J6|U1', { id: 'AUTO1', clocked_in_at: '2026-10-02T23:39:02.000Z' })
  await settle()
  net.online = true
  await flushOutbox()
  const out6 = net.applied.find(a => a.op === 'update' && a.values?.clocked_out_at)
  ok('refused queued clock-in folds into the running entry: queue drains', (await pendingOpCount()) === 0)
  ok('…nothing parked, nothing reported', (await rejectedOps()).length === rejectedBefore && reported.length === reportedBefore)
  ok('…the queued clock-out closes the RUNNING entry', !!out6 && out6.filters.includes('id=eq.AUTO1') && !net.openWork.has('J6|U1'))
  ok('…with minutes from its own (earlier) start: 23:39:02 → 01:46:53 = 128', out6?.values.duration_minutes === 128)
  ok('…its earlier start is left alone', !net.applied.some(a => a.op === 'update' && a.values?.clocked_in_at))
  ok('…and the status write queued with it still lands', net.applied.some(a => a.table === 'jobs' && a.filters.includes('id=eq.J6')))

  // Same, but the queued tap is the EARLIER start: the running entry takes it.
  net.online = false
  net.applied.length = 0
  const tap2 = uuid4()
  await writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: {
    id: tap2, job_id: 'J7', user_id: 'U1', clocked_in_at: '2026-10-02T23:30:00.000Z', entry_type: 'work', source: 'manual',
  } })
  await writeThrough({ table: 'job_time_entries', op: 'update', match: { id: tap2 }, values: {
    clocked_out_at: '2026-10-03T01:30:00.000Z', duration_minutes: 120,
  } })
  net.openWork.set('J7|U1', { id: 'WEB1', clocked_in_at: '2026-10-02T23:39:02.000Z' })
  await settle()
  net.online = true
  await flushOutbox()
  const moved = net.applied.find(a => a.op === 'update' && a.values?.clocked_in_at)
  const out7 = net.applied.find(a => a.op === 'update' && a.values?.clocked_out_at)
  ok('earlier queued tap: the running entry\'s start moves back to it',
    !!moved && moved.filters.includes('id=eq.WEB1') && moved.filters.includes('clocked_out_at=is.null') &&
    moved.values.clocked_in_at === '2026-10-02T23:30:00.000Z')
  ok('…and the clock-out counts from that start: 120 min', !!out7 && out7.filters.includes('id=eq.WEB1') && out7.values.duration_minutes === 120)
  ok('…queue drains', (await pendingOpCount()) === 0)
  net.openWork.clear()

  // A clock-in delivered with its answer lost, then the person is taken off
  // the clean (rinsebase-app #1487: crew may insert an entry only on a clean
  // they're assigned to). The replay is refused with 42501, because the insert
  // rule is checked on the proposed row before ON CONFLICT finds the stored
  // one. The row and its pay are intact: the op WAS delivered, so it must go
  // quietly. A false "dropped" invites the office to "+ Add" the hours again.
  net.applied.length = 0
  const rejectedBefore8 = (await rejectedOps()).length
  const reportedBefore8 = reported.length
  const lostId = uuid4()
  net.loseAcks = 1
  r = await writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: {
    id: lostId, job_id: 'J8', user_id: 'U1', clocked_in_at: '2026-10-15T14:00:00.000Z', entry_type: 'work', source: 'manual',
  } })
  ok('lost ack: the clock-in landed but read as offline, so it queues', r.queued === true && net.storedEntries.has(lostId))
  net.notOnClean.add('J8')
  // The check can't get through: nothing is decided, nothing counted.
  net.readsOffline = true
  await writeThrough({ table: 'job_time_entries', op: 'update', match: { id: lostId }, values: {
    clocked_out_at: '2026-10-15T16:00:00.000Z', duration_minutes: 120,
  } })
  for (let i = 0; i < 5; i++) { await settle(); await flushOutbox() }
  ok('refused replay, read-back offline: held through 5 flushes, not parked',
    (await pendingOpCount()) === 2 && (await rejectedOps()).length === rejectedBefore8 && reported.length === reportedBefore8)
  net.readsOffline = false
  await settle()
  await flushOutbox()
  ok('refused replay of a STORED clock-in is dropped as delivered: queue drains', (await pendingOpCount()) === 0)
  ok('…nothing parked, nothing reported', (await rejectedOps()).length === rejectedBefore8 && reported.length === reportedBefore8)
  ok('…the replay itself never landed a second time',
    net.applied.filter(a => a.op === 'upsert' && a.values?.id === lostId).length === 1)
  ok('…and the clock-out queued behind it closes the stored entry',
    net.applied.some(a => a.op === 'update' && a.filters.includes(`id=eq.${lostId}`) && !!a.values?.clocked_out_at))

  // A clock-in queued offline, and the person taken off the clean before signal
  // returned: no row on the server. That is a real refusal and still parks
  // after five flushes and is reported, as any other.
  net.online = false
  const newId = uuid4()
  await writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: {
    id: newId, job_id: 'J9', user_id: 'U1', clocked_in_at: '2026-10-15T15:00:00.000Z', entry_type: 'work', source: 'manual',
  } })
  net.notOnClean.add('J9')
  await settle()
  net.online = true
  for (let i = 0; i < 4; i++) { await settle(); await flushOutbox() }
  ok('refused NEW clock-in: still queued after 4 flushes', (await pendingOpCount()) === 1)
  await settle()
  await flushOutbox()
  const lastReport = reported[reported.length - 1] || ''
  ok('…parked on the 5th', (await pendingOpCount()) === 0 && (await rejectedOps()).some(x => (x.values as any)?.id === newId))
  ok('…and reported', reported.length === reportedBefore8 + 1 && lastReport.includes('job_time_entries') && lastReport.includes('row-level security'))
  ok('…it never landed', !net.storedEntries.has(newId))
  net.notOnClean.clear()

  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nAll outbox invariants hold.')
})()
