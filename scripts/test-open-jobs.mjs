#!/usr/bin/env node
// The Open jobs badge and the Open jobs list agree, and neither hands an
// unclaimed clean's client or door code to the phone.
//
// Runs the REAL src/lib/openJobs.ts under Node's type stripping (it is pure).
// Since crew read scope stage 1 both read open_board_jobs() (rinse-base-app
// 20261113171611), which lists for crew the cleans they could claim now plus
// the board cleans they claimed, and for the office every board clean. On
// rows shaped like its answer, it checks:
//   • the RPC's rows become card rows: id, the place (nickname or street),
//     its city and clock, the service, the calendar mark, the spots; and
//     nothing else (no client, no lockbox, no notes); a copy saved by an
//     older app (jobs rows) reads as nothing rather than as broken cards;
//   • Arise Properties' board as it stood on 2026-10-19 (8 open cleans under
//     a badge of 8): all 8 on the list, and the badge counts 8;
//   • a staffed clean with no spot left (1/1) is off the list but stays under
//     "yours" for the person who claimed it; one with a spot left (1/2) is on;
//   • a clean still in its crew-first window shows only to whom the RPC says
//     it is offered; past and cancelled cleans are on neither;
// and, in the app, that the badge (App.tsx) and the list (OpenJobsScreen)
// both read open_board_jobs() and count through boardJobsFor(), that the
// list reads no jobs table, and that a card opens its clean through
// scheduleJobById() (the full row, once it is the person's).
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
const { boardRows, boardJobsFor, claimedByMe, isOpenJob, offeredFirstTo } = await import(join(repo, 'src/lib/openJobs.ts'))

const NOW = Date.parse('2026-10-19T17:57:00Z')
// One row of open_board_jobs(), as PostgREST answers it.
const rpc = (n, start, extra = {}) => ({
  job_id: `job-${n}`, job_number: n, status: 'scheduled', job_type: 'clean',
  scheduled_start: start, scheduled_end: start.replace('T17', 'T20'),
  is_turnover: true, calendar_made: true, service_name: 'Turnover clean',
  property_name: 'Adale', street: '12 Adale Rd', city: 'Billings', property_timezone: 'America/Denver',
  max_crew: 1, spots_taken: 0, open_to_all_at: null, offered_to_me: false, claimed_by_me_at: null,
  ...extra,
})

// The card row.
const [card] = boardRows([rpc(381, '2026-12-22T17:00:00Z')])
check('a card row: the id, the place, its clock and the time', [card.id, card.client_addresses, card.scheduled_start],
  ['job-381', { nickname: 'Adale', street: '12 Adale Rd', city: 'Billings', timezone: 'America/Denver' }, '2026-12-22T17:00:00Z'])
check('a card row: the service, the calendar mark, the spots', [card.service_types, !!card.reservation_id, card.spots_taken, card.max_crew],
  [{ name: 'Turnover clean' }, true, 0, 1])
check('a card row: no client, no code, no notes', ['clients', 'lockbox_code', 'internal_notes', 'job_assignments'].some(k => k in card || k in card.client_addresses), false)
check('a hand-made clean: no calendar mark', !!boardRows([rpc(1, '2026-12-22T17:00:00Z', { calendar_made: false })])[0].reservation_id, false)
check('a copy saved by an older app (jobs rows): nothing, not broken cards',
  boardRows([{ id: 'j1', status: 'scheduled', scheduled_start: '2026-12-22T17:00:00Z', job_assignments: [] }]), [])
check('no rows, or a failed read: nothing', [boardRows(null), boardRows(undefined), boardRows({ message: 'x' })], [[], [], []])

// Arise, 2026-10-19: the 8 unclaimed board cleans, plus the ones Dakota claimed.
const arise = boardRows([
  rpc(415, '2026-10-25T17:00:00Z', { spots_taken: 1 }),  // claimed by someone else, full (crew: not in the RPC's answer)
  rpc(381, '2026-12-22T17:00:00Z'),
  rpc(406, '2026-12-22T17:00:00Z'),
  rpc(35, '2026-12-27T17:00:00Z'),
  rpc(40, '2026-12-27T18:00:00Z'),
  rpc(382, '2027-01-03T18:00:00Z'),
  rpc(407, '2027-01-05T17:00:00Z'),
  rpc(408, '2027-01-19T17:00:00Z'),
  rpc(409, '2027-02-02T17:00:00Z'),
  rpc(401, '2027-03-11T16:00:00Z', { spots_taken: 1, claimed_by_me_at: '2026-10-15T12:00:00Z' }),  // Dakota's claim
])
const nums = rows => rows.map(j => j.job_number)
const eight = [381, 406, 35, 40, 382, 407, 408, 409]
check('Arise: all 8 open cleans on the list', nums(boardJobsFor(arise, NOW)), eight)
check('Arise: the badge counts the same 8', boardJobsFor(arise, NOW).length, 8)
check('Arise: a full clean she claimed is under "yours", not on the list', nums(claimedByMe(arise)), [401])

const row = (n, start, extra) => boardRows([rpc(n, start, extra)])[0]
check('1 of 2 spots taken: still open to the next person', isOpenJob(row(500, '2026-11-01T17:00:00Z', { max_crew: 2, spots_taken: 1 }), NOW), true)
check('1 of 1 spot taken: off the board', isOpenJob(row(501, '2026-11-01T17:00:00Z', { spots_taken: 1 }), NOW), false)
check('a clean that already started: off the board', isOpenJob(row(502, '2026-10-19T15:00:00Z'), NOW), false)
check('a cancelled clean: off the board', isOpenJob(row(503, '2026-11-01T17:00:00Z', { status: 'cancelled' }), NOW), false)
check('a clean waiting on approval: on the board', isOpenJob(row(505, '2026-11-01T17:00:00Z', { status: 'pending_approval' }), NOW), true)
check('no crew size on the clean: one spot', isOpenJob(row(506, '2026-11-01T17:00:00Z', { max_crew: null }), NOW), true)

const firstPick = (offered) => row(510, '2026-11-20T17:00:00Z', { open_to_all_at: '2026-11-18T16:00:00Z', offered_to_me: offered })
check('crew-first window: offered to me', offeredFirstTo(firstPick(true), NOW), 'me')
check('crew-first window: hidden from everyone else', boardJobsFor([firstPick(false)], NOW).length, 0)
check('crew-first window over: everyone', offeredFirstTo(firstPick(false), Date.parse('2026-11-18T16:00:01Z')), 'all')

// Both reads in the app go through the shared rule.
const app = readFileSync(join(repo, 'App.tsx'), 'utf8')
const screen = readFileSync(join(repo, 'src/screens/OpenJobsScreen.tsx'), 'utf8')
const badge = app.slice(app.indexOf('const refreshOpenJobs'), app.indexOf('useEffect(', app.indexOf('const refreshOpenJobs')))
check('badge reads open_board_jobs()', /supabase\.rpc\('open_board_jobs', \{\}, \{ get: true \}\)/.test(badge), true)
check('badge counts through boardJobsFor(boardRows())', /setOpenJobsCount\(boardJobsFor\(boardRows\(data\)/.test(badge), true)
check('badge reads no jobs table', /from\('jobs'\)/.test(badge), false)
check('list reads open_board_jobs(), saved per person', /cachedQuery\(`openjobs2:\$\{user\.id\}`, supabase\.rpc\('open_board_jobs', \{\}, \{ get: true \}\)\)/.test(screen), true)
check('list filters through boardJobsFor() and lists claims through claimedByMe()', [/setJobs\(boardJobsFor\(rows/.test(screen), /setMine\(claimedByMe\(rows\)\)/.test(screen)], [true, true])
check('list reads no jobs table and shows no client name', [/from\('jobs'\)/.test(screen), /clients/.test(screen.replace(/^\s*\/\/.*$/gm, ''))], [false, false])
check('the old saved copy (with codes) is dropped', screen.includes("pruneDataCache(k => k.startsWith('openjobs:'))"), true)
check('a card opens its clean in full through scheduleJobById()', [/await scheduleJobById\(user, job\.id\)/.test(screen), /onJobPress\(job\)/.test(screen)], [true, false])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
