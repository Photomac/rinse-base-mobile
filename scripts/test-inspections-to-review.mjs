#!/usr/bin/env node
// "Inspections to review" on Home (components/InspectionsToReviewCard.tsx,
// web migration 20261113234500_inspection_review_reminders; CKS 2026-11-13).
//
// Runs the REAL src/lib/inspectionsToReview.ts under Node's type stripping (it
// is pure) and checks:
//   • the server's rows are read defensively: ids must be ids, one row per
//     inspection, newest first, 20 at most, an unknown verdict is a pass;
//   • a review saved on the clean's screen reaches the card (and a listener
//     that throws can't stop the others, or stay after it unsubscribes);
// and, in the source, that the card reads only my_inspections_to_review(),
// opens a clean through Schedule's columns pinned to the company (as a push
// tap does), reloads on an inspection push, renders nothing on an error, that
// Home mounts it, that InspectionResultCard tells it after a saved review, and
// that the reminder push's type is one the tap router opens.
//
// Usage: node scripts/test-inspections-to-review.mjs
//   From a worktree: RINSEBASE_WEB_REPO=/path/to/rinsebase-app also checks the
//   reminder function's push type and the server function's name there.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const { readToReview, onInspectionReviewed, inspectionReviewed, VERDICT_KEY } = await import(join(repo, 'src/lib/inspectionsToReview.ts'))

console.log('1. Reading the rows')
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const rows = [
  { inspection_id: id(1), job_id: id(11), property: ' G-HOUSE ', filed_at: '2026-11-11T22:22:46Z', result: 'pass_with_corrections' },
  { inspection_id: id(2), job_id: id(12), property: 'CHUCKAWALLA', filed_at: '2026-11-11T21:27:12Z', result: 'odd' },
  { inspection_id: id(3), job_id: id(13), property: null, filed_at: '2026-11-13T01:56:23Z', result: 'fail' },
  { inspection_id: id(1), job_id: id(11), property: 'dup', filed_at: '2026-11-11T22:22:46Z', result: 'pass' },
  { inspection_id: 'not-an-id', job_id: id(14), property: 'X', filed_at: null, result: 'pass' },
  { inspection_id: id(5), job_id: 'nope', property: 'Y', filed_at: null, result: 'pass' },
]
const got = readToReview(rows)
check('ids must be ids; one row per inspection; newest first', got.map(r => r.inspectionId), [id(3), id(1), id(2)])
check('property trimmed (blank stays blank for the card\'s fallback), unknown verdict a pass', got.map(r => [r.property, r.result]),
  [['', 'fail'], ['G-HOUSE', 'pass_with_corrections'], ['CHUCKAWALLA', 'pass']])
check('anything not a list is nothing', [readToReview(null), readToReview({}), readToReview('x')], [[], [], []])
check('20 at most', readToReview(Array.from({ length: 30 }, (_, i) => ({ inspection_id: id(100 + i), job_id: id(200 + i), filed_at: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T12:00:00Z`, result: 'pass' }))).length, 20)
check('verdicts use the card\'s existing words', VERDICT_KEY, { pass: 'insp_pass', pass_with_corrections: 'insp_pass_corr', fail: 'insp_fail' })

console.log('2. A review reaches the card')
const heard = []
const off1 = onInspectionReviewed(() => { throw new Error('one listener throws') })
const off2 = onInspectionReviewed(x => heard.push(x))
inspectionReviewed(id(1))
off2()
inspectionReviewed(id(2))
off1()
check('every listener hears it, a throwing one stops nobody, and an unsubscribed one hears nothing', heard, [id(1)])

console.log('3. In the source')
const card = readFileSync(join(repo, 'src/components/InspectionsToReviewCard.tsx'), 'utf8')
check('the card reads only my_inspections_to_review()', [card.includes("supabase.rpc('my_inspections_to_review')"), /supabase\.from\('(?!jobs')/.test(card)], [true, false])
check('…opens a clean with Schedule\'s columns, pinned to the company, like a push tap',
  card.includes(".select(SCHEDULE_JOB_SELECT)\n      .eq('id', item.jobId).eq('tenant_id', user.tenant_id).maybeSingle()"), true)
check('…keeps what it shows on an error and renders nothing when empty', [card.includes('if (error) return'), card.includes('if (!items.length) return null')], [true, true])
check('…reloads on an inspection push and when the app comes back', [card.includes("=== 'inspection_result') load()"), card.includes("if (s === 'active') load()")], [true, true])
const home = readFileSync(join(repo, 'src/screens/DashboardScreen.tsx'), 'utf8')
check('Home mounts it above everything below the header', home.includes('<InspectionsToReviewCard user={user} onJobPress={onJobPress} reloadKey={todayJobs} />')
  && home.indexOf('<InspectionsToReviewCard') < home.indexOf('{offline && ('), true)
const result = readFileSync(join(repo, 'src/components/InspectionResultCard.tsx'), 'utf8')
const mark = result.slice(result.indexOf('async function markReviewed'), result.indexOf('return (', result.indexOf('async function markReviewed')))
check('InspectionResultCard tells the card only after a saved review', [/setSaveFailed\(true\)\s*\n\s*return\s*\n\s*\}[\s\S]*inspectionReviewed\(insp\.id\)/.test(mark)], [true])
const tap = readFileSync(join(repo, 'src/lib/pushTap.ts'), 'utf8')
check('the reminder push\'s type opens the clean (JOB_PUSH_TYPES)', /JOB_PUSH_TYPES = \[[^\]]*'inspection_result'/.test(tap), true)
const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
check('its words are in English, Spanish and Portuguese', ['insp_todo_title', 'insp_todo_sub', 'insp_todo_a_clean', 'insp_todo_open_failed'].map(k => (i18n.match(new RegExp(`\\n    ${k}:`, 'g')) ?? []).length), [3, 3, 3, 3])

const web = process.env.RINSEBASE_WEB_REPO || join(repo, '../rinsebase-app')
const sweep = join(web, 'supabase/functions/inspection-review-reminders/index.ts')
if (existsSync(sweep)) {
  const s = readFileSync(sweep, 'utf8')
  check('the web sweep pushes the type this app opens', s.includes("const PUSH_TYPE = 'inspection_result'"), true)
  const mig = join(web, 'supabase/migrations/20261113234500_inspection_review_reminders.sql')
  if (existsSync(mig)) check('the server function is the one the card calls', readFileSync(mig, 'utf8').includes('create or replace function public.my_inspections_to_review()'), true)
} else {
  console.log('(web repo not found: its push type is not checked; set RINSEBASE_WEB_REPO)')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
