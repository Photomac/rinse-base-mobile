// SOS location-trail scenario. Run with: node scripts/test-sos.mjs
//
// Exercises the REAL src/lib/sosTracker.ts on top of the real SOS queue and
// supabase-js, with the platform modules faked (sosTracker.mocks.ts) and the
// network faked as in the queue scenario. With the app backgrounded, the trail's
// task is the only code that runs, so it is what gets a dead-zone alert out;
// these are the ways it could fail to.
import { startSOSTrail, stopSOSTrail } from '../sosTracker'
import { raiseSOS, getSOS } from '../sosQueue'
import { net, server, storage } from './sos.mocks'
import { loc, tasks } from './sosTracker.mocks'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
let finished = false
const watchdog = setTimeout(() => { console.error('FAIL  tracker scenario hung'); process.exit(1) }, 30_000)
process.on('exit', () => {
  if (!finished) { console.error('FAIL  tracker scenario ended before its last assertion'); process.exitCode = 1 }
})

// Count the trail's fallback timers: the only setInterval user in this bundle.
const live = new Set<unknown>()
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
;(globalThis as any).setInterval = (fn: any, ms?: number) => { const id = realSetInterval(fn, ms); live.add(id); return id }
;(globalThis as any).clearInterval = (id: any) => { live.delete(id); realClearInterval(id) }

const TENANT = 't-cks'
const base = { tenant_id: TENANT, user_id: 'u-mia', crew_name: 'Mia Evans', lat: 34.86, lng: -111.79 }
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))
const active = () => { const raw = storage.store.get('sos:active'); return raw ? JSON.parse(raw) : null }
const runTask = () => tasks.get('sos-ping-task')!({ data: { locations: [{ coords: { ...loc.fix } }] }, error: null })
const pingsFor = (id: string) => server.sos_pings.filter(p => p.alert_id === id).length

;(async () => {
  server.push_tokens.push({ tenant_id: TENANT, user_id: 'u-owner', token: 'ExponentPushToken[owner]', role: 'owner' })
  ok('the SOS task is defined at import, so a headless relaunch finds it', tasks.has('sos-ping-task'))

  // ── Pressed in a dead zone ────────────────────────────────────────────────
  net.rest = 'offline'
  const a = await raiseSOS(base)
  await startSOSTrail(a.id)
  ok('the trail starts at the press: background task on, one fallback timer', loc.registered.has('sos-ping-task') && live.size === 1)
  ok('its Android notice claims nothing (it says to check the app)',
    loc.started[0]?.options?.foregroundService?.notificationBody === 't:sos_trail_body')
  await sleep(30)
  ok('no ping while the alert has not landed', pingsFor(a.id) === 0)

  // ── Walks back into one bar; the app is backgrounded ──────────────────────
  // Signal returns, but a status read would hang. The background task must
  // deliver first and must not be parked by that read.
  net.rest = 'online'
  net.override = (m, u) => (m === 'GET' && u.pathname.endsWith('/sos_alerts') ? 'hang' : null)
  const mark = net.calls.length
  const t0 = Date.now()
  await runTask()
  net.override = null
  const calls = net.calls.slice(mark)
  const insertAt = calls.findIndex(c => c.method === 'POST' && c.path.endsWith('/sos_alerts'))
  const statusAt = calls.findIndex(c => c.method === 'GET' && c.path.endsWith('/sos_alerts'))
  ok('background task: the alert goes out before any status read', insertAt >= 0 && (statusAt === -1 || insertAt < statusAt))
  ok('background task: a hanging status read cannot park it', Date.now() - t0 < 3000)
  ok('background task: delivered and the office pushed, all from the background',
    !!(await getSOS(a.id))?.landed_at && server.pushes.some(p => p[0]?.data?.alertId === a.id))
  ok('background task: pings once the alert has landed', pingsFor(a.id) === 1)

  // ── App launch resumes the trail while the SOS screen does too ────────────
  const startedAt = active()?.startedAt
  await sleep(5)
  await Promise.all([startSOSTrail(a.id), startSOSTrail(a.id)])
  ok('two starts at once leave exactly one timer', live.size === 1)
  ok('resuming the same alert keeps its start (the 4 h cap counts from the press)', active()?.startedAt === startedAt)

  await stopSOSTrail()
  ok("I'm OK stops everything: no timer, no task, no active alert", live.size === 0 && !loc.registered.has('sos-ping-task') && active() === null)

  // ── "I'm OK" while the trail is still starting ────────────────────────────
  const b = await raiseSOS(base)
  loc.permissionDelayMs = 30
  const starting = startSOSTrail(b.id)
  await sleep(10)                 // the start is waiting on a permission read
  await stopSOSTrail()
  await starting
  loc.permissionDelayMs = 0
  ok("I'm OK mid-start: nothing is re-armed afterwards", live.size === 0 && !loc.registered.has('sos-ping-task') && active() === null)

  // ── "I'm OK" while a ping is on its way ───────────────────────────────────
  loc.fixDelayMs = 40
  const c = await raiseSOS(base)
  await startSOSTrail(c.id)       // the first ping delivers, then waits on the GPS fix
  await sleep(15)
  await stopSOSTrail()
  await sleep(60)
  loc.fixDelayMs = 0
  ok("I'm OK while a ping is on its way: that ping is dropped", !!(await getSOS(c.id))?.landed_at && pingsFor(c.id) === 0)

  await stopSOSTrail()
  finished = true
  clearTimeout(watchdog)
  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nAll SOS trail invariants hold.')
  process.exit(0)
})()
