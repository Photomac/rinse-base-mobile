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
// - The office push goes out after the row lands, from whichever path landed
//   it (the SOS screen's retry loop, the app-wide drain, or the SOS location
//   task in the background), and is recorded so a later flush doesn't repeat
//   it. A crash between the push and that record can repeat it once; a
//   duplicate SOS push is the acceptable failure, a missing one is not.
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
// - Not cleared on sign-out, same as the outbox.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { uuid4 } from './outbox'
import { reportClientError } from './errorReporter'

const KEY = 'sosQueue.v1'
// Generous for a few hundred bytes on one bar, short enough that the screen
// stops saying "Sending…" and tells the truth while the crew can still act.
const REQUEST_TIMEOUT_MS = 20_000
// A delivered alert stays on the phone this long so the screen that raised it
// can still show and cancel it. Same cap as the location trail.
const KEEP_DELIVERED_MS = 4 * 60 * 60 * 1000
const MAX_PUSH_ERRORS = 5
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
  attempts: number            // inserts started; a started one may have landed
  last_error: string | null
  last_error_kind: 'network' | 'server' | null
  reported: boolean           // first server rejection went to admin_error_log
  landed_at: number | null    // the server answered for the row
  push: 'pending' | 'sent' | 'failed'
  push_recipients: number | null  // office phones Expo accepted; 0 = nobody gets app alerts
  push_errors: number
  cancelled_at: number | null     // the crew member tapped "I'm OK"
  cancel_synced: boolean          // the server has the false_alarm, or never had the alert
  cancel_reported: boolean        // first server refusal of the cancel went to admin_error_log
}

export type SOSDeliveryState = 'sending' | 'offline' | 'refused' | 'sent'

/** What the SOS screen may claim. Only a landed row is "sent". */
export function sosDeliveryState(e: QueuedSOS): SOSDeliveryState {
  if (e.landed_at) return 'sent'
  if (e.last_error_kind === 'server') return 'refused'
  if (e.last_error_kind === 'network') return 'offline'
  return 'sending'
}

// ── Storage ─────────────────────────────────────────────────────────────────
// If storage ever refuses a write (a full phone), the latest list is kept in
// memory and used until a write succeeds, so the SOS still goes out while the
// app is running instead of vanishing with the failed write.
let unsaved: QueuedSOS[] | null = null

async function readAll(): Promise<QueuedSOS[]> {
  if (unsaved) return unsaved.map(e => ({ ...e }))
  try { const raw = await AsyncStorage.getItem(KEY); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}

async function writeAll(list: QueuedSOS[]): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(list)); unsaved = null }
  catch { unsaved = list.map(e => ({ ...e })) }
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

// Every change goes through this chain: read, edit, write, one at a time. A
// cancel that lands while a flush is waiting on the network can't be written
// over by the flush's older copy of the list.
let chain: Promise<unknown> = Promise.resolve()
function mutate(edit: (list: QueuedSOS[]) => void): Promise<void> {
  const run = chain.then(async () => {
    const list = await readAll()
    edit(list)
    await writeAll(list)
  })
  chain = run.catch(() => {})
  return run.then(emit)
}

function patch(id: string, edit: (e: QueuedSOS) => void): Promise<void> {
  return mutate(list => { const e = list.find(x => x.id === id); if (e) edit(e) })
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record an SOS on this phone. Resolves once it is stored, before any network
 * call; call flushSOSQueue() to deliver it.
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
    attempts: 0,
    last_error: null,
    last_error_kind: null,
    reported: false,
    landed_at: null,
    push: 'pending',
    push_recipients: null,
    push_errors: 0,
    cancelled_at: null,
    cancel_synced: false,
    cancel_reported: false,
  }
  await mutate(list => { list.push(entry) })
  return entry
}

export async function getSOS(id: string): Promise<QueuedSOS | null> {
  return (await readAll()).find(e => e.id === id) ?? null
}

/**
 * The newest alert this user raised that hasn't reached the server and wasn't
 * cancelled. The app reopens the SOS screen on it after a restart, and the
 * screen resumes it instead of raising a second one.
 */
export async function resumableSOS(userId: string): Promise<QueuedSOS | null> {
  const open = (await readAll()).filter(e => e.user_id === userId && !e.cancelled_at && !e.landed_at)
  return open.length ? open[open.length - 1] : null
}

/** A fix that arrives before delivery goes out with the alert. */
export async function updateSOSLocation(id: string, lat: number, lng: number): Promise<void> {
  const e = await getSOS(id)
  if (!e || e.landed_at || e.cancelled_at || (e.lat === lat && e.lng === lng)) return
  await patch(id, x => { if (!x.landed_at) { x.lat = lat; x.lng = lng } })
}

/** False only while this phone still holds the alert undelivered. */
export async function sosLanded(id: string): Promise<boolean> {
  const e = await getSOS(id)
  return !e || !!e.landed_at
}

/**
 * The crew member is OK. Resolves once the cancel reached the server or the
 * attempt failed; it stays queued until it does reach it. Once it has, the
 * alert is dropped from the phone, so a missing entry after a cancel means the
 * server has it.
 */
export async function cancelSOS(id: string): Promise<void> {
  await patch(id, e => {
    if (e.cancelled_at) return
    e.cancelled_at = Date.now()
    // Never sent anywhere, so there is nothing on the server to take back.
    if (e.attempts === 0 && !e.landed_at) e.cancel_synced = true
  })
  await flushSOSQueue()
}

let current: Promise<void> | null = null
let rerun = false

export function isSOSFlushing(): boolean {
  return current !== null
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
        if (unsaved) await mutate(() => {}) // storage refused an earlier write: try again
        for (const e of await readAll()) {
          try { await advance(e.id) }
          catch (err) { console.warn('sos: delivery step failed', err) } // one alert must not block another
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

// Walk one alert forward as far as the network allows.
async function advance(id: string): Promise<void> {
  for (let step = 0; step < 4; step++) {
    const e = await getSOS(id)
    if (!e) return
    if (e.cancelled_at) { if (!e.cancel_synced) await syncCancel(e); return }
    if (!e.landed_at) {
      if (await tryInsert(e)) continue // re-read: a cancel may have arrived while the insert was out
      return
    }
    if (e.push === 'pending') await tryPush(e)
    return
  }
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

// True when the alert moved on (landed, or was cancelled before the request
// could go out) and should be re-read; false when this attempt failed.
async function tryInsert(e: QueuedSOS): Promise<boolean> {
  // Counted before the request goes out: from here on the row may exist on the
  // server even if we never hear back, which is what a cancel needs to know.
  // The cancelled check sits in the same edit, so a cancel is either seen here
  // (and nothing is sent) or sees this attempt (and takes the alert back).
  let row = null as ReturnType<typeof alertRow> | null
  await patch(e.id, x => { if (!x.cancelled_at && !x.landed_at) { x.attempts += 1; row = alertRow(x, 'active') } })
  if (!row) return true
  const values = row
  const res = await rest(signal =>
    supabase.from('sos_alerts')
      .upsert(values, { onConflict: 'id', ignoreDuplicates: true })
      .abortSignal(signal))
  if (!res.error) {
    await patch(e.id, x => { x.landed_at = Date.now(); x.last_error = null; x.last_error_kind = null })
    return true
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
  return false
}

type PushResult = { kind: 'sent'; recipients: number } | { kind: 'retry' } | { kind: 'error'; message: string }

// The office push, sent from this phone once the row exists. Recipients are
// the tenant's owners, managers and dispatchers who have the app on a phone —
// NOT the crew member who raised it, whose own phone would otherwise be counted
// as "the office" when a manager presses SOS.
async function pushToOffice(e: QueuedSOS): Promise<PushResult> {
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

  const where = e.lat != null && e.lng != null
    ? `${Number(e.lat).toFixed(5)}, ${Number(e.lng).toFixed(5)}`
    : 'unavailable (no GPS fix)'
  const lateMin = Math.round(((e.landed_at ?? Date.now()) - Date.parse(e.triggered_at)) / 60_000)
  const late = lateMin * 60_000 >= LATE_AFTER_MS ? ` Pressed ${lateMin} min ago; the phone had no signal until now.` : ''
  const messages = tokens.slice(0, 100).map(to => ({
    to,
    sound: 'default',
    title: '🆘 SOS ALERT',
    body: `${e.crew_name} needs help! Location: ${where}.${late}`,
    data: { type: 'sos', tenantId: e.tenant_id, alertId: e.id },
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

async function tryPush(e: QueuedSOS): Promise<void> {
  const r = await pushToOffice(e)
  let failedNow = false as boolean
  await patch(e.id, x => {
    if (r.kind === 'sent') { x.push = 'sent'; x.push_recipients = r.recipients; return }
    if (r.kind === 'error') {
      x.push_errors += 1
      if (x.push_errors >= MAX_PUSH_ERRORS && x.push === 'pending') { x.push = 'failed'; failedNow = true }
    }
  })
  if (failedNow && r.kind === 'error') {
    reportClientError(`sos: office push failed for alert ${e.id} — ${r.message}`, undefined, 'sos')
  }
}

async function syncCancel(e: QueuedSOS): Promise<void> {
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
}

async function noteCancelFailure(e: QueuedSOS, res: RestResult): Promise<void> {
  if (res.status === 0) return // no signal: stays queued
  // Refused. Keep trying on every flush, like the alert itself; meanwhile the
  // office keeps seeing an active SOS, which errs toward someone calling to
  // check. Tell System Health once so it isn't silent.
  let report = false as boolean
  await patch(e.id, x => { if (!x.cancel_reported) { x.cancel_reported = true; report = true } })
  if (report) {
    reportClientError(`sos: server refused to mark alert ${e.id} false_alarm (HTTP ${res.status}) — ${String(res.error?.message || res.error)}`, undefined, 'sos')
  }
}

async function prune(): Promise<void> {
  const now = Date.now()
  const done = (e: QueuedSOS) => e.cancelled_at
    ? e.cancel_synced
    : !!e.landed_at && e.push !== 'pending' && now - e.landed_at > KEEP_DELIVERED_MS
  if (!(await readAll()).some(done)) return
  await mutate(list => {
    for (let i = list.length - 1; i >= 0; i--) if (done(list[i])) list.splice(i, 1)
  })
}
