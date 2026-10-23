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
check('crossings at one home are handled one at a time, in order (a leave right after an arrive is kept)',
  /chains\[jobId\] \?\? Promise\.resolve\(\)\)\.then\(\(\) => handleCrossing\(jobId, report, at\)\)/.test(site), true)
check('the crossing time is taken before anything waits', /export function onSiteCrossing\(jobId: string, report: 'enter' \| 'exit'\): Promise<void> \{\n  const at = new Date\(\)\.toISOString\(\)/.test(site), true)

// The row's columns are exactly what the database lets the crew insert.
const rowKeys = (() => {
  const m = site.match(/await recordSiteEvent\(\{([\s\S]*?)\}\)/)
  // `key: value` and shorthand `key`; no value in this literal holds a comma
  return m ? m[1].split(',').map(p => p.trim()).filter(Boolean).map(p => p.split(':')[0].trim()).sort() : []
})()
check('the row sends id, tenant, clean, person, kind, time and the fix', rowKeys,
  ['accuracy_m', 'at', 'id', 'job_id', 'kind', 'lat', 'lng', 'tenant_id', 'user_id'])
const webRepo = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
// The switch's migration and the table's.
const MIG = /_(tenants_site_visits|job_site_events)\.sql$/
let mig = null
try {
  const names = execFileSync('git', ['-C', webRepo, 'ls-tree', '--name-only', 'origin/main', 'supabase/migrations/'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n')
  const fs = names.filter(n => MIG.test(n))
  if (fs.length === 2) mig = fs.map(f => execFileSync('git', ['-C', webRepo, 'show', `origin/main:${f}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).join('\n')
} catch { /* not on main yet */ }
if (!mig) {
  try {
    const dir = join(webRepo, 'supabase/migrations')
    const fs = readdirSync(dir).filter(n => MIG.test(n))
    if (fs.length === 2) mig = fs.map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
  } catch { /* no web repo here */ }
}
if (!mig) {
  console.log('–  grant parity skipped: no tenants_site_visits + job_site_events migrations at', webRepo, '(set RINSEBASE_WEB_REPO)')
} else {
  const g = mig.match(/grant insert \(([^)]*)\) on public\.job_site_events to authenticated/)
  const granted = g ? g[1].split(',').map(s => s.trim()).sort() : null
  check("…which is exactly the database's insert grant", granted, rowKeys)
  check('the server refuses a crossing more than 48 h old (the phone gives up at 47)', /now\(\) - interval '48 hours'/.test(mig) && R.SITE_EVENT_MAX_AGE_MS === 47 * 3600_000, true)
  check('the switch is the column the phone reads', /add column if not exists site_visits boolean not null default false/.test(mig), true)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
