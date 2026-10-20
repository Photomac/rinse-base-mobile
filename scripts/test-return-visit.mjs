#!/usr/bin/env node
// "Needs a return visit" on a repair visit (rinse-base-app migration
// 20261019210000_repair_visit_needs_return, approved by CKS 2026-10-16).
//
// Runs the REAL src/lib/repairVisit.ts under Node's type stripping and checks:
//   • only a Task scheduled from an incident (jobs.source_report_id) is a
//     repair visit; a plain Task, a clean, an inspection are not;
//   • Complete adds needs_return_visit only on a repair visit and only when
//     ticked, so every other Complete sends the same write as before;
// and, in the screens, that:
//   • every read that opens a job (Home, Schedule, Needs closing) carries
//     source_report_id, so the job screen can tell a repair visit;
//   • the job screen offers the tick on a repair visit not yet completed, in
//     the Notes card, and the flag rides the ONE Complete write (the outbox's
//     writeThrough), never a second write the outbox could lose;
//   • English, Spanish and Portuguese have the wording.
//
// Usage: node scripts/test-return-visit.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const { isRepairVisit, returnVisitValues } = await import(join(repo, 'src/lib/repairVisit.ts'))

console.log('\nwhich job is a repair visit')
check('a Task scheduled from an incident', isRepairVisit({ job_type: 'task', source_report_id: 'r1' }), true)
check('a plain Task', isRepairVisit({ job_type: 'task', source_report_id: null }), false)
check('a Task read without the column (an older cached copy)', isRepairVisit({ job_type: 'task' }), false)
check('a clean, an inspection, a laundry run', ['clean', 'inspection', 'laundry'].map(t => isRepairVisit({ job_type: t, source_report_id: 'r1' })), [false, false, false])
check('no job', isRepairVisit(null), false)

console.log('\nwhat Complete writes')
const visit = { job_type: 'task', source_report_id: 'r1' }
check('a repair visit, ticked: the flag', returnVisitValues(visit, true), { needs_return_visit: true })
check('a repair visit, not ticked: nothing added', returnVisitValues(visit, false), {})
check('any other job, even ticked: nothing added', returnVisitValues({ job_type: 'task', source_report_id: null }, true), {})

console.log('\nthe screens')
const reads = read('src/lib/jobReads.ts'), schedule = read('src/screens/ScheduleScreen.tsx'), dash = read('src/screens/DashboardScreen.tsx')
check('Home\'s day read carries source_report_id', /dashTodayRead[\s\S]*?\.select\('[^']*\binternal_notes, source_report_id,/.test(reads), true)
check('the Schedule read carries it', /\.select\('[^']*\binternal_notes, source_report_id,/.test(schedule), true)
check('Needs closing carries it', /\.select\('id, job_number, tenant_id, status, scheduled_start, scheduled_end, is_turnover, job_type, internal_notes, source_report_id,/.test(dash), true)
const screen = read('src/screens/JobDetailScreen.tsx')
check('the tick: on a repair visit not yet completed, in the Notes card',
  /<TextInput style=\{styles\.notesInput\}[^\n]*\n\s*\{isRepairVisit\(job\) && job\.status !== 'completed' && \(/.test(screen), true)
check('the tick says so to screen readers', screen.includes('accessibilityRole="checkbox" accessibilityState={{ checked: needsReturn }}'), true)
const done = screen.slice(screen.indexOf('async function completeJobNoPhotoCheck'), screen.indexOf('const completedCount ='))
check('Complete: the flag rides the one writeThrough that completes the visit',
  /writeThrough\(\{\s*table: 'jobs', op: 'update', match: \{ id: job\.id \},\s*values: \{\s*status: 'completed',[\s\S]*?\.\.\.returnVisitValues\(job, needsReturn\),[\s\S]*?\}\s*,?\s*\}\)/.test(done), true)
check('…and no other write names the column', (screen.match(/needs_return_visit\s*:/g) || []).length, 0)
const i18n = read('src/lib/i18n.ts')
check('English, Spanish and Portuguese', ['needs_return_visit:', 'needs_return_visit_hint:', 'needs_return_visit_ph:'].map(k => (i18n.match(new RegExp(`\\b${k} '`, 'g')) || []).length), [3, 3, 3])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
