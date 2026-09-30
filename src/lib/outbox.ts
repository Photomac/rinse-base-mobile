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
//   op can't dam the queue forever.
// - The outbox is NOT cleared on sign-out (unlike the read caches): queued ops
//   are unpaid time entries, and RLS rejects them anyway if a different
//   account replays them.
// - One exception to "rejected = retry, then park": a queued "Start my day"
//   that the server refuses because a day shift is already open for that
//   person (unique index job_time_entries_one_open_shift, 23505). That is not
//   a bad write, it is the same day started twice, and parking it would also
//   strand the End my day queued behind it. resolveShiftStart() settles it.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { reportClientError } from './errorReporter'
import { dayKey } from './timezone'

const QUEUE_KEY = 'writeOutbox'
const REJECTED_KEY = 'writeOutboxRejected'
const ALIAS_KEY = 'writeOutboxShiftAliases'
const MAX_REJECTS = 5
const SIXTEEN_HOURS = 16 * 3600 * 1000
const ALIAS_TTL = 3 * 24 * 3600 * 1000

export interface OutboxOp {
  id: string
  table: string
  op: 'upsert' | 'update'
  /** update only: equality filters (null values match with IS NULL) */
  match?: Record<string, any>
  values: Record<string, any>
  /** upsert only: conflict target, e.g. 'id' or 'job_id,task,room' */
  onConflict?: string
  created_at: number
  rejects?: number
  lastError?: string
}

export type OutboxWrite = Pick<OutboxOp, 'table' | 'op' | 'match' | 'values' | 'onConflict'>

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
  let q: any = supabase.from(w.table).update(w.values)
  for (const [k, v] of Object.entries(w.match || {})) q = v === null ? q.is(k, null) : q.eq(k, v)
  return await q
}

// ── Day shifts started twice ─────────────────────────────────────────────
// When a queued shift start X loses to a shift O already open on the server,
// X's id never reaches the server. Anything aimed at X afterwards (End my day,
// queued behind it or tapped later from a screen still showing X) is sent to
// O instead. Kept on-device for a few days; ids are client-minted uuids.
type ShiftAlias = { id: string; clocked_in_at: string; at: number }

async function readAliases(): Promise<Record<string, ShiftAlias>> {
  try { const raw = await AsyncStorage.getItem(ALIAS_KEY); return raw ? JSON.parse(raw) : {} }
  catch { return {} }
}

async function saveAlias(fromId: string, to: { id: string; clocked_in_at: string }): Promise<void> {
  const all = await readAliases()
  const now = Date.now()
  for (const k of Object.keys(all)) if (now - all[k].at > ALIAS_TTL) delete all[k]
  all[fromId] = { id: to.id, clocked_in_at: to.clocked_in_at, at: now }
  try { await AsyncStorage.setItem(ALIAS_KEY, JSON.stringify(all)) } catch { /* best effort */ }
}

const minutesBetween = (fromIso: string, toIso: string) =>
  Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000))

// Point a write at the shift that is really running; its minutes count from
// that shift's start (pay reads duration_minutes, not the timestamps).
function retarget<W extends OutboxWrite>(w: W, aliases: Record<string, ShiftAlias>): W {
  if (w.table !== 'job_time_entries' || w.op !== 'update') return w
  const a = w.match?.id ? aliases[w.match.id] : undefined
  if (!a) return w
  const values = { ...w.values }
  if (values.clocked_out_at) values.duration_minutes = minutesBetween(a.clocked_in_at, values.clocked_out_at)
  return { ...w, match: { ...w.match, id: a.id }, values }
}

function isShiftStartConflict(op: OutboxOp, err: any): boolean {
  return op.table === 'job_time_entries' && op.op === 'upsert'
    && op.values?.entry_type === 'shift' && !op.values?.clocked_out_at
    && err?.code === '23505'
}

/**
 * Settle a queued shift start X that the server refused because shift O is
 * already open for the same person. Never parks: each case keeps the hours.
 *  1. X was ended (End queued behind it) before O began: a whole earlier
 *     shift. Record it closed, which one-open-shift allows.
 *  2. X began on an earlier day and was never ended: forgotten. Close it the
 *     way the server does when the next day starts (at O's start, never past
 *     16 h) and send its later writes to O, the day actually running.
 *  3. Same day: O is this start (a second tap, or the day was also started on
 *     the web). Keep the earlier of the two starts on O and send X's later
 *     writes to O.
 */
async function resolveShiftStart(op: OutboxOp): Promise<'resolved' | 'offline' | 'unresolved'> {
  const start = op.values
  const read: any = await supabase.from('job_time_entries')
    .select('id, clocked_in_at')
    .eq('user_id', start.user_id).eq('entry_type', 'shift').is('clocked_out_at', null)
    .order('clocked_in_at', { ascending: false }).limit(1)
  if (read.error) return read.status === 0 ? 'offline' : 'unresolved'
  const open = read.data?.[0]
  // Ended since the insert was refused: the next flush's insert goes through.
  if (!open) return 'unresolved'

  const startMs = Date.parse(start.clocked_in_at)
  const openMs = Date.parse(open.clocked_in_at)
  const end = (await readQueue()).find(x => x.table === 'job_time_entries' && x.op === 'update'
    && x.match?.id === start.id && x.values?.clocked_out_at)

  if (end && Date.parse(end.values.clocked_out_at) <= openMs) {
    const res: any = await supabase.from('job_time_entries').upsert({
      ...start,
      clocked_out_at: end.values.clocked_out_at,
      duration_minutes: end.values.duration_minutes ?? minutesBetween(start.clocked_in_at, end.values.clocked_out_at),
    }, { onConflict: 'id' })
    if (res.error) return res.status === 0 ? 'offline' : 'unresolved'
    await writeQueue((await readQueue()).filter(x => x.id !== op.id && x.id !== end.id))
    return 'resolved'
  }

  if (startMs < openMs && (dayKey(start.clocked_in_at) !== dayKey(open.clocked_in_at) || openMs - startMs >= SIXTEEN_HOURS)) {
    const closedAt = new Date(Math.min(openMs, startMs + SIXTEEN_HOURS)).toISOString()
    const res: any = await supabase.from('job_time_entries').upsert({
      ...start,
      clocked_out_at: closedAt,
      duration_minutes: minutesBetween(start.clocked_in_at, closedAt),
      edited_at: new Date().toISOString(),
      pause_reason: 'Auto-closed: a new day was started',
    }, { onConflict: 'id' })
    if (res.error) return res.status === 0 ? 'offline' : 'unresolved'
    await saveAlias(start.id, open)
    await writeQueue((await readQueue()).filter(x => x.id !== op.id))
    return 'resolved'
  }

  if (startMs < openMs) {
    const res: any = await supabase.from('job_time_entries')
      .update({ clocked_in_at: start.clocked_in_at }).eq('id', open.id).is('clocked_out_at', null)
    if (res.error && res.status === 0) return 'offline'
  }
  await saveAlias(start.id, { id: open.id, clocked_in_at: startMs < openMs ? start.clocked_in_at : open.clocked_in_at })
  await writeQueue((await readQueue()).filter(x => x.id !== op.id))
  return 'resolved'
}

/**
 * Perform a write now if possible, queue it if the network is down.
 * Returns { queued: true } when the op is safely on-device (treat as success —
 * keep the optimistic UI state); a non-null error is a real server answer.
 */
export async function writeThrough(write: OutboxWrite): Promise<{ error: any; queued: boolean }> {
  const w = retarget(write, await readAliases())
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
      const res = await applyOp(retarget(op, await readAliases()))
      if (!res.error) {
        await writeQueue((await readQueue()).filter(x => x.id !== op.id))
        continue
      }
      if (res.status === 0) break // still offline — keep everything, retry later
      if (isShiftStartConflict(op, res.error)) {
        const settled = await resolveShiftStart(op)
        if (settled === 'resolved') continue
        if (settled === 'offline') break
        // 'unresolved' is counted like any rejection below, so a start that
        // somehow keeps losing still surfaces instead of looping forever.
      }
      const rejects = (op.rejects || 0) + 1
      const msg = String(res.error?.message || res.error)
      const cur = await readQueue()
      if (rejects >= MAX_REJECTS) {
        console.warn('outbox: dropping op after repeated server rejections', op.table, msg)
        // A parked op may be somebody's pay, and the crew was told "queued" —
        // it must not vanish into a list nothing reads. Report it to
        // admin_error_log (admin System Health) and leave it visible on the
        // crew's Profile screen via rejectedOps() until dismissed.
        reportClientError(
          `outbox: dropped ${op.op} on ${op.table} after ${rejects} rejections — ${msg}`,
          JSON.stringify({ id: op.id, values: op.values, match: op.match }).slice(0, 2000),
          'outbox',
        )
        await appendRejected({ ...op, rejects, lastError: msg })
        await writeQueue(cur.filter(x => x.id !== op.id))
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

/** A row this device created that is still waiting in the queue (e.g. a shift
 *  started offline that the server hasn't seen yet). */
export async function isQueued(table: string, id: string): Promise<boolean> {
  return (await readQueue()).some(o => o.table === table && o.op === 'upsert' && o.values?.id === id)
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
 * pass the same scoping their query used. Update-op match keys that a row
 * doesn't carry are treated as matching (callers pass rows already scoped to
 * the entity the op targets).
 */
export async function overlayPending(
  table: string,
  rows: any[],
  includeUpsert?: (values: Record<string, any>) => boolean,
): Promise<any[]> {
  const aliases = await readAliases()
  const q = (await readQueue()).map(o => retarget(o, aliases))
  let out = rows.slice()
  for (const o of q) {
    if (o.table !== table) continue
    if (o.op === 'upsert') {
      if (includeUpsert && !includeUpsert(o.values)) continue
      const keys = (o.onConflict || 'id').split(',')
      const i = out.findIndex(r => keys.every(k => (k in r ? r[k] === o.values[k] : true)))
      if (i >= 0) out[i] = { ...out[i], ...o.values }
      else out.push({ ...o.values })
    } else {
      out = out.map(r => {
        const m = Object.entries(o.match || {}).every(([k, v]) => (k in r ? r[k] === v : true))
        return m ? { ...r, ...o.values } : r
      })
    }
  }
  return out
}
