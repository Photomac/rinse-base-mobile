#!/usr/bin/env node
// Arrive and leave at each home, for day-shift companies (CKS Perfections,
// 2026-10-23; rinsebase-app 20261023190000_job_site_events).
//
// Runs the REAL src/lib/siteVisitRules.ts under Node's type stripping (pure)
// and checks:
//   • a fence report becomes a crossing only when it changes something (the OS
//     re-reports fences it's already inside), and a leave with nothing before
//     it still counts;
//   • the phone's queue keeps order, drops what the server would refuse as too
//     old, and keeps at most 300, newest kept;
//   • no answer = keep and retry later; a real refusal = drop (a crossing is a
//     record, not pay);
//   • every clean of the day that isn't cancelled is fenced, started and
//     completed ones included;
// and, in the sources:
//   • the arrive/leave path records a row and nothing else: no time entry, no
//     clean status change, no notification;
//   • it is armed only for day-shift companies with the switch on, read on its
//     own (a missing column can't break anything else), with leave fences only
//     there; per-job companies keep enter-only fences and their arrival
//     clock-in, which still never runs for a day-shift company;
//   • a fence left from an earlier day records nothing;
//   • each row goes as INSERT … ON CONFLICT (id) DO NOTHING, sending only the
//     columns the database grants (the web repo's migration, when it's here).
//
// Usage: node scripts/test-site-visits.mjs
//   RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-site-visits.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const read = f => readFileSync(join(repo, f), 'utf8')
const R = await import(join(repo, 'src/lib/siteVisitRules.ts'))

// ── A report becomes a crossing only when it changes something ──────────────
check('first arrival: arrive', R.decideSiteEvent(null, 'enter'), 'arrive')
check('enter again while inside (the OS re-reports on re-registering): nothing', R.decideSiteEvent('in', 'enter'), null)
check('leave after arriving: depart', R.decideSiteEvent('in', 'exit'), 'depart')
check('leave again while outside: nothing', R.decideSiteEvent('out', 'exit'), null)
check('come back after leaving (supply run): arrive', R.decideSiteEvent('out', 'enter'), 'arrive')
check('a leave with nothing before it (inside when the fences went up): depart', R.decideSiteEvent(null, 'exit'), 'depart')

// ── The queue ────────────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-10-23T18:00:00Z')
  const ev = (id, hoursAgo) => ({ id, tenant_id: 't', job_id: 'j', user_id: 'u', kind: 'arrive', at: new Date(now - hoursAgo * 3600_000).toISOString() })
  check('keeps order and fresh crossings', R.pruneSiteQueue([ev('a', 5), ev('b', 1)], now).map(e => e.id), ['a', 'b'])
  check('drops what the server would refuse as too old (47 h+)', R.pruneSiteQueue([ev('old', 47.5), ev('ok', 46.5)], now).map(e => e.id), ['ok'])
  check('drops an unreadable time', R.pruneSiteQueue([{ ...ev('x', 1), at: 'nonsense' }, ev('y', 1)], now).map(e => e.id), ['y'])
  const many = Array.from({ length: 320 }, (_, i) => ev(`e${i}`, 1))
  const kept = R.pruneSiteQueue(many, now)
  check('keeps at most 300, the newest', [kept.length, kept[0].id, kept[kept.length - 1].id], [300, 'e20', 'e319'])
}

// ── After a send ────────────────────────────────────────────────────────────
check('sent', R.siteSendOutcome({ error: null, status: 201 }), 'sent')
check('no answer (status 0): retry later', R.siteSendOutcome({ error: { message: 'Network request failed' }, status: 0 }), 'retry')
check('no status at all: retry later', R.siteSendOutcome({ error: { message: 'x' } }), 'retry')
check('server error: retry later', R.siteSendOutcome({ error: { message: 'x' }, status: 503 }), 'retry')
check('rate limited: retry later', R.siteSendOutcome({ error: { message: 'x' }, status: 429 }), 'retry')
check('session lapsed on a background wake (401, JWT expired): retry once signed in', R.siteSendOutcome({ error: { code: 'PGRST301' }, status: 401 }), 'retry')
check('refused (taken off the clean, switch off: RLS 42501 → 403): drop', R.siteSendOutcome({ error: { code: '42501' }, status: 403 }), 'drop')
check('refused as too old (22023 → 400): drop', R.siteSendOutcome({ error: { code: '22023' }, status: 400 }), 'drop')
check('refused, the clean is gone (23503 → 409): drop', R.siteSendOutcome({ error: { code: '23503' }, status: 409 }), 'drop')

// ── Which cleans are fenced ─────────────────────────────────────────────────
check('every clean of the day but cancelled / no-show, started and completed included',
  [...R.SITE_FENCE_STATUSES].sort(), ['completed', 'en_route', 'in_progress', 'pending_approval', 'scheduled'])

// ── The sources ─────────────────────────────────────────────────────────────
const site = read('src/lib/siteVisits.ts')
const fence = read('src/lib/arrivalGeofence.ts')
const code = src => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

check('the arrive/leave path writes no time entry, no clean, no notification',
  /job_time_entries|from\('jobs'\)|scheduleNotificationAsync|expo-notifications|writeThrough/.test(code(site)), false)
check('it writes job_site_events as INSERT … ON CONFLICT (id) DO NOTHING',
  /from\('job_site_events'\)\.upsert\(head, \{ onConflict: 'id', ignoreDuplicates: true \}\)/.test(site), true)
check('the switch is read on its own (a missing column breaks nothing else)',
  /\.from\('tenants'\)\.select\('site_visits'\)/.test(site), true)
check('the switch is read only through the saved-copy read (a headless wake offline still knows)',
  /cachedQuery\(`site:flag:\$\{tenantId\}`/.test(site), true)

const reg = fence.slice(fence.indexOf('export async function refreshArrivalGeofences'), fence.indexOf('const regionKey'))
check('only a day-shift company gets arrive/leave fences', /const site = user\._timeMode === 'daily'/.test(reg), true)
check('…and only with the switch on (off = no fences)', /if \(site && !\(await siteVisitsOn\(user\.tenant_id\)\)\) \{ await stopArrivalGeofences\(\); return \}/.test(reg), true)
check('leave fences only in that mode', /notifyOnExit: site,/.test(reg), true)
check('per-job companies keep their status list (cleans not started yet)', /site \? SITE_FENCE_STATUSES : \['pending_approval', 'scheduled', 'en_route'\]/.test(reg), true)
check('the fence kind is saved before the OS is asked to watch',
  reg.indexOf('await markSiteFences(') > -1 && reg.indexOf('await markSiteFences(') < reg.indexOf('startGeofencingAsync'), true)
check('a change in leave-watching re-registers', /\$\{r\.notifyOnExit \? '\+exit' : ''\}/.test(fence), true)
check('stopping the fences forgets their kind', /export async function stopArrivalGeofences\(\) \{\n  await markSiteFences\(null\)/.test(fence), true)

const task = fence.slice(fence.indexOf('TaskManager.defineTask(ARRIVAL_TASK'))
const siteBranch = task.slice(task.indexOf("const fence = await siteFenceKind(jobId)"), task.indexOf("if (eventType !== Location.GeofencingEventType.Enter) return"))
check('an arrive/leave fence is handled before (and instead of) the clock-in path',
  siteBranch.length > 0 && /if \(fence !== 'other'\) \{[\s\S]*return\n  \}/.test(siteBranch), true)
check('…recording only, and only for today\'s fences', /if \(fence === 'site' && /.test(siteBranch) && /onSiteCrossing\(jobId/.test(siteBranch) && !/scheduleNotificationAsync|job_time_entries|from\('jobs'\)/.test(siteBranch), true)
check('the arrival clock-in still never runs for a day-shift company', /tenant\?\.auto_clock_in && tenant\?\.time_tracking_mode !== 'daily' && windowOpen/.test(fence), true)
check('a fence from an earlier day is "stale" and records nothing', /return armed\.day === today\(\) \? 'site' : 'stale'/.test(site), true)
check('crossings at one fence are handled one at a time, in order (a leave right after an arrive is kept)',
  /chains\[jobId\] \?\? Promise\.resolve\(\)\)\.then\(\(\) => handleCrossing\(jobId, report, at, centre\)\)/.test(site), true)
check('the crossing time is taken before anything waits', /export function onSiteCrossing\(jobId: string, report: 'enter' \| 'exit', centre: FenceCentre \| null = null\): Promise<void> \{\n  const at = new Date\(\)\.toISOString\(\)/.test(site), true)

// ── Fence marks: in / out and since when ────────────────────────────────────
check('a mark with its time reads', R.readFenceMark(JSON.stringify({ s: 'in', t: 1000 })), { s: 'in', t: 1000 })
check('a bare in / out from the first version still reads, with no time', [R.readFenceMark('in'), R.readFenceMark('out')], [{ s: 'in', t: null }, { s: 'out', t: null }])
check('nothing, or not ours: no mark', [R.readFenceMark(null), R.readFenceMark('{"s":"maybe"}'), R.readFenceMark('garbage')], [null, null, null])

// ── The trail and a leave's time ────────────────────────────────────────────
{
  const home = { lat: 34.8697, lng: -111.7610 }
  // ~111 m per 0.001° of latitude
  const fix = (minAgo, metresNorth, acc = 20) => [T - minAgo * 60_000, home.lat + metresNorth / 111_000, home.lng, acc]
  var T = Date.parse('2026-10-23T18:00:00Z')
  const trail = [fix(50, 10), fix(20, 30), fix(12, 90), fix(11, 260), fix(10, 900)]
  check('the leave is the first position clearly outside after the last inside',
    R.departureFromTrail(trail, home, 150, T), T - 11 * 60_000)
  check('a position just outside but within its own accuracy isn\'t clearly outside: the next one is',
    R.departureFromTrail([fix(12, 90), fix(11, 200, 80), fix(10, 400)], home, 150, T), T - 10 * 60_000)
  check('nothing inside on the trail (off shift, while using only): the report\'s time stands',
    R.departureFromTrail([fix(11, 400), fix(10, 900)], home, 150, T), null)
  check('a long clean, the phone still the whole time: the recorded arrival counts as inside, the first move out is the leave',
    R.departureFromTrail([fix(11, 400), fix(10, 900)], home, 150, T, T - 130 * 60_000), T - 11 * 60_000)
  check('…but a later position inside still wins over the arrival',
    R.departureFromTrail([fix(40, 400), fix(12, 90), fix(11, 400)], home, 150, T, T - 130 * 60_000), T - 11 * 60_000)
  check('…and an arrival after the report is no help', R.departureFromTrail([fix(11, 400)], home, 150, T, T + 60_000), null)
  check('nothing clearly outside yet: the report\'s time stands',
    R.departureFromTrail([fix(12, 90), fix(11, 120)], home, 150, T), null)
  check('positions after the report are not used', R.departureFromTrail([fix(12, 90), fix(-1, 900)], home, 150, T), null)
  check('a leave more than 30 minutes before the report is not trusted',
    R.departureFromTrail([fix(45, 90), fix(40, 900)], home, 150, T), null)
  check('no centre: the report\'s time stands', R.departureFromTrail(trail, null, 150, T), null)
  const kept = R.pruneTrail([fix(70, 0), fix(30, 0), fix(30, 0), fix(5, 0), [NaN, 1, 2, 3], fix(-5, 0)], T)
  check('the trail keeps the last hour, in order, one per instant, no junk or future', kept.map(f => (T - f[0]) / 60_000), [30, 5])
  // 300 positions 6 s apart, from 59 to 29.1 minutes ago: the newest 240 stay (53 to 29.1)
  check('…at most 240, the newest', (() => {
    const k = R.pruneTrail(Array.from({ length: 300 }, (_, i) => fix(59 - i * 0.1, 0)), T)
    const ago = f => Math.round((T - f[0]) / 6000) / 10
    return [k.length, ago(k[0]), ago(k[k.length - 1])]
  })(), [240, 53, 29.1])
}

// ── Start my day from the arrival ───────────────────────────────────────────
{
  const now = Date.parse('2026-10-23T16:10:00Z')
  const m = (s, minAgo) => ({ s, t: now - minAgo * 60_000 })
  check('still at a home reached 20 minutes ago: offered', R.arrivalToOffer([{ jobId: 'geneva', mark: m('in', 20) }], now), { jobId: 'geneva', at: now - 20 * 60_000 })
  check('reached 3 minutes ago: just starts', R.arrivalToOffer([{ jobId: 'geneva', mark: m('in', 3) }], now), null)
  check('left it: nothing', R.arrivalToOffer([{ jobId: 'geneva', mark: m('out', 20) }], now), null)
  check('the office is never offered', R.arrivalToOffer([{ jobId: R.OFFICE_FENCE, mark: m('in', 30) }], now), null)
  check('an old mark (13 h): nothing', R.arrivalToOffer([{ jobId: 'geneva', mark: m('in', 13 * 60) }], now), null)
  check('a first-version mark with no time: nothing', R.arrivalToOffer([{ jobId: 'geneva', mark: { s: 'in', t: null } }], now), null)
  check('two still "in": the newest', R.arrivalToOffer([{ jobId: 'a', mark: m('in', 90) }, { jobId: 'b', mark: m('in', 20) }], now).jobId, 'b')
}

// ── This phone's location setting (lib/locationSettingRules) ───────────────
{
  const L = await import(join(repo, 'src/lib/locationSettingRules.ts'))
  check('the four settings', [
    L.locationSettingFrom({ servicesOn: true, fg: 'granted', bg: 'granted' }),
    L.locationSettingFrom({ servicesOn: true, fg: 'granted', bg: 'denied' }),
    L.locationSettingFrom({ servicesOn: true, fg: 'granted', bg: null }),
    L.locationSettingFrom({ servicesOn: true, fg: 'denied', bg: null }),
    L.locationSettingFrom({ servicesOn: false, fg: 'granted', bg: 'granted' }),
    L.locationSettingFrom({ servicesOn: true, fg: 'undetermined', bg: null }),
  ], ['always', 'while_using', 'while_using', 'off', 'off', 'not_asked'])
  check('precise, both systems', [
    L.preciseFrom('ios', { ios: { accuracy: 'full' } }), L.preciseFrom('ios', { ios: { accuracy: 'reduced' } }),
    L.preciseFrom('android', { android: { accuracy: 'fine' } }), L.preciseFrom('android', { android: { accuracy: 'coarse' } }),
    L.preciseFrom('ios', {}),
  ], [true, false, true, false, null])
  const now = 1_000_000_000
  check('reported when it changed, or twice a day', [
    L.shouldReportLocation(null, 'always|true', now),
    L.shouldReportLocation({ key: 'always|true', at: now - 3600_000 }, 'always|true', now),
    L.shouldReportLocation({ key: 'always|true', at: now - 3600_000 }, 'while_using|true', now),
    L.shouldReportLocation({ key: 'always|true', at: now - 13 * 3600_000 }, 'always|true', now),
  ], [true, false, true, true])
  const cv = read('src/lib/clientVersion.ts')
  check('the report only reads the phone\'s setting, never asks for one', /request[A-Za-z]*PermissionsAsync|ensure(Fore|Back)groundLocation/.test(cv), false)
  check('…on the install row record_client_version keeps', /supabase\.rpc\('record_location_setting', \{\s*p_install_id: await installId\(\), p_setting: setting, p_precise: precise,\s*\}\)/.test(cv), true)
  check('…again on each return to the app', /if \(state === 'active'\) \{\n        drain\(true\)\n[^\n]*\n        reportLocationSetting\(\)/.test(read('App.tsx')), true)
}

// ── The office fence, the trail, Start my day in the sources ────────────────
check('the office is fenced only for arrive/leave, and only on a day with homes',
  reg.indexOf("if (regions.length === 0) { await stopArrivalGeofences(); return }") > -1
  && reg.indexOf('const office = site ? await officeLocation(user.tenant_id) : null') > reg.indexOf("if (regions.length === 0) { await stopArrivalGeofences(); return }")
  && /regions\.push\(\{ identifier: OFFICE_FENCE, latitude: office\.lat, longitude: office\.lng, radius: RADIUS_M, notifyOnEnter: true, notifyOnExit: true \}\)/.test(reg), true)
check('…and its row names no clean', /const clean = office \? null : jobId\n  const place = office \? 'office' : 'home'/.test(site), true)
check('a leave is timed from the trail (inside since the arrival it recorded); an arrive at the report', /const at = kind === 'depart' && centre \? await leaveTimeFromTrail\(centre, reportedAt, last\?\.s === 'in' \? last\.t : null\) : reportedAt/.test(site), true)
check('positions are kept only while today\'s arrive/leave fences are up, and dropped with them', [
  /if \(!raw \|\| JSON\.parse\(raw\)\?\.day !== today\(\)\) return/.test(site),
  /if \(!jobIds\) await AsyncStorage\.multiRemove\(\[ARMED_KEY, TRAIL_KEY\]\)/.test(site)], [true, true])
const tracker = read('src/lib/locationTracker.ts')
check('the tracker keeps the trail only after its working check (off the clock = off the map)',
  tracker.indexOf('noteTrail(locations)') > tracker.indexOf("if (working === false) {\n      await stopLocationTracking()\n      return\n    }\n\n    // Every position"), true)
const dash = read('src/screens/DashboardScreen.tsx')
check('Start my day offers the arrival and marks a picked one; the tap otherwise', [
  /const fromArrival = arrival \? await askStartFrom\(arrival, tappedAt\) : null\n      const startedAt = fromArrival \?\? tappedAt/.test(dash),
  /\.\.\.\(fromArrival \? \{ source: 'prompted', arrived_at: fromArrival \} : \{\}\),/.test(dash),
  /\{ cancelable: false \}/.test(dash)], [true, true, true])

// The row's columns are exactly what the database lets the crew insert.
const rowKeys = (() => {
  const m = site.match(/await recordSiteEvent\(\{([\s\S]*?)\}\)/)
  // `key: value` and shorthand `key`; no value in this literal holds a comma
  return m ? m[1].split(',').map(p => p.trim()).filter(Boolean).map(p => p.split(':')[0].trim()).sort() : []
})()
check('the row sends id, tenant, clean, person, kind, time, place and the fix', rowKeys,
  ['accuracy_m', 'at', 'id', 'job_id', 'kind', 'lat', 'lng', 'place', 'tenant_id', 'user_id'])
const webRepo = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
// The switch's migration, the table's, and the office's (place).
const MIG = /_(tenants_site_visits|job_site_events|job_site_events_office)\.sql$/
let mig = null
try {
  const names = execFileSync('git', ['-C', webRepo, 'ls-tree', '--name-only', 'origin/main', 'supabase/migrations/'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n')
  const fs = names.filter(n => MIG.test(n))
  if (fs.length === 3) mig = fs.map(f => execFileSync('git', ['-C', webRepo, 'show', `origin/main:${f}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).join('\n')
} catch { /* not on main yet */ }
if (!mig) {
  try {
    const dir = join(webRepo, 'supabase/migrations')
    const fs = readdirSync(dir).filter(n => MIG.test(n))
    if (fs.length === 3) mig = fs.map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
  } catch { /* no web repo here */ }
}
if (!mig) {
  console.log('–  grant parity skipped: no tenants_site_visits + job_site_events + job_site_events_office migrations at', webRepo, '(set RINSEBASE_WEB_REPO)')
} else {
  // Every column insert grant on the table, across the migrations.
  const granted = [...mig.matchAll(/grant insert \(([^)]*)\) on public\.job_site_events to authenticated/g)]
    .flatMap(g => g[1].split(',').map(s => s.trim())).sort()
  check("…which is exactly the database's insert grant", granted, rowKeys)
  check('the server refuses a crossing more than 48 h old (the phone gives up at 47)', /now\(\) - interval '48 hours'/.test(mig) && R.SITE_EVENT_MAX_AGE_MS === 47 * 3600_000, true)
  check('the switch is the column the phone reads', /add column if not exists site_visits boolean not null default false/.test(mig), true)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
