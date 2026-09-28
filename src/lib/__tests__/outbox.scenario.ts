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
  net.rejectTables.clear()

  // ── Day shift started twice (one open shift per person on the server) ────
  // A queued Start that loses to a shift already open must not be retried
  // into the park list, and the hours on both sides must survive.
  const T = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 8, d, h, m)).toISOString()
  const parkedBefore = (await rejectedOps()).length
  const reportedBefore = reported.length
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
  ok('S1 the open shift keeps the earlier start', net.applied.some(a => a.op === 'update' && a.match.id === 'O1' && a.values.clocked_in_at === T(28, 14)))
  ok('S1 End my day closes the open shift, minutes from 14:00',
    net.applied.some(a => a.op === 'update' && a.match.id === 'O1' && a.values.clocked_out_at === T(28, 22) && a.values.duration_minutes === 480))

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
    r3.error === null && net.applied.some(a => a.op === 'update' && a.match.id === 'O3' && a.values.duration_minutes === 480))

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

  ok('S1-S4 nothing parked, nothing reported', (await rejectedOps()).length === parkedBefore && reported.length === reportedBefore)

  // S5 online with an empty queue: the refusal goes back to the caller (the
  // Dashboard shows the running shift), nothing is queued.
  await settle(); net.applied.length = 0
  net.openShifts.set('u5', { id: 'O5', clocked_in_at: T(28, 8) })
  const r5 = await shiftStart(uuid4(), 'u5', T(28, 8, 30))
  ok('S5 live conflict returned as 23505, not queued', r5.error?.code === '23505' && r5.queued === false && (await pendingOpCount()) === 0)

  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nAll outbox invariants hold.')
})()
