// Offline write outbox — Phase 3 of offline support (1: profileCache, 2: dataCache).
//
// Crews in dead zones can clock in/out, pause/resume, tick checklists, and
// complete jobs; the writes queue on-device and replay in order when signal
// returns. Modeled on photoQueue: AsyncStorage-backed FIFO, flushed on app
// foreground, screen loads, and every subsequent write attempt.
//
// Correctness rules:
// - Every queued INSERT is an UPSERT with a client-generated uuid, so a replay
//   that half-succeeded (row landed, ack lost) can never double-insert — and a
//   time entry IS the crew member's pay, so double or lost rows are the two
//   failure modes this file exists to prevent.
// - writeThrough() tries the LIVE write first and queues only on a network
//   failure (postgrest status 0 — a real server answer like an RLS denial is
//   returned to the caller as an error, same as before this file existed).
//   If ops are already queued, new writes queue BEHIND them instead of writing
//   live: a pause must never land before the clock-in it pauses.
// - Replay is strict FIFO for the same reason. A server-rejected op is retried
//   across MAX_REJECTS flushes, then moved to a rejected list so one poisoned
//   op can't dam the queue forever. Ops sharing a `group` park together.
// - A delete is idempotent by nature, but must name what it deletes: one with
//   no filter is refused outright.
// - The outbox is NOT cleared on sign-out (unlike the read caches): queued ops
//   are unpaid time entries, and RLS rejects them anyway if a different
//   account replays them.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { reportClientError } from './errorReporter'

const QUEUE_KEY = 'writeOutbox'
const REJECTED_KEY = 'writeOutboxRejected'
const MAX_REJECTS = 5

export interface OutboxOp {
  id: string
  table: string
  op: 'upsert' | 'update' | 'delete'
  /** update/delete: equality filters (null values match with IS NULL).
   *  A delete must have at least one — "delete everything I can see" is refused. */
  match?: Record<string, any>
  /** update/delete: column IN (values) filters. For writes that must only land
   *  while a row is still in an expected state — a replayed "start" must never
   *  pull a clean that was completed in the meantime back to in progress. */
  matchIn?: Record<string, any[]>
  /** delete only: spare the rows whose `column` is in `values` (e.g. the ids
   *  just upserted by the same save). */
  keep?: { column: string; values: string[] }
  /** upsert: one row or several (sent as one request); update: the new
   *  values; delete: unused ({}). */
  values: Record<string, any> | Record<string, any>[]
  /** upsert only: conflict target, e.g. 'id' or 'job_id,task,room' */
  onConflict?: string
  /** Ops that only make sense together (a save's new rows, then the delete of
   *  the rows they replace). If one is parked after repeated rejections, the
   *  others still queued are parked with it rather than applied on their own. */
  group?: string
  created_at: number
  rejects?: number
  lastError?: string
}

export type OutboxWrite = Pick<OutboxOp, 'table' | 'op' | 'match' | 'matchIn' | 'keep' | 'values' | 'onConflict' | 'group'>

// RFC-4122-shaped v4 from Math.random — no crypto dep (OTA-safe). These ids
// only need uniqueness for idempotent replay, not unguessability.
export function uuid4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

async function readQueue(): Promise<OutboxOp[]> {
  try { const raw = await AsyncStorage.getItem(QUEUE_KEY); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}

async function writeQueue(q: OutboxOp[]): Promise<void> {
  try { await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q)) } catch { /* best effort */ }
}

async function appendRejected(op: OutboxOp): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(REJECTED_KEY)
    const list = raw ? JSON.parse(raw) : []
    list.push(op)
    await AsyncStorage.setItem(REJECTED_KEY, JSON.stringify(list.slice(-50)))
  } catch { /* best effort */ }
}

async function enqueue(w: OutboxWrite): Promise<void> {
  const q = await readQueue()
  q.push({ ...w, id: uuid4(), created_at: Date.now() })
  await writeQueue(q)
}

async function applyOp(w: OutboxWrite): Promise<{ error: any; status?: number }> {
  if (w.op === 'upsert') {
    return await supabase.from(w.table).upsert(w.values, w.onConflict ? { onConflict: w.onConflict } : undefined) as any
  }
  let q: any = w.op === 'delete' ? supabase.from(w.table).delete() : supabase.from(w.table).update(w.values)
  for (const [k, v] of Object.entries(w.match || {})) q = v === null ? q.is(k, null) : q.eq(k, v)
  for (const [k, v] of Object.entries(w.matchIn || {})) q = q.in(k, v)
  if (w.op === 'delete' && w.keep?.values.length) q = q.not(w.keep.column, 'in', `(${w.keep.values.join(',')})`)
  return await q
}

/**
 * Perform a write now if possible, queue it if the network is down.
 * Returns { queued: true } when the op is safely on-device (treat as success —
 * keep the optimistic UI state); a non-null error is a real server answer.
 */
export async function writeThrough(w: OutboxWrite): Promise<{ error: any; queued: boolean }> {
  if (w.op === 'delete' && !Object.keys(w.match || {}).length) {
    return { error: { message: 'outbox: refusing a delete with no filter' }, queued: false }
  }
  const pending = await readQueue()
  if (pending.length) {
    // Ordering: never let a live write overtake queued ops it depends on.
    await enqueue(w)
    flushOutbox().catch(() => {})
    return { error: null, queued: true }
  }
  const res = await applyOp(w)
  if (!res.error) return { error: null, queued: false }
  if (res.status === 0) {
    await enqueue(w)
    return { error: null, queued: true }
  }
  return { error: res.error, queued: false }
}

let flushing = false
export async function flushOutbox(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    while (true) {
      const q = await readQueue()
      if (!q.length) break
      const op = q[0]
      const res = await applyOp(op)
      if (!res.error) {
        await writeQueue((await readQueue()).filter(x => x.id !== op.id))
        continue
      }
      if (res.status === 0) break // still offline — keep everything, retry later
      const rejects = (op.rejects || 0) + 1
      const msg = String(res.error?.message || res.error)
      const cur = await readQueue()
      if (rejects >= MAX_REJECTS) {
        console.warn('outbox: dropping op after repeated server rejections', op.table, msg)
        // Ops grouped with it assume it landed (a delete of the rows it was
        // replacing): applying them alone would lose data, so they park too.
        const groupMates = op.group ? cur.filter(x => x.group === op.group && x.id !== op.id) : []
        // A parked op may be somebody's pay, and the crew was told "queued" —
        // it must not vanish into a list nothing reads. Report it to
        // admin_error_log (admin System Health) and leave it visible on the
        // crew's Profile screen via rejectedOps() until dismissed.
        reportClientError(
          `outbox: dropped ${op.op} on ${op.table} after ${rejects} rejections — ${msg}` +
            (groupMates.length ? ` (+${groupMates.length} grouped op${groupMates.length > 1 ? 's' : ''} parked with it)` : ''),
          JSON.stringify({ id: op.id, values: op.values, match: op.match }).slice(0, 2000),
          'outbox',
        )
        await appendRejected({ ...op, rejects, lastError: msg })
        for (const mate of groupMates) await appendRejected({ ...mate, lastError: `parked with ${op.op} on ${op.table}: ${msg}` })
        const parked = new Set([op.id, ...groupMates.map(x => x.id)])
        await writeQueue(cur.filter(x => !parked.has(x.id)))
        continue
      }
      await writeQueue(cur.map(x => x.id === op.id ? { ...x, rejects, lastError: msg } : x))
      break // strict FIFO: don't let later ops overtake; retry next flush
    }
  } finally { flushing = false }
}

export async function pendingOpCount(): Promise<number> {
  return (await readQueue()).length
}

/** Ops dropped after MAX_REJECTS — surfaced on the Profile screen. */
export async function rejectedOps(): Promise<OutboxOp[]> {
  try { const raw = await AsyncStorage.getItem(REJECTED_KEY); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}

/** Crew acknowledged the failures (after telling the office). */
export async function clearRejected(): Promise<void> {
  try { await AsyncStorage.removeItem(REJECTED_KEY) } catch { /* best effort */ }
}

/**
 * Merge pending ops into rows read from cache/server, so a relaunch mid-outage
 * still shows queued state (the tick you made, the clock-in that's queued).
 * `includeUpsert` gates which queued upserts belong in this row set — callers
 * pass the same scoping their query used. Update- and delete-op match keys
 * that a row doesn't carry are treated as matching (callers pass rows already
 * scoped to the entity the op targets). A queued delete removes the rows it
 * matches, sparing its `keep` list.
 */
export async function overlayPending(
  table: string,
  rows: any[],
  includeUpsert?: (values: Record<string, any>) => boolean,
): Promise<any[]> {
  const q = await readQueue()
  let out = rows.slice()
  const matches = (r: any, match?: Record<string, any>, matchIn?: Record<string, any[]>) =>
    Object.entries(match || {}).every(([k, v]) => (k in r ? r[k] === v : true)) &&
    Object.entries(matchIn || {}).every(([k, v]) => (k in r ? v.includes(r[k]) : true))
  for (const o of q) {
    if (o.table !== table) continue
    if (o.op === 'upsert') {
      const keys = (o.onConflict || 'id').split(',')
      for (const values of Array.isArray(o.values) ? o.values : [o.values]) {
        if (includeUpsert && !includeUpsert(values)) continue
        const i = out.findIndex(r => keys.every(k => (k in r ? r[k] === values[k] : true)))
        if (i >= 0) out[i] = { ...out[i], ...values }
        else out.push({ ...values })
      }
    } else if (o.op === 'delete') {
      const kept = new Set(o.keep?.values ?? [])
      out = out.filter(r => !(matches(r, o.match, o.matchIn) && !(o.keep && kept.has(r[o.keep.column]))))
    } else {
      out = out.map(r => (matches(r, o.match, o.matchIn) ? { ...r, ...(o.values as Record<string, any>) } : r))
    }
  }
  return out
}
