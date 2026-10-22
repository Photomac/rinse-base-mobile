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
//   Except on a link that has stopped answering (netFetch linkAnswering():
//   one bar, no data). There a live write waited out the 30 s write deadline
//   before queuing, with the button's spinner up (Clock in, Pause, Complete),
//   so it queues at once and the flush sends it the moment anything gets
//   through. What lands is the same: every queued write is idempotent and
//   carries its own times (a punch is stamped at the tap).
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
// - One exception to "rejected = retry, then park": a queued clock-in on a
//   clean that the server refuses because the same person already has a
//   RUNNING entry there (unique index job_time_entries_one_open_per_job,
//   23505). They are on the clock; it was started twice. resolveWorkStart()
//   folds the queued one into the running one instead of parking it (and
//   stalling everything queued behind it for five flushes).
// - The same for a day: a queued "Start my day" that the server refuses
//   because a day shift is already open for that person (unique index
//   job_time_entries_one_open_shift, 23505). It is the same day started twice,
//   not a bad write, and parking it told the crew "your hours may be missing"
//   (CKS, 2026-10-10: two crew, both shifts running since 7 AM) and would also
//   strand the End my day queued behind it. resolveShiftStart() settles it.
// - And one more: a time-entry upsert refused with 42501 whose rows are
//   already on the server. The insert rule allows crew an entry only on a
//   clean they're assigned to (rinsebase-app #1487), and Postgres checks it
//   on the proposed row BEFORE ON CONFLICT finds the stored one. So a replay
//   whose ack was lost, after the office took the person off the clean, is
//   refused although its row landed the first time. alreadyStored() reads the
//   ids back; if every row is there the op was delivered and is dropped
//   quietly. A false "dropped" on the Profile screen invites the office to
//   "+ Add" the hours again, which pays them twice.
// - A queued Complete waits for its clean's photos (2026-10-16). The completion
//   gate (enforce_job_completion_gate) refuses a Complete whose photos have no
//   row yet, and photos upload on their own queue, so a Complete queued offline
//   could reach the server first: refused five times, it was parked, and the
//   clock-out queued before it had landed, leaving the clean open with its
//   crew clocked out. While photosAheadOfComplete() says photos are waiting, the
//   Complete is not sent and not counted as a rejection; ops for that clean
//   queued behind it wait with it, and everything else goes past in order. It
//   goes the moment the last photo lands. A photo the server keeps refusing
//   stops holding it (photoQueue.ts says when): the Complete goes and the server
//   decides, and the crew and the office are told the photos are failing.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { reportClientError } from './errorReporter'
import { photosAheadOfComplete, onPhotoQueueChange } from './photoQueue'
import { dayKey } from './timezone'
import { linkAnswering } from './netFetch'

const QUEUE_KEY = 'writeOutbox'
const REJECTED_KEY = 'writeOutboxRejected'
const ALIAS_KEY = 'writeOutboxShiftAliases'
const MAX_REJECTS = 5
const SIXTEEN_HOURS = 16 * 3600 * 1000
const ALIAS_TTL = 3 * 24 * 3600 * 1000

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
  /** upsert only: insert rows that don't exist yet and leave existing ones as
   *  they are (ON CONFLICT DO NOTHING). */
  ignoreDuplicates?: boolean
  /** Ops that only make sense together (a save's new rows, then the delete of
   *  the rows they replace). If one is parked after repeated rejections, the
   *  others still queued are parked with it rather than applied on their own. */
  group?: string
  created_at: number
  rejects?: number
  lastError?: string
  /** A Complete that went past photos the server keeps refusing (said once). */
  pastRefusedPhotos?: boolean
}

export type OutboxWrite = Pick<OutboxOp, 'table' | 'op' | 'match' | 'matchIn' | 'keep' | 'values' | 'onConflict' | 'ignoreDuplicates' | 'group'>

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
    const opts = w.onConflict || w.ignoreDuplicates
      ? { ...(w.onConflict ? { onConflict: w.onConflict } : {}), ...(w.ignoreDuplicates ? { ignoreDuplicates: true } : {}) }
      : undefined
    return await supabase.from(w.table).upsert(w.values, opts) as any
  }
  let q: any = w.op === 'delete' ? supabase.from(w.table).delete() : supabase.from(w.table).update(w.values)
  for (const [k, v] of Object.entries(w.match || {})) q = v === null ? q.is(k, null) : q.eq(k, v)
  for (const [k, v] of Object.entries(w.matchIn || {})) q = q.in(k, v)
  if (w.op === 'delete' && w.keep?.values.length) q = q.not(w.keep.column, 'in', `(${w.keep.values.join(',')})`)
  return await q
}

// ── A day shift started twice ────────────────────────────────────────────
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
  if (w.table !== 'job_time_entries' || w.op !== 'update' || Array.isArray(w.values)) return w
  const a = typeof w.match?.id === 'string' ? aliases[w.match.id] : undefined
  if (!a) return w
  const values: Record<string, any> = { ...w.values }
  if (values.clocked_out_at) values.duration_minutes = minutesBetween(a.clocked_in_at, values.clocked_out_at)
  return { ...w, match: { ...w.match, id: a.id }, values }
}

function isShiftStartConflict(op: OutboxOp, err: any): boolean {
  const v: any = op.values
  return op.table === 'job_time_entries' && op.op === 'upsert' && !Array.isArray(v)
    && v?.entry_type === 'shift' && !v?.clocked_out_at
    && err?.code === '23505'
}

/**
 * Settle a queued shift start X that the server refused because shift O is
 * already open for the same person. Never parks: each case keeps the hours.
 *  1. X was ended (End queued behind it) before O began: a whole earlier
 *     shift. Record it closed, which one-open-shift allows.
 *  2. X began on an earlier day and was never ended: forgotten. Close it the
 *     way the server does when the next day starts (close_forgotten_shift_on_
 *     new_day: at O's start, never past 16 h) and send its later writes to O,
 *     the day actually running.
 *  3. Same day: O is this start (a second tap, or the day was also started on
 *     the web). Keep the earlier of the two starts on O and send X's later
 *     writes to O.
 */
async function resolveShiftStart(op: OutboxOp): Promise<'resolved' | 'offline' | 'unresolved'> {
  const start: any = op.values
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
  const end: any = (await readQueue()).find(x => x.table === 'job_time_entries' && x.op === 'update'
    && x.match?.id === start.id && !Array.isArray(x.values) && x.values?.clocked_out_at)

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

  // Minutes count from the start O really has: X's, only once O took it.
  let startIso: string = open.clocked_in_at
  if (startMs < openMs) {
    const res: any = await supabase.from('job_time_entries')
      .update({ clocked_in_at: start.clocked_in_at }).eq('id', open.id).is('clocked_out_at', null)
    if (res.error && res.status === 0) return 'offline'
    if (!res.error) startIso = start.clocked_in_at
  }
  await saveAlias(start.id, { id: open.id, clocked_in_at: startIso })
  await writeQueue((await readQueue()).filter(x => x.id !== op.id))
  return 'resolved'
}

// ── A clean's clock started twice ────────────────────────────────────────
function isWorkStartConflict(op: OutboxOp, err: any): boolean {
  const v: any = op.values
  return op.table === 'job_time_entries' && op.op === 'upsert' && !Array.isArray(v)
    && !!v?.job_id && v?.entry_type !== 'shift' && !v?.clocked_out_at
    && err?.code === '23505'
}

/**
 * Settle a queued clock-in X refused because entry O is already running for
 * the same person on the same clean (the arrival auto clock-in, or a punch
 * from the web, landed while X sat in the queue). Never parks: the person IS
 * on the clock.
 *  - O keeps the earlier of the two starts (X's tap is evidence they were
 *    working by then).
 *  - Writes still queued for X (pause, clock out) go to O instead, minutes
 *    counted from O's start, because pay reads duration_minutes.
 * A screen still showing X picks up O on its next reload. A clock-out sent to
 * X before then matches no row; the job-close trigger closes O when the clean
 * is completed, as it does any entry left running.
 */
async function resolveWorkStart(op: OutboxOp): Promise<'resolved' | 'offline' | 'unresolved'> {
  const start: any = op.values
  const read: any = await supabase.from('job_time_entries')
    .select('id, clocked_in_at')
    .eq('job_id', start.job_id).eq('user_id', start.user_id).is('clocked_out_at', null)
    .limit(1)
  if (read.error) return read.status === 0 ? 'offline' : 'unresolved'
  const open = read.data?.[0]
  // Closed since the insert was refused: the next flush's insert goes through.
  if (!open) return 'unresolved'

  let startIso: string = open.clocked_in_at
  if (Date.parse(start.clocked_in_at) < Date.parse(open.clocked_in_at)) {
    const res: any = await supabase.from('job_time_entries')
      .update({ clocked_in_at: start.clocked_in_at }).eq('id', open.id).is('clocked_out_at', null)
    if (res.error && res.status === 0) return 'offline'
    if (!res.error) startIso = start.clocked_in_at
  }
  const minutes = (toIso: string) => Math.max(0, Math.round((Date.parse(toIso) - Date.parse(startIso)) / 60000))
  await writeQueue((await readQueue()).filter(x => x.id !== op.id).map(x => {
    if (x.table !== 'job_time_entries' || x.op !== 'update' || x.match?.id !== start.id) return x
    const values: any = { ...x.values }
    if (values.clocked_out_at) values.duration_minutes = minutes(values.clocked_out_at)
    return { ...x, match: { ...x.match, id: open.id }, values }
  }))
  return 'resolved'
}

// ── A delivered clock-in refused on replay ───────────────────────────────
function isRefusedTimeEntry(op: OutboxOp, err: any): boolean {
  return op.table === 'job_time_entries' && op.op === 'upsert' && err?.code === '42501'
}

/**
 * Are all the rows this upsert writes already stored? Then an earlier attempt
 * landed and only its answer was lost. Read by id: the read rule is the whole
 * company's, so the person can still see their entry on a clean they were
 * taken off. Anything short of every row is 'missing', and the op is counted
 * as a rejection like any other (a new clock-in there still parks and reports).
 */
async function alreadyStored(op: OutboxOp): Promise<'stored' | 'offline' | 'missing'> {
  const ids = (Array.isArray(op.values) ? op.values : [op.values]).map((v: any) => v?.id).filter(Boolean)
  if (!ids.length) return 'missing'
  const read: any = await supabase.from(op.table).select('id').in('id', ids)
  if (read.error) return read.status === 0 ? 'offline' : 'missing'
  const found = new Set((read.data ?? []).map((r: any) => r.id))
  return ids.every((id: string) => found.has(id)) ? 'stored' : 'missing'
}

// ── A Complete waits for its clean's photos ──────────────────────────────
/** The clean a write completes, or null when it isn't a Complete. */
function completesClean(w: OutboxWrite): string | null {
  const v: any = w.values
  if (w.table !== 'jobs' || w.op !== 'update' || Array.isArray(v) || v?.status !== 'completed') return null
  return typeof w.match?.id === 'string' ? w.match.id : null
}

/** The clean a write is for, where it says: a jobs row by id, or rows that
 *  carry job_id (time entries, ticks, supplies, reports). */
function cleanOf(w: OutboxWrite): string | null {
  if (w.table === 'jobs') return typeof w.match?.id === 'string' ? w.match.id : null
  const v: any = Array.isArray(w.values) ? w.values[0] : w.values
  if (typeof v?.job_id === 'string') return v.job_id
  return typeof w.match?.job_id === 'string' ? w.match.job_id : null
}

// The gate's photo blockers (job_completion_blockers): ones a photo still on
// the phone answers once it lands.
const PHOTO_BLOCKERS = ['no_after_photo', 'missing_required_photo', 'missing_required_area_photo', 'check_first_photo_missing']

/** The completion gate refused it for photos only ("RB_BLOCKED: [{code…}]"). */
function blockedForPhotosOnly(err: any): boolean {
  const msg = String(err?.message ?? '')
  if (!msg.startsWith('RB_BLOCKED: ')) return false
  try {
    const list = JSON.parse(msg.slice('RB_BLOCKED: '.length))
    return Array.isArray(list) && list.length > 0 && list.every((b: any) => PHOTO_BLOCKERS.includes(b?.code))
  } catch { return false }
}

/** Refused for photos that are still on this phone: it waits for them instead. */
async function refusedForPhotosOnPhone(w: OutboxWrite, err: any): Promise<boolean> {
  const job = completesClean(w)
  if (!job || !blockedForPhotosOnly(err)) return false
  return (await photosAheadOfComplete(job).catch(() => ({ waiting: 0 }))).waiting > 0
}

// Told when a queued Complete goes past photos the server keeps refusing
// (App.tsx shows the crew the "upload failed" alert). Once per Complete.
export interface CompletePastRefusedPhotos { jobId: string; refused: number; error: string | null }
const pastRefusedListeners = new Set<(e: CompletePastRefusedPhotos) => void>()
export function onCompletePastRefusedPhotos(fn: (e: CompletePastRefusedPhotos) => void): () => void {
  pastRefusedListeners.add(fn)
  return () => { pastRefusedListeners.delete(fn) }
}

let flushing = false
// Cleans whose Complete the latest flush held for photos. When one of their
// photos lands, the Complete goes now, not at the next trigger.
const waitingOnPhotos = new Set<string>()
let photoLandedMidFlush = false
onPhotoQueueChange(e => {
  if (!e.uploadedJobId || !waitingOnPhotos.has(e.uploadedJobId)) return
  if (flushing) photoLandedMidFlush = true
  else flushOutbox().catch(() => {})
})

/**
 * Perform a write now if possible, queue it if the network is down.
 * Returns { queued: true } when the op is safely on-device (treat as success —
 * keep the optimistic UI state); a non-null error is a real server answer.
 */
export async function writeThrough(write: OutboxWrite): Promise<{ error: any; queued: boolean }> {
  const w = retarget(write, await readAliases())
  if (w.op === 'delete' && !Object.keys(w.match || {}).length) {
    return { error: { message: 'outbox: refusing a delete with no filter' }, queued: false }
  }
  const pending = await readQueue()
  // Ordering: never let a live write overtake queued ops it depends on. And
  // on a link that has stopped answering, don't wait out the deadline first.
  if (pending.length || !(await linkAnswering())) {
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
  // A live Complete the gate refused for photos this phone is still sending
  // (its blocker check had no answer, so it was sent anyway): queued, it goes
  // after them. Any other refusal is the caller's to show, as before.
  if (await refusedForPhotosOnPhone(w, res.error)) {
    await enqueue(w)
    flushOutbox().catch(() => {})
    return { error: null, queued: true }
  }
  return { error: res.error, queued: false }
}

// Told after a flush that delivered queued writes and left nothing waiting:
// the phone is back on signal, so it is a good moment to re-read (the offline
// day pack listens, App.tsx).
const drainedListeners = new Set<() => void>()
export function onOutboxDrained(fn: () => void): () => void {
  drainedListeners.add(fn)
  return () => { drainedListeners.delete(fn) }
}

export async function flushOutbox(): Promise<void> {
  if (flushing) return
  flushing = true
  let sent = 0
  try {
    // Round again when a held Complete's photo landed during the pass.
    do {
      photoLandedMidFlush = false
      sent += await flushPass()
    } while (photoLandedMidFlush)
    if (sent && !(await readQueue()).length) {
      drainedListeners.forEach(fn => { try { fn() } catch { /* a listener's problem */ } })
    }
  } finally { flushing = false }
}

// One pass over the queue, oldest first. Returns how many ops it delivered.
async function flushPass(): Promise<number> {
  let sent = 0
  waitingOnPhotos.clear()
  while (true) {
    const q = await readQueue()
    // The oldest op not waiting on a clean's photos: the held Complete
    // itself, or an op for that clean queued behind it.
    const op = q.find(x => !waitingOnPhotos.has(cleanOf(x) ?? ''))
    if (!op) break
    const completes = completesClean(op)
    if (completes) {
      // A photo queue that can't be read holds nothing: the server decides.
      const photos = await photosAheadOfComplete(completes).catch(() => ({ waiting: 0, refused: 0, lastServerError: null }))
      if (photos.waiting > 0) { waitingOnPhotos.add(completes); continue }
      if (photos.refused > 0 && !op.pastRefusedPhotos) {
        await writeQueue((await readQueue()).map(x => x.id === op.id ? { ...x, pastRefusedPhotos: true } : x))
        reportClientError(
          `outbox: sent a queued Complete past ${photos.refused} photo${photos.refused > 1 ? 's' : ''} the server keeps refusing — ${photos.lastServerError ?? '?'}`,
          JSON.stringify({ id: op.id, job_id: completes }),
          'outbox',
        )
        const e: CompletePastRefusedPhotos = { jobId: completes, refused: photos.refused, error: photos.lastServerError }
        pastRefusedListeners.forEach(fn => { try { fn(e) } catch { /* a listener's problem */ } })
      }
    }
    const res = await applyOp(retarget(op, await readAliases()))
    if (!res.error) {
      await writeQueue((await readQueue()).filter(x => x.id !== op.id))
      sent++
      continue
    }
    if (res.status === 0) break // still offline — keep everything, retry later
    // A photo was queued between the check and the send: wait for it, uncounted.
    if (await refusedForPhotosOnPhone(op, res.error)) { waitingOnPhotos.add(completes!); continue }
    if (isShiftStartConflict(op, res.error)) {
      const settled = await resolveShiftStart(op)
      if (settled === 'resolved') { sent++; continue }
      if (settled === 'offline') break
      // 'unresolved' is counted like any rejection below, so a start that
      // somehow keeps losing still surfaces instead of looping forever.
    }
    if (isWorkStartConflict(op, res.error)) {
      const settled = await resolveWorkStart(op)
      if (settled === 'resolved') continue
      if (settled === 'offline') break
      // 'unresolved' is counted like any rejection below, so a start that
      // somehow keeps losing still surfaces instead of looping forever.
    }
    if (isRefusedTimeEntry(op, res.error)) {
      const seen = await alreadyStored(op)
      if (seen === 'stored') {
        await writeQueue((await readQueue()).filter(x => x.id !== op.id))
        sent++
        continue
      }
      if (seen === 'offline') break
    }
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
  return sent
}

export async function pendingOpCount(): Promise<number> {
  return (await readQueue()).length
}

/** A row this device created that is still waiting in the queue (e.g. a shift
 *  started offline that the server hasn't seen yet). */
export async function isQueued(table: string, id: string): Promise<boolean> {
  return (await readQueue()).some(o => o.table === table && o.op === 'upsert' && !Array.isArray(o.values) && o.values?.id === id)
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
  const aliases = await readAliases()
  const q = (await readQueue()).map(o => retarget(o, aliases))
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
        if (i >= 0) { if (!o.ignoreDuplicates) out[i] = { ...out[i], ...values } }
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
