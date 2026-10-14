#!/usr/bin/env node
// "Mine / Everyone" on Home and Schedule, for the office.
//
// Runs the REAL src/lib/jobScope.ts under Node's type stripping (it is pure),
// on a day shaped like CKS Perfections' 2026-10-12 (28 route stops, the owner
// cleaning some of them), and checks:
//   • Mine = the jobs the viewer has a job_assignments row on, read from the
//     PLAIN embed, never the aliased crew: one; a job with no assignees is
//     nobody's; Everyone leaves the list untouched (the default changes nothing);
//   • the owner on 0, 1 and all of the day's jobs: list, Today / Done /
//     Remaining, active and next job, and "Stop k of M" renumbered over her
//     own stops;
//   • cancelled jobs: kept as cards for whoever is on them, never counted,
//     never given a stop number;
// and, in the screens, that only the office gets the toggle, that crew still
// filter with the same predicate Mine uses, and that every query Mine reads
// carries the plain job_assignments(user_id) embed.
//
// Usage: node scripts/test-mine-filter.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const { isOfficeRole, parseJobScope, isMyJob, jobsInScope, routeStops, dayView } = await import(join(repo, 'src/lib/jobScope.ts'))

const OWNER = 'catherine', CREW_A = 'tasia', CREW_B = 'marin'
const ids = rows => rows.map(j => j.id)
const stopsOf = v => Object.fromEntries(v.jobs.filter(j => v.stops[j.id]).map(j => [j.id, `${v.stops[j.id].k}/${v.stops[j.id].m}`]))
const counts = v => ({ today: v.jobs.length, done: v.done, remaining: v.remaining })

// A 28-stop day in working order. Stop n is job s<n>; the owner is on 3, 7,
// 12, 20 and 26 (on 7 with Tasia); everyone else is crew.
const MINE = new Set([3, 7, 12, 20, 26])
const day = Array.from({ length: 28 }, (_, i) => {
  const n = i + 1
  const crew = MINE.has(n) ? (n === 7 ? [OWNER, CREW_A] : [OWNER]) : [n % 2 ? CREW_A : CREW_B]
  return {
    id: `s${n}`, route_order: n,
    status: n <= 4 ? 'completed' : n === 7 ? 'in_progress' : 'scheduled',
    job_assignments: crew.map(user_id => ({ user_id })),
  }
})

// ── roles and the saved choice ───────────────────────────────────────────────
check('only the office gets the toggle',
  ['owner', 'manager', 'dispatcher', 'lead_cleaner', 'cleaner', 'trainee', 'inspector', '', null, undefined].map(isOfficeRole),
  [true, true, true, false, false, false, false, false, false, false])
check('nothing saved yet, or junk, is Everyone; only an explicit "mine" narrows',
  [null, undefined, '', 'everyone', 'mine', 'Mine', '"mine"', 1].map(parseJobScope),
  ['everyone', 'everyone', 'everyone', 'everyone', 'mine', 'everyone', 'everyone', 'everyone'])

// ── who a job belongs to ─────────────────────────────────────────────────────
check('on the job → mine; on someone else\'s → not', [isMyJob(day[2], OWNER), isMyJob(day[0], OWNER)], [true, false])
check('a job with no assignees is nobody\'s',
  [isMyJob({ id: 'x', job_assignments: [] }, OWNER), isMyJob({ id: 'x', job_assignments: null }, OWNER), isMyJob({ id: 'x' }, OWNER), isMyJob(null, OWNER)],
  [false, false, false, false])
check('reads the plain job_assignments embed, never the aliased crew: one',
  isMyJob({ id: 'x', job_assignments: [], crew: [{ user_id: OWNER, is_lead: true }] }, OWNER), false)
check('Everyone hands back the very same list (the default changes nothing)', jobsInScope(day, OWNER, 'everyone') === day, true)

// ── the owner on some of the day: CKS's 28 stops ─────────────────────────────
const everyone = dayView(day, OWNER, 'everyone')
const mine = dayView(day, OWNER, 'mine')
check('Everyone: all 28 stops, counted as before', counts(everyone), { today: 28, done: 4, remaining: 24 })
check('Everyone: stops keep the company route', [everyone.stops.s3, everyone.stops.s28], [{ k: 3, m: 28 }, { k: 28, m: 28 }])
check('Mine: just her five, in working order', ids(mine.jobs), ['s3', 's7', 's12', 's20', 's26'])
check('Mine: Today / Done / Remaining count only hers', counts(mine), { today: 5, done: 1, remaining: 4 })
check('Mine: "Stop k of M" renumbered over her own stops', stopsOf(mine), { s3: '1/5', s7: '2/5', s12: '3/5', s20: '4/5', s26: '5/5' })
check('Mine: the active clean is hers (she is on s7 with Tasia)', mine.active?.id, 's7')
check('Mine: next is her next scheduled stop, not the company\'s', [everyone.next?.id, mine.next?.id], ['s5', 's12'])

// ── owner on 0, 1 and all of the day's jobs ──────────────────────────────────
const none = dayView(day, 'nobody-on-it', 'mine')
check('owner on 0 jobs: Mine is empty, every count 0, no active/next, no stops',
  [counts(none), none.active, none.next, none.stops, none.cancelled], [{ today: 0, done: 0, remaining: 0 }, null, null, {}, []])
check('owner on 0 jobs: Everyone still shows the whole day', counts(dayView(day, 'nobody-on-it', 'everyone')), { today: 28, done: 4, remaining: 24 })

const oneDay = day.map(j => j.id === 's12' ? { ...j, job_assignments: [{ user_id: 'solo' }] } : j)
const one = dayView(oneDay, 'solo', 'mine')
check('owner on 1 job: just it, Stop 1 of 1, and it is next',
  [ids(one.jobs), counts(one), one.stops, one.next?.id, one.active], [['s12'], { today: 1, done: 0, remaining: 1 }, { s12: { k: 1, m: 1 } }, 's12', null])

const allDay = day.map(j => ({ ...j, job_assignments: [...j.job_assignments, { user_id: 'everywhere' }] }))
const allMine = dayView(allDay, 'everywhere', 'mine')
const allEveryone = dayView(allDay, 'everywhere', 'everyone')
check('owner on all jobs: Mine and Everyone are the same day',
  [ids(allMine.jobs), counts(allMine), allMine.stops, allMine.active?.id, allMine.next?.id],
  [ids(allEveryone.jobs), counts(allEveryone), allEveryone.stops, allEveryone.active?.id, allEveryone.next?.id])

// ── a job with no assignees ──────────────────────────────────────────────────
const withOrphan = [...day.slice(0, 4), { id: 'orphan', route_order: 4.5, status: 'scheduled', job_assignments: [] }, ...day.slice(4)]
check('no assignees: shown under Everyone (the office sees "No crew assigned") and numbered in the route',
  [everyone.jobs.length + 1 === dayView(withOrphan, OWNER, 'everyone').jobs.length, dayView(withOrphan, OWNER, 'everyone').stops.orphan], [true, { k: 5, m: 29 }])
check('no assignees: never under Mine, and Mine\'s numbers don\'t move',
  [ids(dayView(withOrphan, OWNER, 'mine').jobs), stopsOf(dayView(withOrphan, OWNER, 'mine'))], [ids(mine.jobs), stopsOf(mine)])

// ── cancelled jobs ───────────────────────────────────────────────────────────
const withCancelled = [
  ...day,
  { id: 'c-hers', route_order: 29, status: 'cancelled', job_assignments: [{ user_id: OWNER }] },
  { id: 'c-theirs', route_order: 30, status: 'cancelled', job_assignments: [{ user_id: CREW_B }] },
]
const cMine = dayView(withCancelled, OWNER, 'mine')
const cEveryone = dayView(withCancelled, OWNER, 'everyone')
check('cancelled: Everyone shows both cancelled cards', ids(cEveryone.cancelled), ['c-hers', 'c-theirs'])
check('cancelled: Mine shows only the one she was on', ids(cMine.cancelled), ['c-hers'])
check('cancelled: never counted, never in the list', [counts(cMine), counts(cEveryone), cMine.jobs.some(j => j.status === 'cancelled')],
  [{ today: 5, done: 1, remaining: 4 }, { today: 28, done: 4, remaining: 24 }, false])
check('cancelled: no stop number, and the live stops stay 1..M', [cMine.stops['c-hers'], cEveryone.stops['c-theirs'], stopsOf(cMine)],
  [undefined, undefined, stopsOf(mine)])

// ── route_order gaps ─────────────────────────────────────────────────────────
check('only jobs with a route order get a stop; the rest are skipped, not counted',
  routeStops([{ id: 'a', route_order: 9 }, { id: 'b', route_order: null }, { id: 'c', route_order: 2 }, { id: 'd' }]),
  { c: { k: 1, m: 2 }, a: { k: 2, m: 2 } })

// ── screens ──────────────────────────────────────────────────────────────────
const dash = readFileSync(join(repo, 'src/screens/DashboardScreen.tsx'), 'utf8')
const sched = readFileSync(join(repo, 'src/screens/ScheduleScreen.tsx'), 'utf8')
const hook = readFileSync(join(repo, 'src/lib/useJobScope.ts'), 'utf8')
// Home's day read and its today filter live in src/lib/jobReads.ts (shared
// with the offline day pack).
const reads = readFileSync(join(repo, 'src/lib/jobReads.ts'), 'utf8')
check('the toggle renders for the office only, on both screens',
  [/\{isOffice && \(\s*<View style=\{styles\.scopeRow\}>\s*<JobScopeToggle scope=\{scope\} onChange=\{setScope\} \/>/.test(dash),
   /\{isOffice && \(\s*<View style=\{styles\.scopeRow\}>\s*<JobScopeToggle scope=\{scope\} onChange=\{setScope\} \/>/.test(sched)], [true, true])
check('crew are never narrowed again by the scope (their rows are already their own)',
  [/const viewScope: JobScope = isOffice \? scope : 'everyone'/.test(dash), /const viewScope: JobScope = isOffice \? scope : 'everyone'/.test(sched)], [true, true])
check('crew rows are filtered with the same predicate Mine uses',
  [(dash.match(/\.filter\(\(j: any\) => isMyJob\(j, user\.id\)\)/g) || []).length, (sched.match(/\.filter\(\(j: any\) => isMyJob\(j, user\.id\)\)/g) || []).length,
   /homeDayRows\(todayRes\.data, user, today\)/.test(dash), /\(rows \?\? \[\]\)\.filter\(j => isMyJob\(j, user\.id\)\)/.test(reads)], [1, 1, true, true])
check('no inline job_assignments ownership check left on either screen',
  /job_assignments\?\.some/.test(dash + sched), false)
const query = (src, from, to) => { const i = src.indexOf(from); return i < 0 ? '' : src.slice(i, src.indexOf(to, i)) }
const ownerMonth = query(dash, 'cachedQuery(`dash:month:', ': supabase.from')
check('every query Mine reads carries the plain job_assignments(user_id) embed',
  [query(reads, 'export function dashTodayRead(', 'export function homeDayRows('), ownerMonth, query(dash, 'cachedQuery(`dash:stranded:', 'job_time_entries'), query(sched, 'cachedQuery(`sched:', 'setOffline')]
    .map(q => /job_assignments(!job_assignments_job_id_fkey)?\(user_id\)/.test(q)), [true, true, true, true])
check('Home\'s counts and stop badge come from the scoped day',
  [/\{day\.done\}/.test(dash), /\{day\.remaining\}/.test(dash), /listItems\(day\.jobs, day\.stops, groups\)/.test(dash), /<PrepCard user=\{user\} jobs=\{todayJobs\}/.test(dash)], [true, true, true, true])
check('Schedule\'s grid, day list and count read the scoped jobs',
  [/for \(const j of shown\)/.test(sched), /String\(shown\.length\)/.test(sched)], [true, true])
check('the choice is saved per user on the phone, Everyone until read',
  [/`jobScope:\$\{userId\}`/.test(hook), /scopes\.get\(userId\) \?\? 'everyone'/.test(hook), /parseJobScope\(raw\)/.test(hook)], [true, true, true])

const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
for (const key of ['scope_mine', 'scope_everyone', 'no_jobs_today_mine', 'no_jobs_day_mine']) {
  check(`"${key}" in all three languages`, (i18n.match(new RegExp(`\\n    ${key}: ['"]`, 'g')) || []).length, 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
