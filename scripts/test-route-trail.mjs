#!/usr/bin/env node
// The company's "Record crew routes" switch in the crew app (lib/routeTrail +
// lib/routeTrailRules; rinsebase-app 20261113170000_crew_route_trail).
//
// Checks:
//   • the rules (real module, Node's type stripping): one point per 30 s at
//     most and only after 50 m moving, else one per 5 minutes; nothing less
//     accurate than 250 m; the queue keeps 47 hours and 2,000 points; when a
//     batch is due; the rows sent; which refusals drop a batch for good;
//   • lib/routeTrail itself, copied with its imports stubbed: nothing kept
//     with the switch off or before the notice; kept and sent after "I
//     understand"; the notice once a day after "Not now", never with the
//     switch off or once acknowledged; a batch the server refuses is dropped,
//     one that meets no signal is kept and sent at the next try; one person's
//     queue never goes out under another's name;
//   • the wiring: locationTracker keeps points only after checkWork says
//     working, with its basis, from both the OS task and the foreground ping;
//     the notice only at a work moment (requestBackground); the strings exist
//     in en, es and pt.
//
// Usage: node scripts/test-route-trail.mjs
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(repo, f), 'utf8')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const work = mkdtempSync(join(tmpdir(), 'route-trail-test-'))
try {
  // ── The rules ──
  writeFileSync(join(work, 'routeTrailRules.ts'), read('src/lib/routeTrailRules.ts'))
  const R = await import(pathToFileURL(join(work, 'routeTrailRules.ts')).href)
  const T0 = Date.parse('2026-11-13T14:00:00Z')
  const fix = (sec, lat, lng = -87.65, accuracy = 30) => ({ timestamp: T0 + sec * 1000, coords: { latitude: lat, longitude: lng, accuracy } })

  // Driving north ~13 m/s, a fix every 100 m (~8 s), as the OS task sends them.
  const drive = Array.from({ length: 40 }, (_, k) => fix(k * 8, 41.9 + k * 0.0009))
  const keptDrive = R.thinFixes(null, drive, 'en_route', null)
  check('driving: one point per 30 seconds at most (40 fixes over 5 min 12 s → 10)', keptDrive.length, 10)
  check('… the first fix is always kept', keptDrive[0][0], T0)
  check('… each kept point carries why and the clean', [keptDrive[0][4], keptDrive[0][5]], [null, 'en_route'])
  // Standing still: a fix every minute, jitter of a few metres.
  const still = Array.from({ length: 31 }, (_, k) => fix(k * 60, 41.9 + (k % 2) * 0.0001))
  const keptStill = R.thinFixes(null, still, 'clocked_in', 'job-1')
  check('standing still 30 minutes: one point per 5 minutes (7)', keptStill.length, 7)
  check('… named with the clean they\'re on', keptStill.every(f => f[4] === 'job-1' && f[5] === 'clocked_in'), true)
  check('moving 40 m after 2 minutes is not kept (under 50 m)', R.thinFixes([T0, 41.9, -87.65, 30, null, 'clocked_in'], [fix(120, 41.90036)], 'clocked_in', null).length, 0)
  check('moving 60 m after 40 seconds is kept', R.thinFixes([T0, 41.9, -87.65, 30, null, 'clocked_in'], [fix(40, 41.90054)], 'clocked_in', null).length, 1)
  check('the last kept point carries over between batches (no double point)', R.thinFixes(keptStill[keptStill.length - 1], [still[30]], 'clocked_in', 'job-1').length, 0)
  check('a fix less accurate than 250 m, off the planet, or older than the last kept is left out',
    R.thinFixes([T0 + 600000, 41.9, -87.65, 30, null, 'en_route'], [fix(0, 41.95), fix(900, 41.95, -87.65, 900), fix(1000, 95)], 'en_route', null).length, 0)
  check('out-of-order fixes are sorted first', R.thinFixes(null, [fix(400, 41.92), fix(0, 41.9)], 'en_route', null).map(f => f[0]), [T0, T0 + 400000])

  const now = T0 + 48 * 3600 * 1000
  const q = [[now - 48 * 3600 * 1000, 1, 1, 5, null, 'en_route'], [now - 46 * 3600 * 1000, 1, 1, 5, null, 'clocked_in'], [now - 60000, 1, 1, null, 'j', 'clocked_in'],
             [now - 60000, 1, 1, null, 'j', 'clocked_in'], [now - 30000, 1, 1, null, null, 'off_clock'], ['x']]
  check('the queue keeps 47 hours, one per instant, only working points', R.pruneQueue(q, now).map(f => f[0]), [now - 46 * 3600 * 1000, now - 60000])
  check('… and the newest 2,000', R.pruneQueue(Array.from({ length: 2100 }, (_, k) => [now - k * 1000, 1, 1, null, null, 'en_route']), now).length, 2000)
  check('a batch is due at 60 points, after 4 minutes, or forced; never empty',
    [R.flushDue(60, now, now), R.flushDue(5, now - 240000, now), R.flushDue(5, now - 60000, now), R.flushDue(1, now, now, true), R.flushDue(0, 0, now, true)],
    [true, true, false, true, false])
  check('the rows sent are the table\'s insertable columns, nothing else',
    R.toRows([[T0, 41.9, -87.65, 30, 'job-1', 'clocked_in']], 'u1', 't1'),
    [{ user_id: 'u1', at: '2026-11-13T14:00:00.000Z', tenant_id: 't1', lat: 41.9, lng: -87.65, accuracy_m: 30, job_id: 'job-1', basis: 'clocked_in' }])
  check('a rule, grant, CHECK, bad value or missing table drops the batch; no signal or a 5xx keeps it',
    [{ code: '42501' }, { code: '23514' }, { code: '42P01' }, { code: '42P10' }, { code: 'PGRST205' }, { code: '' , status: 0 }, { code: '57014' }, null].map(R.refusedForGood),
    [true, true, true, true, true, false, false, false])

  // ── lib/routeTrail, imports stubbed ──
  const store = new Map()
  const S = { switchOn: false, acksOnServer: [], inserts: [], failNext: null, alerts: [] }
  globalThis.__RT = { store, S }
  writeFileSync(join(work, 'async-storage.ts'), `const { store } = (globalThis as any).__RT
export default {
  getItem: async (k: string) => (store.has(k) ? store.get(k) : null),
  setItem: async (k: string, v: string) => { store.set(k, v) },
  removeItem: async (k: string) => { store.delete(k) },
  multiSet: async (pairs: [string, string][]) => { for (const [k, v] of pairs) store.set(k, v) },
}`)
  writeFileSync(join(work, 'react-native.ts'), `const { S } = (globalThis as any).__RT
export const Alert = { alert: (title: string, body: string, buttons: any[]) => { S.alerts.push({ title, body, buttons }) } }`)
  writeFileSync(join(work, 'i18n.ts'), `export const tStatic = (k: string) => k
export const langStatic = () => 'es'`)
  writeFileSync(join(work, 'dataCache.ts'), `export async function cachedQuery(_k: string, q: any) { const r = await q; return { data: r.data, error: r.error, fromCache: false } }`)
  writeFileSync(join(work, 'supabase.ts'), `const { S } = (globalThis as any).__RT
function from(table: string) {
  const b: any = { _table: table, _f: {} as any }
  b.select = () => b; b.eq = (c: string, v: any) => { b._f[c] = v; return b }; b.gte = () => b; b.limit = () => b
  b.maybeSingle = () => b
  b.then = (res: any, rej: any) => Promise.resolve(run(b)).then(res, rej)
  b.upsert = (rows: any, opts: any) => Promise.resolve(write(table, rows, opts))
  return b
}
function run(b: any) {
  if (b._table === 'tenants') return { data: { route_trail: S.switchOn }, error: null }
  if (b._table === 'route_trail_acks') return { data: S.acksOnServer.filter((a: any) => a.user_id === b._f.user_id && a.tenant_id === b._f.tenant_id), error: null }
  return { data: null, error: null }
}
function write(table: string, rows: any, opts: any) {
  if (S.failNext) { const e = S.failNext; S.failNext = null; return { error: e } }
  if (table === 'route_trail_acks') { S.acksOnServer.push(rows); return { error: null } }
  S.inserts.push({ table, rows, opts })
  return { error: null }
}
export const supabase = { from }`)
  writeFileSync(join(work, 'routeTrail.ts'), read('src/lib/routeTrail.ts')
    .replace(`from 'react-native'`, `from './react-native.ts'`)
    .replace(`from '@react-native-async-storage/async-storage'`, `from './async-storage.ts'`)
    .replace(`from './supabase'`, `from './supabase.ts'`)
    .replace(`from './dataCache'`, `from './dataCache.ts'`)
    .replace(`from './i18n'`, `from './i18n.ts'`)
    .replace(`from './routeTrailRules'`, `from './routeTrailRules.ts'`))
  const RT = await import(pathToFileURL(join(work, 'routeTrail.ts')).href)
  const ME = { id: 'user-cl', tenant_id: 'tenant-a' }
  const OTHER = { id: 'user-ld', tenant_id: 'tenant-a' }
  const nowFix = (offsetSec, lat) => ({ timestamp: Date.now() - 3600_000 + offsetSec * 1000, coords: { latitude: lat, longitude: -87.65, accuracy: 20 } })
  const queued = (u = ME) => JSON.parse(store.get(`route_trail:queue:${u.id}`) || '[]').length

  // Switch off: nothing kept, no notice.
  await RT.noteRoute(ME, [nowFix(0, 41.9)], 'clocked_in', 'job-1')
  check('switch off: nothing kept, nothing sent', [queued(), S.inserts.length], [0, 0])
  await RT.maybeShowRouteNotice(ME)
  check('switch off: no notice', S.alerts.length, 0)

  // Switch on, notice not acknowledged.
  S.switchOn = true
  await RT.noteRoute(ME, [nowFix(0, 41.9)], 'clocked_in', 'job-1')
  check('switch on, no notice yet: nothing kept', queued(), 0)
  await RT.maybeShowRouteNotice(ME)
  check('the notice is shown, with I understand and Not now', [S.alerts.length, S.alerts[0]?.title, S.alerts[0]?.buttons.map(b => b.text)],
    [1, 'route_notice_title', ['route_notice_later', 'route_notice_ok']])
  S.alerts[0].buttons[0].onPress()
  await new Promise(r => setTimeout(r, 0))
  await RT.maybeShowRouteNotice(ME)
  check('"Not now": not asked again the same day', S.alerts.length, 1)
  store.delete(`route_trail:declined:${ME.id}`)
  await RT.maybeShowRouteNotice(ME)
  check('… asked again another day', S.alerts.length, 2)
  S.alerts[1].buttons[1].onPress()
  await new Promise(r => setTimeout(r, 10))
  check('"I understand": the acknowledgment is written as the person, in their language, version 1, replay-safe',
    [S.acksOnServer.length, S.acksOnServer[0]], [1, { user_id: 'user-cl', notice_version: 1, tenant_id: 'tenant-a', lang: 'es' }])
  await RT.maybeShowRouteNotice(ME)
  check('once acknowledged, never asked again', S.alerts.length, 2)
  check('the acknowledgment replays on (user_id, tenant_id, notice_version)', /onConflict: 'user_id,tenant_id,notice_version', ignoreDuplicates: true/.test(read('src/lib/routeTrail.ts')), true)
  await RT.maybeShowRouteNotice({ id: 'user-cl', tenant_id: 'tenant-b' })
  check('the same person in another company is asked there', S.alerts.length, 3)

  // Kept and sent: the first batch goes at once, then every 4 minutes or 60 points.
  await RT.noteRoute(ME, [nowFix(0, 41.9), nowFix(40, 41.901), nowFix(80, 41.902)], 'en_route', null)
  check('acknowledged: the first points go at once — one request, the person\'s rows, upsert on (user_id, at) ignoring duplicates',
    [S.inserts.length, S.inserts[0].table, S.inserts[0].rows.length, S.inserts[0].rows.every(r => r.user_id === 'user-cl' && r.tenant_id === 'tenant-a'),
     S.inserts[0].opts], [1, 'crew_location_points', 3, true, { onConflict: 'user_id,at', ignoreDuplicates: true }])
  check('… and the queue is empty', queued(), 0)

  // No signal: kept for the next try. A refusal: dropped.
  await RT.noteRoute(ME, [nowFix(400, 41.91)], 'clocked_in', 'job-2')
  check('the next point waits for the batch (sent a moment ago)', [queued(), S.inserts.length], [1, 1])
  S.failNext = { code: '', message: 'Network request failed', status: 0 }
  await RT.flushRoute(ME, true)
  check('no signal: the point stays queued', [queued(), S.inserts.length], [1, 1])
  await RT.flushRoute(ME, true)
  check('… and goes at the next try', [queued(), S.inserts.length, S.inserts[1]?.rows[0]?.job_id], [0, 2, 'job-2'])
  await RT.noteRoute(ME, [nowFix(800, 41.92)], 'clocked_in', null)
  S.failNext = { code: '42501', message: 'new row violates row-level security policy' }
  await RT.flushRoute(ME, true)
  check('a refusal for good: dropped, never retried forever', [queued(), S.inserts.length], [0, 2])

  // Two people on one phone: each queue goes out under its own name.
  S.acksOnServer.push({ user_id: 'user-ld', notice_version: 1, tenant_id: 'tenant-a', lang: 'pt' })
  await RT.noteRoute(OTHER, [nowFix(900, 41.93)], 'clocked_in', null)
  check('another person on the same phone: their point goes under their own name', [S.inserts.length, S.inserts[2]?.rows.map(r => r.user_id)], [3, ['user-ld']])
  await RT.flushRoute(ME, true)
  check('… and this person\'s send carries none of theirs', S.inserts.length, 3)
  check('… found acknowledged on the server (another phone) and remembered, for that company', store.get(`route_trail:ack:user-ld:tenant-a:v1`), '1')

  // A null basis (can't tell if working) keeps nothing.
  await RT.noteRoute(ME, [nowFix(1200, 41.95)], null, null)
  check('no basis (offline, can\'t tell): nothing kept', queued(), 0)

  // ── Wiring ──
  const tracker = read('src/lib/locationTracker.ts')
  const task = tracker.split('TaskManager.defineTask(LOCATION_TASK')[1].split('async function pingLocation')[0]
  const ping = tracker.split('async function pingLocation')[1]
  const keptAfter = (body) => body.indexOf('noteRoute(') > body.indexOf('if (working === false)') && body.indexOf('if (working === false)') > 0
  check('the OS task keeps the whole batch, after the working check, with its basis', [keptAfter(task), /noteRoute\(user, locations, basis, activeJob\?\.id \|\| null\)/.test(task)], [true, true])
  check('the foreground ping keeps its fix, after the working check, with its basis', [keptAfter(ping), /noteRoute\(user, \[loc\], basis, activeJob\?\.id \|\| null\)/.test(ping)], [true, true])
  check('checkWork says why: clocked in or en route, never anything else',
    (tracker.match(/basis: 'clocked_in'/g) || []).length === 2 && /'clocked_in' : 'en_route'/.test(tracker) && !/basis: '(?!clocked_in)/.test(tracker), true)
  check('the notice only at a work moment (requestBackground), never on plain launch', /if \(opts\?\.requestBackground\) maybeShowRouteNotice\(user\)/.test(tracker), true)
  check('stopping sends what is queued without waiting on the network', /\n  flushRoute\(currentUser, true\)\.catch/.test(tracker), true)
  check('nothing here starts the location task (routeTrail never calls expo-location)', /expo-location|startLocationUpdatesAsync/.test(read('src/lib/routeTrail.ts')), false)
  const i18n = read('src/lib/i18n.ts')
  check('the notice strings exist in en, es and pt',
    ['route_notice_title', 'route_notice_body', 'route_notice_ok', 'route_notice_later'].map(k => (i18n.match(new RegExp(`\\n    ${k}: `, 'g')) || []).length), [3, 3, 3, 3])
  check('the notice says when (working only), what the office sees, and 30 days — in each language',
    [/clocked in or on your way to a clean[\s\S]*route and any stops[\s\S]*off the clock[\s\S]*30 days/, /entrada marcada o vas en camino[\s\S]*recorrido y tus paradas[\s\S]*no estás trabajando[\s\S]*30 días/,
     /ponto batido ou a caminho[\s\S]*trajeto e suas paradas[\s\S]*não está trabalhando[\s\S]*30 dias/].map(r => r.test(i18n)), [true, true, true])
} finally {
  rmSync(work, { recursive: true, force: true })
  delete globalThis.__RT
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
