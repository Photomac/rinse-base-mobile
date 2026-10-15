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
import { writeThrough, flushOutbox, pendingOpCount, rejectedOps, overlayPending, uuid4 } from '../outbox'
import { net, reported } from './outbox.mocks'

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
