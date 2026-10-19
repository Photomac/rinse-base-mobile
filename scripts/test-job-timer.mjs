#!/usr/bin/env node
// The running clock on a job for day-shift companies (CKS, 2026-10-18: "they
// want to glance at the job and see the time spent ticking").
//
// Runs the REAL src/lib/jobTimer.ts under Node's type stripping (it is pure)
// and checks:
//   • a clean started at 9:24 AM reads "1h 12m" at 10:36, "0m" right after
//     Start, and whole minutes only (never "1h 60m");
//   • no clock for a job that isn't in progress, has no start, or a start that
//     can't be read; none past 16 h (a clean left open from yesterday);
//   • a start a little ahead of the phone's clock reads 0m, not a negative;
// and, in the screens, that the clock is day-shift only (per-job mode keeps
// its own timer), that Home's day read fetches started_at, that Home shows it
// on the Active job bar and on in-progress cards, and that the job screen runs
// it from the very tap it sends as started_at.
//
// Usage: node scripts/test-job-timer.mjs
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
const { jobClockMs, fmtJobClock, JOB_CLOCK_MAX_MS } = await import(join(repo, 'src/lib/jobTimer.ts'))

const at = hm => Date.parse(`2026-10-19T${hm}:00-07:00`)   // America/Phoenix
const iso = hm => new Date(at(hm)).toISOString()
const clock = (job, hm) => { const ms = jobClockMs(job, at(hm)); return ms == null ? null : fmtJobClock(ms) }
const clean = { status: 'in_progress', started_at: iso('09:24') }

check('a clean started 9:24 reads 1h 12m at 10:36', clock(clean, '10:36'), '1h 12m')
check('right after Start: 0m', clock(clean, '09:24'), '0m')
check('under an hour: minutes only', clock(clean, '10:01'), '37m')
check('whole minutes: 119 min 59 s is 1h 59m, never 1h 60m',
  fmtJobClock(119 * 60000 + 59000), '1h 59m')
check('a typical STANDARD TURNOVER (101 min)', clock(clean, '11:05'), '1h 41m')
check('not started yet: no clock', clock({ status: 'scheduled', started_at: null }, '10:36'), null)
check('on the way: no clock', clock({ status: 'en_route', started_at: null }, '10:36'), null)
check('completed: no clock (the Time tab has Start → Complete)', clock({ ...clean, status: 'completed' }, '10:36'), null)
check('in progress but no start recorded: no clock', clock({ status: 'in_progress', started_at: null }, '10:36'), null)
check('a start that cannot be read: no clock', clock({ status: 'in_progress', started_at: 'not a time' }, '10:36'), null)
check('no job: no clock', [jobClockMs(null, at('10:36')), jobClockMs(undefined, at('10:36'))], [null, null])
check('16 h exactly still shows', fmtJobClock(jobClockMs(clean, at('09:24') + JOB_CLOCK_MAX_MS)), '16h 0m')
check('left open since yesterday (past 16 h): no clock',
  jobClockMs({ status: 'in_progress', started_at: new Date(at('09:24') - 86400000).toISOString() }, at('10:36')), null)
check('a start 2 min ahead of this phone reads 0m', clock({ status: 'in_progress', started_at: iso('10:38') }, '10:36'), '0m')
check('the cap is the server\'s 16 h', JOB_CLOCK_MAX_MS, 16 * 3600 * 1000)

// ── The screens ─────────────────────────────────────────────────────────────
const read = p => readFileSync(join(repo, p), 'utf8')
const reads = read('src/lib/jobReads.ts')
const dash = read('src/screens/DashboardScreen.tsx')
const detail = read('src/screens/JobDetailScreen.tsx')
const comp = read('src/components/JobClock.tsx')
const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)))

check('Home\'s day read fetches started_at',
  /started_at/.test(between(reads, 'export function dashTodayRead(', 'export function homeDayRows(')), true)
check('Home: the Active job bar shows the clock, day shift only',
  /\{dailyMode && <JobClock job=\{activeJob\}/.test(dash), true)
check('Home: in-progress cards in Today\'s list show it, day shift only',
  /\{dailyMode && isActive && <JobClock job=\{job\}/.test(dash), true)
check('job screen: the header clock is day shift only and runs from jobStartAt',
  /\{dailyMode && <JobClock job=\{\{ status: job\.status, started_at: jobStartAt \}\}/.test(detail), true)
check('job screen: per-job mode keeps its own timer',
  /\{!dailyMode && elapsedMinutes > 0 && \(/.test(detail), true)
const start = between(detail, 'async function startJobDaily()', 'async function handleOnMyWay()')
check('job screen: Start sends one tap time and the clock starts from it',
  /const at = new Date\(\)\.toISOString\(\)/.test(start) && /started_at: at \}/.test(start) && /setJobStartAt\(at\)/.test(start), true)
check('job screen: a delivered Start takes the server\'s start (a teammate may have started first)',
  /!res\.queued && !res\.error/.test(start) && /checkFirstStartRead\(job\.id\)/.test(start), true)
check('job screen: a queued Start still on this phone is laid over the saved read',
  /overlayPending\('jobs', \[\{ id: job\.id, started_at:/.test(detail), true)
check('JobClock ticks and renders only what jobClockMs allows',
  /setInterval\(/.test(comp) && /jobClockMs\(job, now\)/.test(comp) && /if \(ms == null\) return null/.test(comp), true)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
