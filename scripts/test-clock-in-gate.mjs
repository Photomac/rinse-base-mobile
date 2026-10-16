#!/usr/bin/env node
// Clock in on a clean the crew member isn't on (rinsebase-app #1487).
//
// The insert rule on job_time_entries lets crew start an entry only on a clean
// they're assigned to (the office records for anyone), and refuses anything
// else with 42501. Runs the REAL src/lib/jobScope.ts notAssignedHere() under
// Node's type stripping (it is pure) and checks:
//   • the office always keeps the button;
//   • a live roster decides, even against the list the screen came from
//     (taken off the clean after Home loaded);
//   • a saved roster says "not on it" only when the job's own assignments
//     agree; with no roster read yet, nobody loses the button;
//   • once the server has refused this person here, the note stays;
// and, in the screen and strings, that Clock in, Resume and Complete give way
// to the note (Complete since rinsebase-app #1493; Pause stays, an inspection
// keeps its button), a 42501 says "not on this clean" instead of "check your signal", the
// roster is read with user_id and marked live or saved (lib/stopDetails), and the two strings
// exist in all three languages.
//
// Usage: node scripts/test-clock-in-gate.mjs
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
const { notAssignedHere } = await import(join(repo, 'src/lib/jobScope.ts'))

const ME = 'tasia', MATE = 'marin'
const mine = { id: 'j1', job_assignments: [{ user_id: ME }, { user_id: MATE }] }
const theirs = { id: 'j2', job_assignments: [{ user_id: MATE }] }
const bare = { id: 'j3' } // opened from a payload without assignments
const live = ids => ({ ids, live: true })
const saved = ids => ({ ids, live: false })
const crew = (job, roster, refused) => notAssignedHere(job, ME, { office: false, roster, refused })

// ── the office records for anyone ────────────────────────────────────────────
check('office: never the note, whatever the roster or a refusal says',
  [notAssignedHere(theirs, ME, { office: true, roster: live([MATE]) }),
   notAssignedHere(theirs, ME, { office: true, roster: live([]), refused: true })],
  [false, false])

// ── a live roster decides ────────────────────────────────────────────────────
check('live roster has them: button', crew(mine, live([ME, MATE])), false)
check('live roster lacks them though the list says theirs (taken off after Home loaded): note',
  crew(mine, live([MATE])), true)
check('live roster has them though the list doesn\'t (added since): button', crew(theirs, live([ME])), false)
check('live roster empty (nobody on it): note', crew(bare, live([])), true)

// ── a saved roster needs the list to agree ───────────────────────────────────
check('saved roster lacks them, list has them: button (offline; can\'t tell)', crew(mine, saved([MATE])), false)
check('saved roster has them, list doesn\'t: button', crew(theirs, saved([ME])), false)
check('saved roster and list both lack them: note', crew(theirs, saved([MATE])), true)
check('saved roster lacks them, no assignments on the payload: note', crew(bare, saved([MATE])), true)

// ── not known yet ────────────────────────────────────────────────────────────
check('no roster read yet: button, even when the list lacks them (no flash for the newly added)',
  [crew(mine, null), crew(theirs, null), crew(bare, null), crew(null, null)], [false, false, false, false])

// ── the server already said no ───────────────────────────────────────────────
check('refused here: note, even if a roster still lists them',
  [crew(mine, live([ME]), true), crew(mine, null, true)], [true, true])

// ── the screen ───────────────────────────────────────────────────────────────
const screen = readFileSync(join(repo, 'src/screens/JobDetailScreen.tsx'), 'utf8')
const reads = readFileSync(join(repo, 'src/lib/jobReads.ts'), 'utf8')
check('the screen gates with notAssignedHere, the office being owner/manager/dispatcher',
  [/const notOnThisClean = notAssignedHere\(job, user\.id, \{ office: isAdminRole, roster, refused: refusedHere \}\)/.test(screen),
   /const isAdminRole = \['owner', 'manager', 'dispatcher'\]\.includes\(user\.role\)/.test(screen)], [true, true])
check('Clock in and Resume are hidden when not on the clean; the note shows in their place',
  [/\{!isStarted && !notOnThisClean && \(\s*<TouchableOpacity[^>]*onPress=\{handleClockIn\}/.test(screen),
   /\{isPaused && !notOnThisClean && \(\s*<TouchableOpacity[^>]*onPress=\{handleResume\}/.test(screen),
   /\{notOnThisClean && \(!isStarted \|\| isPaused \|\| \(\(isClockedIn \|\| isStrandedInProgress\) && completeNotOnClean\)\) && \([\s\S]{0,300}t\('not_on_this_clean'\)/.test(screen)], [true, true, true])
// Complete too (rinsebase-app #1493: crew change only a clean they're on). An
// inspection closes by filing its result, which that rule doesn't touch.
check('Complete gives way to the note when not on the clean, timed and daily; an inspection keeps its button',
  [/const completeNotOnClean = notOnThisClean && !isInspection/.test(screen),
   /\{\(isClockedIn \|\| isStrandedInProgress\) && !completeNotOnClean && \(\s*<TouchableOpacity/.test(screen),
   /\) : completeNotOnClean \? \(\s*<View[^>]*>\s*<Text[^>]*>\{t\('not_on_this_clean'\)\}/.test(screen),
   (screen.match(/onPress: completeJob/g) || []).length], [true, true, true, 2])
check('Pause is not gated (a running entry can still be closed)',
  /\{isClockedIn && \(\s*<TouchableOpacity[^>]*onPress=\{handlePause\}/.test(screen), true)
const complete = screen.slice(screen.indexOf('async function completeJob('), screen.indexOf('async function completeJobNoPhotoCheck('))
const guardAt = complete.indexOf('if (completeNotOnClean)')
check('completeJob refuses before any write when not on the clean, after the inspection branch',
  [guardAt > complete.indexOf('if (isInspection)'), guardAt > 0 && guardAt < complete.indexOf('completeJobNoPhotoCheck()'),
   /if \(completeNotOnClean\) \{\s*Alert\.alert\(t\('error'\), t\('not_on_this_clean'\)\)\s*return\s*\}/.test(complete)], [true, true, true])
const clockIn = screen.slice(screen.indexOf('async function clockInAs('), screen.indexOf('function announceRequiredPhotos'))
const resume = screen.slice(screen.indexOf('async function handleResume('), screen.indexOf('async function canSignOffAsViewer'))
const refused = screen.slice(screen.indexOf('function clockInRefused('), screen.indexOf('function announceRequiredPhotos'))
check('clock-in and resume send every refusal through clockInRefused, never straight to "check your signal"',
  [/clockInRefused\(entryErr\)/.test(clockIn), /clockInRefused\(resumeErr\)/.test(resume),
   /Alert\.alert\(t\('error'\), t\('clock_in_failed'\)\)/.test(clockIn.replace(refused, '')),
   /Alert\.alert\(t\('error'\), t\('clock_in_failed'\)\)/.test(resume)], [true, true, false, false])
check('clockInRefused: 42501 from crew → "not on this clean" and the note; anything else → as before',
  [/err\?\.code === '42501' && !isAdminRole/.test(refused), /setRefusedHere\(true\)/.test(refused),
   /t\('not_on_this_clean_failed'\)/.test(refused), /t\('clock_in_failed'\)/.test(refused)], [true, true, true, true])
// The roster is read by lib/stopDetails (with the property and the job's
// extras) and handed to the screen's setRoster once final.
const details = readFileSync(join(repo, 'src/lib/stopDetails.ts'), 'utf8')
check('the roster is read with user_id and kept as live or saved',
  [/jobCrewRead[\s\S]{0,120}\.select\('user_id, is_lead, users!job_assignments_user_id_fkey\(id, full_name\)'\)/.test(reads),
   /ui\.roster\(\{ ids: [^}]*a\.user_id \?\? a\.users\?\.id[^}]*live: !fin\.fromCache \}\)/.test(details),
   /stopDetails\(\{[^}]*roster: setRoster[^}]*\}\)/.test(screen)], [true, true, true])

const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
for (const key of ['not_on_this_clean', 'not_on_this_clean_failed']) {
  check(`"${key}" in all three languages`, (i18n.match(new RegExp(`\\n    ${key}: ['"]`, 'g')) || []).length, 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
