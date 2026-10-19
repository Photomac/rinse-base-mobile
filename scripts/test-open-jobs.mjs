#!/usr/bin/env node
// The Open jobs badge and the Open jobs list agree.
//
// Runs the REAL src/lib/openJobs.ts under Node's type stripping (it is pure),
// on Arise Properties' board as the database had it on 2026-10-19 (8 open
// cleans, all 63 to 106 days out, under a badge that said 8 over an empty
// list), and checks:
//   • every one of those 8 is on the list, and the badge counts 8;
//   • a staffed clean with no spot left (1/1) is on neither;
//   • a clean with its first person on but a second spot open (1/2) is on
//     both (the old badge counted crew_filled, so it left that one out);
//   • a clean still in its crew-first window shows only to that crew;
//   • past, cancelled and taken-back cleans are on neither;
//   • the server filter has no date horizon (no .lte on scheduled_start);
// and, in the app, that the badge (App.tsx) and the list (OpenJobsScreen)
// both read through boardQuery() and count through boardJobsFor().
//
// Usage: node scripts/test-open-jobs.mjs
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
const { boardQuery, boardJobsFor, isOpenJob, offeredFirstTo, BOARD_LIMIT } = await import(join(repo, 'src/lib/openJobs.ts'))

const NOW = Date.parse('2026-10-19T17:57:00Z')
const DAKOTA = '5e353101-2c9b-49b0-acda-f608d7ebbaba'
const LAURA = 'laura-0000'
const opened = '2026-10-14T22:42:48Z'
const job = (n, start, extra = {}) => ({
  job_number: n, status: 'scheduled', scheduled_start: start, max_crew: 1,
  open_for_claims_at: opened, open_to_all_at: null,
  client_addresses: { default_crew: [] }, job_assignments: [], ...extra,
})
const on = (...ids) => ids.map(user_id => ({ user_id }))

// Arise, 2026-10-19: the 8 unclaimed board cleans, plus a few staffed ones.
const arise = [
  job(415, '2026-10-25T17:00:00Z', { job_assignments: on(DAKOTA) }),  // Decameron, claimed
  job(34, '2026-12-02T17:00:00Z', { job_assignments: on(DAKOTA) }),   // Adale, claimed
  job(381, '2026-12-22T17:00:00Z'),  // Adale            63 days out
  job(406, '2026-12-22T17:00:00Z'),  // Stovall Pad Share
  job(35, '2026-12-27T17:00:00Z'),   // Adale
  job(40, '2026-12-27T18:00:00Z'),   // Decameron
  job(382, '2027-01-03T18:00:00Z'),  // Decameron
  job(407, '2027-01-05T17:00:00Z'),  // Stovall Pad Share
  job(408, '2027-01-19T17:00:00Z'),  // Stovall Pad Share
  job(409, '2027-02-02T17:00:00Z'),  // Stovall Pad Share 106 days out
  job(401, '2027-03-11T16:00:00Z', { job_assignments: on(DAKOTA) }),  // Beartooth, claimed
]
const nums = rows => rows.map(j => j.job_number)
const eight = [381, 406, 35, 40, 382, 407, 408, 409]

check('Arise: Laura sees all 8 open cleans', nums(boardJobsFor(arise, LAURA, NOW)), eight)
check('Arise: the badge counts the same 8', boardJobsFor(arise, LAURA, NOW).length, 8)
check('Arise: Dakota sees the same 8 (her own claims are full)', nums(boardJobsFor(arise, DAKOTA, NOW)), eight)

const twoSpots = job(500, '2026-11-01T16:00:00Z', { max_crew: 2, job_assignments: on(DAKOTA) })
check('1 of 2 spots taken: still open to the next person', isOpenJob(twoSpots, NOW), true)
check('1 of 1 spot taken: off the board', isOpenJob(job(501, '2026-11-01T16:00:00Z', { job_assignments: on(DAKOTA) }), NOW), false)
check('a clean that already started: off the board', isOpenJob(job(502, '2026-10-19T15:00:00Z'), NOW), false)
check('a cancelled clean: off the board', isOpenJob(job(503, '2026-11-01T16:00:00Z', { status: 'cancelled' }), NOW), false)
check('taken back by the office: off the board', isOpenJob(job(504, '2026-11-01T16:00:00Z', { open_for_claims_at: null }), NOW), false)
check('a clean waiting on approval: on the board', isOpenJob(job(505, '2026-11-01T16:00:00Z', { status: 'pending_approval' }), NOW), true)
check('a year out: still on the board', isOpenJob(job(506, '2027-10-19T16:00:00Z'), NOW), true)

const firstPick = job(510, '2026-11-20T16:00:00Z', {
  open_to_all_at: '2026-11-18T16:00:00Z', client_addresses: { default_crew: [DAKOTA] },
})
check('crew-first window: offered to the property crew', offeredFirstTo(firstPick, DAKOTA, NOW), 'me')
check('crew-first window: hidden from everyone else', boardJobsFor([firstPick], LAURA, NOW).length, 0)
check('crew-first window over: everyone', offeredFirstTo(firstPick, LAURA, Date.parse('2026-11-18T16:00:01Z')), 'all')

// The server filter, recorded through a stand-in for the supabase-js builder.
const calls = []
const builder = new Proxy({}, { get: (_, m) => (...args) => { calls.push([m, ...args]); return builder } })
boardQuery(builder, 'tenant-1', new Date(NOW))
check('server filter: tenant, on the board, eligible status, future, soonest first', calls, [
  ['eq', 'tenant_id', 'tenant-1'],
  ['not', 'open_for_claims_at', 'is', null],
  ['in', 'status', ['pending_approval', 'scheduled']],
  ['gt', 'scheduled_start', new Date(NOW).toISOString()],
  ['order', 'scheduled_start'],
  ['limit', BOARD_LIMIT],
])
check('server filter: no date horizon', calls.some(c => c[0] === 'lte'), false)

// Both reads in the app go through the shared rule.
const app = readFileSync(join(repo, 'App.tsx'), 'utf8')
const screen = readFileSync(join(repo, 'src/screens/OpenJobsScreen.tsx'), 'utf8')
const badge = app.slice(app.indexOf('const refreshOpenJobs'), app.indexOf('useEffect(', app.indexOf('const refreshOpenJobs')))
check('badge reads through boardQuery()', /boardQuery\(supabase\.from\('jobs'\)/.test(badge), true)
check('badge counts through boardJobsFor()', /setOpenJobsCount\(boardJobsFor\(/.test(badge), true)
check('badge embeds what isOpenJob() needs', ['status', 'scheduled_start', 'max_crew', 'open_for_claims_at', 'open_to_all_at', 'default_crew', 'job_assignments('].every(c => badge.includes(c)), true)
check('badge no longer filters on crew_filled', badge.includes('crew_filled'), false)
check('list reads through boardQuery()', /boardQuery\(supabase\s*\.from\('jobs'\)/.test(screen), true)
check('list filters through boardJobsFor()', /setJobs\(boardJobsFor\(rows/.test(screen), true)
check('list has no horizon of its own', /HORIZON|\.lte\(/.test(screen), false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
