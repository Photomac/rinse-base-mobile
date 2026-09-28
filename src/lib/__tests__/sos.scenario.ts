// SOS delivery scenario test. Run with: node scripts/test-sos.mjs
//
// Exercises the REAL src/lib/sosQueue.ts through the REAL supabase-js client,
// with only fetch faked (sos.mocks.ts). "No signal" is fetch rejecting the way
// React Native's does; everything after that (status 0, the queue, the retry,
// the push) is the code that ships.
//
// The bug this guards: the SOS screen said "ALERT SENT" before any network
// call, and in a dead zone nothing ever reached anyone. The invariants are
// that the phone never claims "sent" without the server's answer, never loses
// an alert, never raises two, and pushes the office once the row exists.
import {
  raiseSOS, flushSOSQueue, getSOS, cancelSOS, resumableSOS, updateSOSLocation,
  sosLanded, sosDeliveryState, onSOSChange, isSOSFlushing, SENDING_GRACE_MS,
} from '../sosQueue'
import { supabase, session } from './sos.supabase'
import { net, server, storage, reported } from './sos.mocks'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// A request that never settles leaves Node with nothing to wait on, and it
// exits 0 mid-scenario — a hang would read as a pass. Both guards fail it.
let finished = false
const watchdog = setTimeout(() => { console.error('FAIL  scenario hung'); process.exit(1) }, 30_000)
process.on('exit', () => {
  if (!finished) { console.error('FAIL  scenario ended before its last assertion'); process.exitCode = 1 }
})

const TENANT = 't-cks'
const CREW = 'u-mia'
const base = { tenant_id: TENANT, user_id: CREW, crew_name: 'Mia Evans', lat: 34.86, lng: -111.79 }
const KEY = (id: string) => `sosAlert.v1:${id}`
const stored = (id: string) => { const raw = storage.store.get(KEY(id)); return raw ? JSON.parse(raw) : null }
const clearQueue = () => { for (const k of [...storage.store.keys()]) if (k.startsWith('sosAlert.v1:')) storage.store.delete(k) }
const rowsFor = (id: string) => [...server.sos_alerts.values()].filter(r => r.id === id)
const pushesFor = (id: string) => server.pushes.filter(p => p[0]?.data?.alertId === id)
const insertsSoFar = () => net.calls.filter(c => c.method === 'POST' && c.path.endsWith('/sos_alerts')).length
const state = async (id: string) => { const e = await getSOS(id); return e ? sosDeliveryState(e) : 'gone' }
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

;(async () => {
  server.push_tokens.push(
    { tenant_id: TENANT, user_id: 'u-catherine', token: 'ExponentPushToken[owner]', role: 'owner' },
    { tenant_id: TENANT, user_id: 'u-manager', token: 'ExponentPushToken[manager]', role: 'manager' },
    { tenant_id: TENANT, user_id: 'u-nichole', token: 'ExponentPushToken[lead]', role: 'lead_cleaner' },
    { tenant_id: TENANT, user_id: CREW, token: 'ExponentPushToken[mia]', role: 'cleaner' },
    { tenant_id: 't-other', user_id: 'u-x', token: 'ExponentPushToken[other-company]', role: 'owner' },
  )

  // ── The discriminator everything rests on ────────────────────────────────
  net.rest = 'offline'
  const probe: any = await supabase.from('sos_alerts').upsert({ id: 'probe' }, { onConflict: 'id', ignoreDuplicates: true })
  ok('real postgrest-js answers a rejected fetch with { error, status: 0 } instead of throwing',
    probe.status === 0 && !!probe.error)

  // ── Dead zone ─────────────────────────────────────────────────────────────
  const callsBefore = net.calls.length
  const a = await raiseSOS({ ...base, lat: null, lng: null })
  ok('the alert is stored on the phone before any network call', net.calls.length === callsBefore && !!stored(a.id))
  ok('a fresh alert reads "sending", never "sent"', sosDeliveryState(a) === 'sending')
  const t0 = Date.parse(a.triggered_at)
  ok('with no answer after 5 s the screen stops saying "Sending…"',
    sosDeliveryState(a, t0 + 1000) === 'sending' && sosDeliveryState(a, t0 + SENDING_GRACE_MS + 1) === 'offline')

  await flushSOSQueue()
  ok('no signal: state is "offline" (has NOT reached anyone)', (await state(a.id)) === 'offline')
  ok('no signal: nothing on the server, no push', rowsFor(a.id).length === 0 && pushesFor(a.id).length === 0)
  ok('sosLanded is false while the phone still holds it', (await sosLanded(a.id)) === false)

  for (let i = 0; i < 3; i++) await flushSOSQueue()
  const a4 = await getSOS(a.id)
  ok('no signal: every retry keeps the alert (4 attempts, still queued)', !!a4 && a4.attempts === 4 && !a4.landed_at)
  ok('after an app restart it is found and resumed, not raised again', (await resumableSOS(CREW))?.id === a.id)

  await updateSOSLocation(a.id, 34.87, -111.8)
  ok('a GPS fix that arrives before delivery is kept with the alert', (await getSOS(a.id))?.lat === 34.87)

  // ── Signal comes back ─────────────────────────────────────────────────────
  net.rest = 'online'
  await flushSOSQueue()
  ok('signal back: exactly one sos_alerts row, with the id the phone minted',
    rowsFor(a.id).length === 1 && server.sos_alerts.get(a.id)?.status === 'active')
  ok('... carrying the late GPS fix, with nothing left to send', server.sos_alerts.get(a.id)?.lat === 34.87 && !(await getSOS(a.id))?.coords_pending)
  ok('signal back: only now does the state read "sent"', (await state(a.id)) === 'sent')
  ok('the office push fired once the row landed, as one request', pushesFor(a.id).length === 1)
  const to = pushesFor(a.id)[0].map((m: any) => m.to).sort()
  ok('push reached owner + manager only: not crew, not the sender, not another company',
    JSON.stringify(to) === JSON.stringify(['ExponentPushToken[manager]', 'ExponentPushToken[owner]']))
  const aDone = await getSOS(a.id)
  ok('the screen can say how many office phones were alerted', aDone?.push === 'sent' && aDone?.push_recipients === 2)
  ok('a delivered alert is no longer offered for resume', (await resumableSOS(CREW)) === null)
  await flushSOSQueue(); await flushSOSQueue()
  ok('later flushes insert nothing and push nothing again', rowsFor(a.id).length === 1 && pushesFor(a.id).length === 1)

  // ── The server got it but the answer was lost ─────────────────────────────
  const b = await raiseSOS(base)
  net.rest = 'lose-ack'
  await flushSOSQueue()
  ok('lost answer: the row is on the server, yet the phone does NOT claim "sent"',
    rowsFor(b.id).length === 1 && (await state(b.id)) === 'offline')
  ok('lost answer: no push without proof the row landed', pushesFor(b.id).length === 0)
  net.rest = 'online'
  await flushSOSQueue()
  ok('replay after a lost answer: still one row (ON CONFLICT DO NOTHING)', rowsFor(b.id).length === 1)
  ok('replay after a lost answer: "sent", pushed exactly once', (await state(b.id)) === 'sent' && pushesFor(b.id).length === 1)

  // ── One weak bar: the request never answers ───────────────────────────────
  const c = await raiseSOS(base)
  net.rest = 'hang'
  const tHang = Date.now()
  await flushSOSQueue()
  ok('a stalled request times out and reports "offline" instead of hanging',
    Date.now() - tHang < 2000 && (await state(c.id)) === 'offline')
  net.rest = 'online'
  await flushSOSQueue()
  ok('after the stall: delivered', (await state(c.id)) === 'sent')

  // ── The server refuses it ─────────────────────────────────────────────────
  const d = await raiseSOS(base)
  net.refuse.add('sos_alerts')
  await flushSOSQueue(); await flushSOSQueue(); await flushSOSQueue()
  ok('server refusal: state "refused", never "sent"', (await state(d.id)) === 'refused')
  ok('server refusal: reported to System Health exactly once', reported.filter(r => r.includes(d.id)).length === 1)
  const d3 = await getSOS(d.id)
  ok('server refusal: never given up on, still queued', !!d3 && !d3.landed_at && d3.attempts === 3)
  ok('server refusal: no push', pushesFor(d.id).length === 0)
  net.refuse.clear()
  await flushSOSQueue()
  ok('refusal clears: delivered and pushed', (await state(d.id)) === 'sent' && pushesFor(d.id).length === 1)

  // ── Row landed, push can't get out ────────────────────────────────────────
  const e = await raiseSOS(base)
  net.expo = 'offline'
  await flushSOSQueue()
  const e1 = await getSOS(e.id)
  ok('row landed with the push offline: "sent", push still pending', !!e1 && sosDeliveryState(e1) === 'sent' && e1.push === 'pending')
  net.expo = 'online'
  await flushSOSQueue(); await flushSOSQueue()
  ok('the push is retried and sent exactly once', pushesFor(e.id).length === 1)

  net.refuse.add('push_tokens')
  const e2 = await raiseSOS(base)
  for (let i = 0; i < 5; i++) await flushSOSQueue()
  const e2s = await getSOS(e2.id)
  ok('push refused 5 times: marked failed and reported, alert still "sent"',
    e2s?.push === 'failed' && sosDeliveryState(e2s) === 'sent' && reported.some(r => r.includes(`office push failed for alert ${e2.id}`)))
  net.refuse.clear()

  // ── Signed out: the token read would come back empty as anon ──────────────
  session.drop()
  const ns = await raiseSOS(base)
  await flushSOSQueue()
  const ns1 = await getSOS(ns.id)
  ok('signed out: the push is held, not recorded as "nobody at the office has the app"',
    !!ns1?.landed_at && ns1.push === 'pending' && ns1.push_recipients === null && pushesFor(ns.id).length === 0)
  session.restore()
  await flushSOSQueue()
  ok('... and goes out once signed back in', pushesFor(ns.id).length === 1 && (await getSOS(ns.id))?.push === 'sent')

  // ── A manager presses SOS: their own phone is not "the office" ────────────
  const mgr = await raiseSOS({ ...base, user_id: 'u-manager', crew_name: 'The manager' })
  await flushSOSQueue()
  const mgr1 = await getSOS(mgr.id)
  ok("a manager's SOS goes to the owner, and their own phone isn't counted",
    JSON.stringify(pushesFor(mgr.id)[0]?.map((m: any) => m.to)) === JSON.stringify(['ExponentPushToken[owner]']) && mgr1?.push_recipients === 1)

  // ── Nobody at the office has the app ──────────────────────────────────────
  server.push_tokens.push({ tenant_id: 't-ritual', user_id: 'u-crew2', token: 'ExponentPushToken[crew2]', role: 'cleaner' })
  const n = await raiseSOS({ ...base, tenant_id: 't-ritual', user_id: 'u-crew1' })
  const expoBefore = server.pushes.length
  await flushSOSQueue()
  const n1 = await getSOS(n.id)
  ok('no office phone has the app: recorded as 0 recipients, no Expo call',
    n1?.push === 'sent' && n1?.push_recipients === 0 && server.pushes.length === expoBefore)

  // ── A GPS fix after the insert went out still reaches the row ─────────────
  const g0 = await raiseSOS({ ...base, lat: null, lng: null })
  await flushSOSQueue()
  ok('pressed before the first fix: the row lands without a position', server.sos_alerts.get(g0.id)?.lat === null)
  await updateSOSLocation(g0.id, 34.9, -111.7)
  await flushSOSQueue()
  ok('a fix after landing is sent to the row', server.sos_alerts.get(g0.id)?.lat === 34.9 && !(await getSOS(g0.id))?.coords_pending)

  net.rest = 'slow'
  const g1 = await raiseSOS({ ...base, lat: null, lng: null })
  const g1Flush = flushSOSQueue()
  await sleep(5)                                  // the insert is on the wire
  await updateSOSLocation(g1.id, 35.0, -111.6)
  await g1Flush
  net.rest = 'online'
  ok('a fix that arrives mid-insert still reaches the row', server.sos_alerts.get(g1.id)?.lat === 35.0)
  ok('... and the office push carried it', String(pushesFor(g1.id)[0]?.[0]?.body).includes('35.00000, -111.60000'))

  // ── "I'm OK" ──────────────────────────────────────────────────────────────
  net.rest = 'offline'
  const f = await raiseSOS(base)
  const callsF = net.calls.length
  await cancelSOS(f.id)
  const f1 = await getSOS(f.id)
  ok("I'm OK before the first attempt: no request at all, nothing to take back",
    net.calls.length === callsF && !!f1?.cancel_synced && f1.attempts === 0 && rowsFor(f.id).length === 0)

  const g = await raiseSOS(base)
  await flushSOSQueue()           // one failed attempt: it may have reached the server
  await cancelSOS(g.id)
  const g2 = await getSOS(g.id)
  ok("I'm OK with no signal: kept on the phone until the server hears it", !!g2 && !!g2.cancelled_at && !g2.cancel_synced)
  net.rest = 'online'
  await flushSOSQueue()
  ok("I'm OK synced: the row exists as false_alarm and the phone knows it",
    server.sos_alerts.get(g.id)?.status === 'false_alarm' && (await getSOS(g.id))?.cancel_synced === true)
  await supabase.from('sos_alerts').upsert(
    { id: g.id, tenant_id: TENANT, user_id: CREW, status: 'active' }, { onConflict: 'id', ignoreDuplicates: true })
  ok('a late copy of the original insert cannot bring it back to active', server.sos_alerts.get(g.id)?.status === 'false_alarm')
  ok('a cancelled alert is never pushed', pushesFor(g.id).length === 0)

  const h = await raiseSOS(base)
  await flushSOSQueue()           // online: lands and pushes
  net.rest = 'offline'
  await cancelSOS(h.id)
  const h1 = await getSOS(h.id)
  ok("I'm OK after it landed, no signal: queued; the office still sees it active",
    !!h1 && !h1.cancel_synced && server.sos_alerts.get(h.id)?.status === 'active')
  net.rest = 'online'
  await flushSOSQueue()
  ok("... and becomes false_alarm when signal returns", server.sos_alerts.get(h.id)?.status === 'false_alarm')

  const rf = await raiseSOS(base)
  await flushSOSQueue()           // lands
  net.refuse.add('sos_alerts')
  await cancelSOS(rf.id)
  await flushSOSQueue(); await flushSOSQueue()
  const rf1 = await getSOS(rf.id)
  ok("I'm OK refused by the server: kept, retried, reported once",
    !!rf1 && !rf1.cancel_synced && reported.filter(x => x.includes(`false_alarm`) && x.includes(rf.id)).length === 1)
  net.refuse.clear()
  await flushSOSQueue()
  ok("... and lands once the server takes it", server.sos_alerts.get(rf.id)?.status === 'false_alarm' && (await getSOS(rf.id))?.cancel_synced === true)

  const r = await raiseSOS(base)
  await flushSOSQueue()
  server.sos_alerts.get(r.id)!.status = 'resolved'   // the office closed it from the dashboard
  await cancelSOS(r.id)
  ok("I'm OK never overwrites the office's own resolution",
    server.sos_alerts.get(r.id)?.status === 'resolved' && (await getSOS(r.id))?.cancel_synced === true)

  const pr = await raiseSOS(base)
  await flushSOSQueue()
  const prCopy = await getSOS(pr.id)
  storage.store.delete(KEY(pr.id))                   // pruned: delivered more than 4 h ago
  await cancelSOS(pr.id, prCopy)
  ok("I'm OK after the phone let go of a delivered alert still takes it back (from the screen's copy)",
    server.sos_alerts.get(pr.id)?.status === 'false_alarm')

  const pc = await raiseSOS(base)
  net.override = (m, u) => (m === 'GET' && u.pathname.endsWith('/push_tokens') ? 'slow' : null)
  const pcFlush = flushSOSQueue()
  await sleep(15)                                    // landed; the push's token read is out
  await cancelSOS(pc.id)
  await pcFlush
  net.override = null
  ok("I'm OK while the push is being prepared: the push never goes out",
    rowsFor(pc.id).length === 1 && pushesFor(pc.id).length === 0 && server.sos_alerts.get(pc.id)?.status === 'false_alarm')

  // "I'm OK" landing in the gap after the flush has read the alert (not yet
  // cancelled) and before it counts the attempt. Start from an empty queue so
  // the flush's second read is this alert's; cancel right as it returns.
  clearQueue()
  const sameInstant = await raiseSOS(base)
  let reads = 0
  let cancelling: Promise<void> | null = null
  storage.onRead = () => { if (++reads === 2) { storage.onRead = null; cancelling = cancelSOS(sameInstant.id) } }
  await flushSOSQueue()
  await cancelling
  ok("I'm OK in the gap before the first attempt: nothing reaches the server",
    reads === 2 && rowsFor(sameInstant.id).length === 0 && pushesFor(sameInstant.id).length === 0 && (await getSOS(sameInstant.id))?.cancel_synced === true)

  net.rest = 'slow'
  const q = await raiseSOS(base)
  const inFlight = flushSOSQueue()
  await sleep(5)                  // the insert is on the wire
  await cancelSOS(q.id)
  await inFlight
  ok("I'm OK while the insert is on the wire: ends false_alarm, never pushed",
    server.sos_alerts.get(q.id)?.status === 'false_alarm' && pushesFor(q.id).length === 0 && (await getSOS(q.id))?.cancel_synced === true)
  net.rest = 'online'

  // ── Three triggers at once: screen loop, app drain, background task ───────
  const k = await raiseSOS(base)
  const insertsBefore = insertsSoFar()
  await Promise.all([flushSOSQueue(), flushSOSQueue(), flushSOSQueue()])
  ok('concurrent flushes: one insert request, one push', insertsSoFar() - insertsBefore === 1 && pushesFor(k.id).length === 1)

  // ── Most urgent first, and a dead network ends the pass ───────────────────
  const old = await raiseSOS(base)
  await flushSOSQueue()                              // lands
  net.refuse.add('sos_alerts')
  await cancelSOS(old.id)                            // refused: the cancel stays queued
  net.refuse.clear()
  const fresh = await raiseSOS(base)
  net.rest = 'hang'
  const mark = net.calls.length
  await flushSOSQueue()
  const passCalls = net.calls.slice(mark)
  ok('the new alert goes before an old queued cancel, and no signal ends the pass after one try',
    passCalls.length === 1 && passCalls[0].method === 'POST' && passCalls[0].id === fresh.id)
  net.rest = 'online'
  await flushSOSQueue()
  ok('... then both catch up', rowsFor(fresh.id).length === 1 && server.sos_alerts.get(old.id)?.status === 'false_alarm')

  // ── A late delivery says so in the push ───────────────────────────────────
  net.rest = 'offline'
  const late = await raiseSOS(base)
  await flushSOSQueue()
  const lateCopy = stored(late.id)
  lateCopy.triggered_at = new Date(Date.now() - 7 * 60_000).toISOString()
  storage.store.set(KEY(late.id), JSON.stringify(lateCopy))
  net.rest = 'online'
  await flushSOSQueue()
  const body = String(pushesFor(late.id)[0]?.[0]?.body || '')
  ok('the push carries the GPS position', body.includes('34.86000, -111.79000'))
  ok('an alert that sat on the phone tells the office how late it is', /Pressed 7 min ago/.test(body))

  // ── Storage trouble ───────────────────────────────────────────────────────
  storage.failWrites = true
  const m = await raiseSOS(base)
  await flushSOSQueue()
  ok('storage full at the press: the alert still goes out from memory', rowsFor(m.id).length === 1 && (await state(m.id)) === 'sent')
  storage.failWrites = false
  await flushSOSQueue()
  ok('... and is written to storage once it can be', !!stored(m.id) && !!stored(m.id).landed_at)

  net.rest = 'offline'
  const w1 = await raiseSOS(base)
  await flushSOSQueue()                              // queued, one attempt
  storage.failReads = true
  const w2 = await raiseSOS(base)                    // written whole: needs no read
  await flushSOSQueue()                              // can't read: the pass is skipped
  await updateSOSLocation(w1.id, 1, 1).catch(() => {}) // can't read: nothing is written
  storage.failReads = false
  ok('a failed storage read loses nothing and overwrites nothing',
    stored(w1.id)?.attempts === 1 && stored(w1.id)?.lat === 34.86 && !!stored(w2.id))
  net.rest = 'online'
  await flushSOSQueue()
  ok('... and both alerts go out once reads work again', rowsFor(w1.id).length === 1 && rowsFor(w2.id).length === 1)

  // ── The screen hears about it ─────────────────────────────────────────────
  let heard = 0
  let sawFlushing = false
  const off = onSOSChange(() => { heard++; if (isSOSFlushing()) sawFlushing = true })
  const l = await raiseSOS(base)
  await flushSOSQueue()
  off()
  ok('the screen listener hears each change and sees the flush in progress', heard > 2 && sawFlushing && (await state(l.id)) === 'sent')

  finished = true
  clearTimeout(watchdog)
  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nAll SOS delivery invariants hold.')
})()
