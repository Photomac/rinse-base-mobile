#!/usr/bin/env node
// Who is on the clock, beside each name on the job screen's crew line.
//
// Runs the REAL src/lib/crewClock.ts under Node's type stripping (it is pure),
// replaying the punches Celebrity Clean's crews made on 2026-10-08, and checks:
//   • every teammate's state: on the clock / paused / clocked out / not in;
//   • the rules match the viewer's own timer (loadTimeEntries), so a person's
//     line and their timer can never disagree;
// and, in JobDetailScreen.tsx, that the viewer's own timer still reads only
// their own entries, that the crew line reads everyone's, live, and that the
// viewer's own line is taken from their timer (punches queued offline count).
//
// Usage: node scripts/test-crew-clock.mjs
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
const { crewClockFor } = await import(join(repo, 'src/lib/crewClock.ts'))

// Melrose Manor #987, 2026-10-08, mid-clean at 11:00 ET: three cleaners, three phones.
const TASIA = 'tasia', MARIN = 'marin', MADISON = 'madison', KIERSTEN = 'kiersten'
const midClean = [
  { user_id: TASIA, clocked_in_at: '2026-10-08T14:08:12.867+00:00', clocked_out_at: null },
  { user_id: MARIN, clocked_in_at: '2026-10-08T14:22:13.746+00:00', clocked_out_at: null },
  { user_id: MADISON, clocked_in_at: '2026-10-08T14:50:53.718+00:00', clocked_out_at: null },
]
check('every cleaner on the clean shows on the clock, from their own clock-in',
  [TASIA, MARIN, MADISON].map(u => crewClockFor(midClean, u, false)),
  [{ state: 'on', at: '2026-10-08T14:08:12.867+00:00' }, { state: 'on', at: '2026-10-08T14:22:13.746+00:00' }, { state: 'on', at: '2026-10-08T14:50:53.718+00:00' }])
check('assigned but never punched: not clocked in', crewClockFor(midClean, KIERSTEN, false), { state: 'none', at: null })
check('order of rows does not matter', crewClockFor([...midClean].reverse(), MARIN, false), { state: 'on', at: '2026-10-08T14:22:13.746+00:00' })

// A pause closes the entry with a reason; resuming opens a new one.
const paused = [
  { user_id: MARIN, clocked_in_at: '2026-10-08T14:22:13Z', clocked_out_at: '2026-10-08T16:00:00Z', pause_reason: 'Lunch' },
]
check('paused mid-clean', crewClockFor(paused, MARIN, false), { state: 'paused', at: '2026-10-08T16:00:00Z' })
check('a pause on a finished clean is just clocked out (same rule as the timer)', crewClockFor(paused, MARIN, true), { state: 'out', at: '2026-10-08T16:00:00Z' })
const resumed = [...paused, { user_id: MARIN, clocked_in_at: '2026-10-08T16:30:00Z', clocked_out_at: null }]
check('resumed after a pause: on the clock since the resume', crewClockFor(resumed, MARIN, false), { state: 'on', at: '2026-10-08T16:30:00Z' })

// Completing the clean closes everyone's punch at once (all three at 15:53 ET).
const done = midClean.map(e => ({ ...e, clocked_out_at: '2026-10-08T19:53:11Z' }))
check('after Complete: everyone clocked out, at the close', crewClockFor(done, MADISON, true), { state: 'out', at: '2026-10-08T19:53:11Z' })
check('two sessions: the latest end is shown',
  crewClockFor([
    { user_id: TASIA, clocked_in_at: '2026-10-08T14:00:00Z', clocked_out_at: '2026-10-08T15:00:00Z' },
    { user_id: TASIA, clocked_in_at: '2026-10-08T15:10:00Z', clocked_out_at: '2026-10-08T17:00:00Z' },
  ], TASIA, true), { state: 'out', at: '2026-10-08T17:00:00Z' })
check('someone else\'s open punch never makes me look clocked in', crewClockFor(midClean.slice(0, 1), MARIN, false), { state: 'none', at: null })

// ── JobDetailScreen ──────────────────────────────────────────────────────────
const screen = readFileSync(join(repo, 'src/screens/JobDetailScreen.tsx'), 'utf8')
const fn = (name) => { const i = screen.indexOf(`function ${name}(`); return i < 0 ? '' : screen.slice(i, screen.indexOf('\n  }\n', i)) }
check('the viewer\'s own timer still reads only their own entries', /if \(!wholeJob\) q = q\.eq\('user_id', user\.id\)/.test(fn('loadTimeEntries')), true)
check('the crew line reads every punch on the job, not filtered to the viewer',
  [/\.from\('job_time_entries'\)\s*\.select\('user_id, clocked_in_at, clocked_out_at, pause_reason'\)\s*\.eq\('job_id', job\.id\)\)/.test(fn('loadCrewClock')), /user_id/.test(fn('loadCrewClock').split(".eq('job_id'")[1] ?? '')],
  [true, false])
check('daily mode shows no per-job status', [/if \(dailyMode \|\| isTask\) return/.test(fn('loadCrewClock')), /if \(dailyMode\) return null/.test(fn('crewClockOf'))], [true, true])
check('the viewer\'s own line comes from their timer (offline punches count)', /if \(userId === user\.id\) return crewClockFor\(timeEntries\.filter/.test(fn('crewClockOf')), true)
check('teammates show no status until read, never a guessed "not clocked in"', /return crewClockRows \? crewClockFor\(crewClockRows, userId, finished\) : null/.test(fn('crewClockOf')), true)
check('a teammate\'s punch refreshes the line live',
  /\.on\('postgres_changes', \{ event: '\*', schema: 'public', table: 'job_time_entries', filter: `job_id=eq\.\$\{job\.id\}` \}, reloadClock\)/.test(screen), true)
check('the crew line renders a status per person', /crewOnJob\.map\(c => \{\s*const clock = crewClockOf\(c\.id\)/.test(screen), true)

// ── translations ─────────────────────────────────────────────────────────────
const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
for (const key of ['crew_clock_on', 'crew_clock_out', 'crew_clock_out_plain', 'crew_clock_none']) {
  check(`"${key}" in all three languages`, (i18n.match(new RegExp(`\\n    ${key}: '`, 'g')) || []).length, 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
