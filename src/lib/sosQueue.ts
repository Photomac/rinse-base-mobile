// src/lib/sosQueue.ts
// Durable delivery for the SOS button.
//
// Until 2026-09-28 SOSScreen showed "ALERT SENT" before anything touched the
// network, then fired the sos_alerts insert and the office push without
// checking either one. In a dead zone the crew member read "your owner and
// manager have been notified" while nothing had left the phone, and nothing
// ever retried. Several customers clean where there is no signal at all
// (Sedona canyons, Big Bear, Port O'Connor).
//
// Now the alert is written to this phone first, then delivered, then pushed to
// the office, and the screen may only say "sent" once the server has answered
// for the row.
//
// Why not outbox.ts: the outbox is strict FIFO and queues new writes behind
// pending ones. That is right for pay (a pause must never land before its
// clock-in) and wrong here. An SOS depends on nothing queued ahead of it, and
// behind one server-rejected time entry it would wait out MAX_REJECTS flushes
// (about ten minutes at the 2-minute drain) with full signal. So the SOS keeps
// its own queue, is always tried live, and never waits behind other work.
//
// Rules:
// - The alert id is minted here and the insert is ON CONFLICT (id) DO NOTHING,
//   so a replay after a lost acknowledgement can never raise a second alert.
// - "Landed" means the insert came back without an error. It is the only state
//   the screen may call sent.
// - The office is told by the SERVER once the row lands: a trigger on the
//   insert runs notify-sos, which pushes, texts and emails every owner,
//   manager and dispatcher and writes who it reached onto the alert row
//   (office_notified_at + counts). The phone reads that back to say who knows.
// - If the server hasn't reported within SERVER_GRACE_MS, or isn't installed
//   (no office_* columns), the phone pushes the office itself, from whichever
//   path gets there (the SOS screen's retry loop, the app-wide drain, or the
//   SOS location task in the background), and records it so a later flush
//   doesn't repeat it. A crash between that push and the record can repeat it
//   once; a duplicate SOS push is the acceptable failure, a missing one is not.
// - Every request has a timeout. React Native's fetch has none on Android, and
//   one stalled request on a weak bar would otherwise hold the queue forever
//   (the photo queue's 2026-09-23 lesson).
// - An SOS is never given up on. A server rejection is reported once and
//   retried on every flush; only the crew member's "I'm OK" removes it. The
//   same goes for the "I'm OK" itself.
// - "I'm OK" is durable too. An alert cancelled before its first attempt never
//   leaves the phone; one that may have reached the server is marked
//   false_alarm (queued if there's no signal); a cancelled alert is never
//   pushed to the office.
// - One storage key per alert, and a failed read never leads to a write. With
//   one shared list, a single failed read (Android can fail one under memory
//   pressure) would be written back empty and lose every queued alert.
// - Not cleared on sign-out, same as the outbox.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { uuid4 } from './outbox'
import { reportClientError } from './errorReporter'

const PREFIX = 'sosAlert.v1:'
// Generous for a few hundred bytes on one bar, and a hard cap on anything the
// client does before the request, like refreshing an expired login.
const REQUEST_TIMEOUT_MS = 20_000
// The screen says "Sending…" only this long. Past it with no answer, the alert
// has not reached anyone as far as anyone knows, and saying so matters more
// than waiting out a slow attempt.
export const SENDING_GRACE_MS = 5_000
// A finished alert stays on the phone this long, so the screen that raised it
// can still read its final state. Same cap as the location trail.
const KEEP_DONE_MS = 4 * 60 * 60 * 1000
const MAX_PUSH_ERRORS = 5
// How long the phone waits for the server's fan-out to report on the row
// before pushing the office itself. The server normally reports in seconds.
const SERVER_GRACE_MS = 30_000
// An alert that sat on the phone longer than this says so in the office push.
const LATE_AFTER_MS = 2 * 60 * 1000
const DISPATCH_ROLES = ['owner', 'manager', 'dispatcher']
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

export interface QueuedSOS {
  id: string                  // sos_alerts.id, minted on this phone
  tenant_id: string
  user_id: string
  crew_name: string
  triggered_at: string        // when the hold completed, ISO
  lat: number | null
  lng: number | null
  coords_pending: boolean     // the row went out without the latest fix
  attempts: number            // inserts started; a started one may have landed
  last_error: string | null
  last_error_kind: 'network' | 'server' | null
  reported: boolean           // first server rejection went to admin_error_log
  landed_at: number | null    // the server answered for the row
  push: 'pending' | 'sent' | 'failed'
  push_by: 'server' | 'phone' | null
  push_recipients: number | null  // office phones reached by push; 0 = nobody gets app alerts
  office: { push: number; sms: number; email: number } | null  // what the server reported reaching
  push_errors: number
  cancelled_at: number | null     // the crew member tapped "I'm OK"
  cancel_synced: boolean          // the server has the false_alarm, or never had the alert
  cancel_reported: boolean        // first server refusal of the cancel went to admin_error_log
}

export type SOSDeliveryState = 'sending' | 'offline' | 'refused' | 'sent'

/** What the SOS screen may claim. Only a landed row is "sent". */
export function sosDeliveryState(e: QueuedSOS, now = Date.now()): SOSDeliveryState {
  if (e.landed_at) return 'sent'
  if (e.last_error_kind === 'server') return 'refused'
  if (e.last_error_kind === 'network') return 'offline'
  return now - Date.parse(e.triggered_at) > SENDING_GRACE_MS ? 'offline' : 'sending'
}

// ── Storage ─────────────────────────────────────────────────────────────────
// The latest copy of any alert that storage refused to take (a full phone).
// Reads prefer it and every flush retries the write, so an SOS still goes out
// while the app is running instead of vanishing with the failed write.
const unsaved = new Map<string, QueuedSOS>()
const keyOf = (id: string) => PREFIX + id

// Throws when storage can't be read, so nothing is written from a bad read.
async function readEntry(id: string): Promise<QueuedSOS | null> {
  const mem = unsaved.get(id)
  if (mem) return { ...mem }
  const raw = await AsyncStorage.getItem(keyOf(id))
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null } // an unreadable copy can't be recovered
}

async function writeEntry(e: QueuedSOS): Promise<void> {
  try { await AsyncStorage.setItem(keyOf(e.id), JSON.stringify(e)); unsaved.delete(e.id) }
  catch { unsaved.set(e.id, { ...e }) }
}

async function removeEntry(id: string): Promise<void> {
  unsaved.delete(id)
  try { await AsyncStorage.removeItem(keyOf(id)) } catch { /* a finished alert left behind is harmless */ }
}

// Throws when storage can't be read.
async function readAll(): Promise<QueuedSOS[]> {
  const ids = new Set((await AsyncStorage.getAllKeys()).filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)))
  for (const id of unsaved.keys()) ids.add(id)
  const out: QueuedSOS[] = []
  for (const id of ids) { const e = await readEntry(id); if (e) out.push(e) }
  return out
}

type Listener = () => void
const listeners = new Set<Listener>()

/** Called after every change and when a flush starts or ends. */
export function onSOSChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit() {
  for (const fn of [...listeners]) {
    try { fn() } catch { /* a screen's listener must never break delivery */ }
  }
}

// Every change goes through this chain, one at a time: a cancel that lands
// while a flush is waiting on the network can't be written over by the flush's
// older copy of the alert.
let chain: Promise<unknown> = Promise.resolve()
function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work)
  chain = run.catch(() => {})
  return run.finally(emit)
}

// Read, edit, write one alert. Resolves false when it isn't on the phone;
// rejects without writing when storage can't be read.
function patch(id: string, edit: (e: QueuedSOS) => void): Promise<boolean> {
  return serially(async () => {
    const e = await readEntry(id)
    if (!e) return false
    edit(e)
    await writeEntry(e)
    return true
  })
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record an SOS on this phone. Resolves once it is stored (or held in memory
 * if storage refused it), before any network call. Never rejects. Call
 * flushSOSQueue() to deliver it.
 */
export async function raiseSOS(input: {
  tenant_id: string
  user_id: string
  crew_name: string
  lat: number | null
  lng: number | null
}): Promise<QueuedSOS> {
  const entry: QueuedSOS = {
    id: uuid4(),
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    crew_name: input.crew_name,
    triggered_at: new Date().toISOString(),
    lat: input.lat,
    lng: input.lng,
    coords_pending: false,
    attempts: 0,
    last_error: null,
    last_error_kind: null,
    reported: false,
    landed_at: null,
    push: 'pending',
    push_by: null,
    push_recipients: null,
    office: null,
    push_errors: 0,
    cancelled_at: null,
    cancel_synced: false,
    cancel_reported: false,
  }
  // A new alert is written whole, never read-edited, so no storage failure
  // can take it or any other alert down with it.
  await serially(() => writeEntry(entry)).catch(() => {})
  return { ...entry }
}

/** Rejects when storage can't be read; callers keep what they last showed. */
export async function getSOS(id: string): Promise<QueuedSOS | null> {
  return readEntry(id)
}

/**
 * The newest alert this user raised that hasn't reached the server and wasn't
 * cancelled. The app reopens the SOS screen on it after a restart, and the
 * screen resumes it instead of raising a second one.
 */
export async function resumableSOS(userId: string): Promise<QueuedSOS | null> {
  const open = (await readAll()).filter(e => e.user_id === userId && !e.cancelled_at && !e.landed_at)
  open.sort((a, b) => Date.parse(b.triggered_at) - Date.parse(a.triggered_at))
  return open[0] ?? null
}

/** A fix that arrives after the press still gets to the office. */
export async function updateSOSLocation(id: string, lat: number, lng: number): Promise<void> {
  await patch(id, e => {
    if (e.cancelled_at || (e.lat === lat && e.lng === lng)) return
    e.lat = lat
    e.lng = lng
    // Once an insert has gone out, a retry can't carry this (it's a no-op if
    // the first one landed), so the row gets it in a follow-up update.
    if (e.attempts > 0 || e.landed_at) e.coords_pending = true
  })
}

/** False while this phone still holds the alert undelivered, or can't tell. */
export async function sosLanded(id: string): Promise<boolean> {
  try { const e = await readEntry(id); return !e || !!e.landed_at } catch { return false }
}

/**
 * The crew member is OK. Resolves once the cancel reached the server or the
 * attempt failed; it stays queued until it does reach it. `lastKnown` is the
 * screen's own copy, used if this phone no longer holds the alert (a delivered
 * one is pruned after KEEP_DONE_MS) or storage can't be read right now.
 */
export async function cancelSOS(id: string, lastKnown?: QueuedSOS | null): Promise<void> {
  await serially(async () => {
    let e: QueuedSOS | null = null
    try { e = await readEntry(id) } catch { /* unreadable: fall back below */ }
    if (!e && lastKnown?.id === id) e = { ...lastKnown }
    if (!e || e.cancelled_at) return
    e.cancelled_at = Date.now()
    // Never sent anywhere, so there is nothing on the server to take back.
    if (e.attempts === 0 && !e.landed_at) e.cancel_synced = true
    await writeEntry(e)
  }).catch(() => {})
  await flushSOSQueue()
}

let current: Promise<void> | null = null
let rerun = false

export function isSOSFlushing(): boolean {
  return current !== null
}

// Most urgent first: an alert nobody has yet, then its push, then taking back
// a cancelled one, then a late GPS fix. Newest first within each.
function rank(e: QueuedSOS): number {
  if (e.cancelled_at) return e.cancel_synced ? 9 : 2
  if (!e.landed_at) return 0
  if (e.push === 'pending') return 1
  return e.coords_pending ? 3 : 9
}

/**
 * Deliver whatever is queued. Safe to call from anywhere, as often as you
 * like: a call during a flush waits for that flush plus one more pass, so a
 * cancel made mid-flush is always handled before the promise resolves.
 */
export function flushSOSQueue(): Promise<void> {
  if (current) { rerun = true; return current }
  const run = (async () => {
    await Promise.resolve() // `current` is set before listeners hear the flush started
    emit()
    try {
      do {
        rerun = false
        // Retry writes storage refused, reading the copy inside the chain so a
        // newer one can't be overwritten by this retry.
        for (const id of [...unsaved.keys()]) {
          await serially(async () => { const e = unsaved.get(id); if (e) await writeEntry(e) }).catch(() => {})
        }
        let queue: QueuedSOS[]
        try { queue = await readAll() } catch { break } // storage unreadable: next flush
        queue = queue.filter(e => rank(e) < 9)
          .sort((a, b) => rank(a) - rank(b) || Date.parse(b.triggered_at) - Date.parse(a.triggered_at))
        for (const e of queue) {
          let result: 'ok' | 'network' = 'ok'
          try { result = await advance(e.id) }
          catch (err) { console.warn('sos: delivery step failed', err) } // one alert must not block another
          // No signal: the rest would only time out too. The next pass starts
          // again from the most urgent.
          if (result === 'network') break
        }
        await prune()
      } while (rerun)
    } finally {
      current = null
      emit()
    }
  })()
  current = run
  return run
}

// ── Delivery ────────────────────────────────────────────────────────────────

const TIMED_OUT = Symbol('timed out')

async function withTimeout<T>(run: (signal: AbortSignal) => PromiseLike<T>): Promise<T | typeof TIMED_OUT> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => { ctl.abort(); resolve(TIMED_OUT) }, REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([Promise.resolve(run(ctl.signal)), expired])
  } finally {
    clearTimeout(timer)
  }
}

interface RestResult { error: any; status: number; data?: any }

// postgrest-js answers a failed fetch with { error, status: 0 } instead of
// throwing; a timeout is made to look the same, because to the crew member it
// is the same thing.
async function rest(run: (signal: AbortSignal) => PromiseLike<any>): Promise<RestResult> {
  try {
    const r = await withTimeout(run)
    if (r === TIMED_OUT) return { error: { message: 'timed out' }, status: 0 }
    return r as RestResult
  } catch (e: any) {
    return { error: { message: String(e?.message || e) }, status: 0 }
  }
}

// Walk one alert forward as far as the network allows. Re-reads between steps:
// a cancel or a GPS fix can arrive while a request is out.
async function advance(id: string): Promise<'ok' | 'network'> {
  let e = await readEntry(id)
  if (!e) return 'ok'
  if (e.cancelled_at) return e.cancel_synced ? 'ok' : syncCancel(e)
  if (!e.landed_at) {
    const r = await tryInsert(e)
    if (r === 'network') return 'network'
    if (r === 'refused') return 'ok'
    e = await readEntry(id)
    if (!e) return 'ok'
    if (e.cancelled_at) return e.cancel_synced ? 'ok' : syncCancel(e)
  }
  if (e.push === 'pending') {
    if ((await tryPush(e)) === 'network') return 'network'
    e = await readEntry(id)
    if (!e || e.cancelled_at) return 'ok' // a cancel from the push step waits for the next pass
  }
  return e.coords_pending ? syncCoords(e) : 'ok'
}

function alertRow(e: QueuedSOS, status: 'active' | 'false_alarm') {
  return {
    id: e.id,
    tenant_id: e.tenant_id,
    user_id: e.user_id,
    triggered_at: e.triggered_at,
    lat: e.lat,
    lng: e.lng,
    status,
    ...(status === 'false_alarm' ? { resolved_at: new Date(e.cancelled_at ?? Date.now()).toISOString() } : {}),
  }
}

// 'landed', or 'skipped' when a cancel or another path got there first.
async function tryInsert(e: QueuedSOS): Promise<'landed' | 'skipped' | 'network' | 'refused'> {
  // Counted before the request goes out: from here on the row may exist on the
  // server even if we never hear back, which is what a cancel needs to know.
  // The cancelled check sits in the same edit, so a cancel is either seen here
  // (and nothing is sent) or sees this attempt (and takes the alert back).
  let row = null as ReturnType<typeof alertRow> | null
  await patch(e.id, x => { if (!x.cancelled_at && !x.landed_at) { x.attempts += 1; row = alertRow(x, 'active') } })
  if (!row) return 'skipped'
  const values = row
  const res = await rest(signal =>
    supabase.from('sos_alerts')
      .upsert(values, { onConflict: 'id', ignoreDuplicates: true })
      .abortSignal(signal))
  if (!res.error) {
    await patch(e.id, x => {
      x.landed_at = Date.now()
      x.last_error = null
      x.last_error_kind = null
      // A fix that came in while the insert was out didn't go with it.
      x.coords_pending = x.lat !== values.lat || x.lng !== values.lng
    })
    return 'landed'
  }
  const kind = res.status === 0 ? 'network' : 'server'
  const msg = String(res.error?.message || res.error)
  let report = false as boolean
  await patch(e.id, x => {
    x.last_error = msg
    x.last_error_kind = kind
    if (kind === 'server' && !x.reported) { x.reported = true; report = true }
  })
  if (report) {
    reportClientError(
      `sos: server refused alert ${e.id} (HTTP ${res.status}) — ${msg}`,
      JSON.stringify({ id: e.id, tenant_id: e.tenant_id, user_id: e.user_id, triggered_at: e.triggered_at }),
      'sos',
    )
  }
  return kind === 'network' ? 'network' : 'refused'
}

type PushResult =
  | { kind: 'sent'; recipients: number }
  | { kind: 'retry' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

// The office push, sent from this phone once the row exists. Recipients are
// the tenant's owners, managers and dispatchers who have the app on a phone —
// NOT the crew member who raised it, whose own phone would otherwise be counted
// as "the office" when a manager presses SOS.
async function pushToOffice(e: QueuedSOS): Promise<PushResult> {
  // Signed out, the token read runs as anon and comes back empty, which would
  // look exactly like "nobody at the office has the app".
  const sess = await withTimeout(() => supabase.auth.getSession())
  if (sess === TIMED_OUT || !sess.data?.session) return { kind: 'retry' }

  const read = await rest(signal =>
    supabase.from('push_tokens')
      .select('token, user_id, users!push_tokens_user_id_fkey(role)')
      .eq('tenant_id', e.tenant_id)
      .abortSignal(signal))
  if (read.error) return read.status === 0 ? { kind: 'retry' } : { kind: 'error', message: String(read.error?.message) }

  const tokens = [...new Set(((read.data ?? []) as any[])
    .filter(t => t.user_id !== e.user_id && DISPATCH_ROLES.includes(t.users?.role))
    .map(t => String(t.token)))]
  if (!tokens.length) return { kind: 'sent', recipients: 0 }

  // "I'm OK" may have come in while the tokens were being read.
  const fresh = await readEntry(e.id).catch(() => null)
  if (!fresh || fresh.cancelled_at) return { kind: 'cancelled' }

  const where = fresh.lat != null && fresh.lng != null
    ? `${Number(fresh.lat).toFixed(5)}, ${Number(fresh.lng).toFixed(5)}`
    : 'unavailable (no GPS fix)'
  const lateMin = Math.round(((fresh.landed_at ?? Date.now()) - Date.parse(fresh.triggered_at)) / 60_000)
  const late = lateMin * 60_000 >= LATE_AFTER_MS ? ` Pressed ${lateMin} min ago; the phone had no signal until now.` : ''
  const messages = tokens.slice(0, 100).map(to => ({
    to,
    sound: 'default',
    title: '🆘 SOS ALERT',
    body: `${fresh.crew_name} needs help! Location: ${where}.${late}`,
    data: { type: 'sos', tenantId: fresh.tenant_id, alertId: fresh.id },
    priority: 'high',
    channelId: 'sos-alerts',
  }))

  try {
    const res = await withTimeout(signal => fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
      signal,
    }))
    if (res === TIMED_OUT) return { kind: 'retry' }
    if (!res.ok) return res.status >= 500 ? { kind: 'retry' } : { kind: 'error', message: `Expo push HTTP ${res.status}` }
    const json: any = await res.json().catch(() => null)
    const tickets: any[] | null = Array.isArray(json?.data) ? json.data : null
    return { kind: 'sent', recipients: tickets ? tickets.filter(t => t?.status === 'ok').length : messages.length }
  } catch {
    return { kind: 'retry' }
  }
}

type ServerReach =
  | { kind: 'reached'; counts: { push: number; sms: number; email: number } }
  | { kind: 'waiting' }
  | { kind: 'absent' }
  | { kind: 'retry' }

// Has the server's fan-out reported on this alert yet? The crew member can read
// their own alert row (RLS sos_select).
async function serverReach(e: QueuedSOS): Promise<ServerReach> {
  const res = await rest(signal =>
    supabase.from('sos_alerts')
      .select('office_notified_at, office_push_count, office_sms_count, office_email_count')
      .eq('id', e.id)
      .abortSignal(signal)
      .maybeSingle())
  if (res.error) {
    if (res.status === 0) return { kind: 'retry' }
    // 42703: the office_* columns don't exist, so the server fan-out isn't
    // installed and nothing will ever report. Anything else, wait it out.
    return res.error?.code === '42703' ? { kind: 'absent' } : { kind: 'waiting' }
  }
  const row: any = res.data
  if (!row?.office_notified_at) return { kind: 'waiting' }
  return {
    kind: 'reached',
    counts: { push: row.office_push_count ?? 0, sms: row.office_sms_count ?? 0, email: row.office_email_count ?? 0 },
  }
}

async function tryPush(e: QueuedSOS): Promise<'ok' | 'network'> {
  const server = await serverReach(e)
  if (server.kind === 'retry') return 'network'
  if (server.kind === 'reached') {
    await patch(e.id, x => {
      if (x.push !== 'pending') return
      x.push = 'sent'
      x.push_by = 'server'
      x.office = server.counts
      x.push_recipients = server.counts.push
    })
    return 'ok'
  }
  // Give the server its chance first; the next flush looks again.
  if (server.kind === 'waiting' && Date.now() - (e.landed_at ?? 0) < SERVER_GRACE_MS) return 'ok'

  const r = await pushToOffice(e)
  if (r.kind === 'retry') return 'network'
  if (r.kind === 'cancelled') return 'ok'
  let failedNow = false as boolean
  await patch(e.id, x => {
    if (r.kind === 'sent') { x.push = 'sent'; x.push_by = 'phone'; x.push_recipients = r.recipients; return }
    x.push_errors += 1
    if (x.push_errors >= MAX_PUSH_ERRORS && x.push === 'pending') { x.push = 'failed'; failedNow = true }
  })
  if (failedNow && r.kind === 'error') {
    reportClientError(`sos: office push failed for alert ${e.id} — ${r.message}`, undefined, 'sos')
  }
  return 'ok'
}

// Send a fix that missed the insert. Best effort past the network: a refusal
// drops it (the trail's pings and the push still carry the position).
async function syncCoords(e: QueuedSOS): Promise<'ok' | 'network'> {
  const res = await rest(signal =>
    supabase.from('sos_alerts').update({ lat: e.lat, lng: e.lng }).eq('id', e.id).abortSignal(signal))
  if (res.error && res.status === 0) return 'network'
  await patch(e.id, x => { if (x.lat === e.lat && x.lng === e.lng) x.coords_pending = false })
  return 'ok'
}

async function syncCancel(e: QueuedSOS): Promise<'ok' | 'network'> {
  if (!e.landed_at) {
    // The insert went out but was never confirmed, so it may still land. Write
    // the row in its final state first: if it isn't there yet it arrives as
    // false_alarm, and a late copy of the original insert (DO NOTHING) can't
    // bring it back to active.
    const res = await rest(signal =>
      supabase.from('sos_alerts')
        .upsert(alertRow(e, 'false_alarm'), { onConflict: 'id', ignoreDuplicates: true })
        .abortSignal(signal))
    if (res.error) return noteCancelFailure(e, res)
  }
  // Take back an alert that did land. Only an active one: if the office has
  // already resolved it, their resolution stands.
  const res = await rest(signal =>
    supabase.from('sos_alerts')
      .update({ status: 'false_alarm', resolved_at: new Date(e.cancelled_at ?? Date.now()).toISOString() })
      .eq('id', e.id)
      .eq('status', 'active')
      .abortSignal(signal))
  if (res.error) return noteCancelFailure(e, res)
  await patch(e.id, x => { x.cancel_synced = true })
  return 'ok'
}

async function noteCancelFailure(e: QueuedSOS, res: RestResult): Promise<'ok' | 'network'> {
  if (res.status === 0) return 'network' // no signal: stays queued
  // Refused. Keep trying on every flush, like the alert itself; meanwhile the
  // office keeps seeing an active SOS, which errs toward someone calling to
  // check. Tell System Health once so it isn't silent.
  let report = false as boolean
  await patch(e.id, x => { if (!x.cancel_reported) { x.cancel_reported = true; report = true } })
  if (report) {
    reportClientError(`sos: server refused to mark alert ${e.id} false_alarm (HTTP ${res.status}) — ${String(res.error?.message || res.error)}`, undefined, 'sos')
  }
  return 'ok'
}

async function prune(): Promise<void> {
  let all: QueuedSOS[]
  try { all = await readAll() } catch { return }
  const now = Date.now()
  for (const e of all) {
    const doneAt = e.cancelled_at
      ? (e.cancel_synced ? e.cancelled_at : null)
      : (e.landed_at && e.push !== 'pending' && !e.coords_pending ? e.landed_at : null)
    if (doneAt && now - doneAt > KEEP_DONE_MS) await serially(() => removeEntry(e.id))
  }
}
