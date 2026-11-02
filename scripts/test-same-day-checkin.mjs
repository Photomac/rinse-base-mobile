#!/usr/bin/env node
// Two CKS asks: inspection cards show a same-day check-in as cleans do
// (2026-10-24), and a stray tap can't wipe an Issue note (2026-10-23).
//
// Runs the REAL src/lib/sameDayCheckin.ts, issueNoteGuard.ts and cleanKind.ts
// under Node's type stripping (all pure). The screens' wiring is checked on
// their source text.
//
// Usage: node scripts/test-same-day-checkin.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = p => readFileSync(join(repo, p), 'utf8')
let pass = 0, fail = 0
function ok(name, cond) { console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}`); cond ? pass++ : fail++ }

const { inspectionDays, sameDayIds, markSameDay } = await import(join(repo, 'src/lib/sameDayCheckin.ts'))
const { noteAtRisk } = await import(join(repo, 'src/lib/issueNoteGuard.ts'))
const { kindParts } = await import(join(repo, 'src/lib/cleanKind.ts'))

const dayOf = j => j.day
const insp = (over = {}) => ({ id: 'i', job_type: 'inspection', status: 'scheduled', day: '2026-11-02', client_addresses: { id: 'home' }, ...over })
const arrival = { address_id: 'home', checkin_date: '2026-11-02' }

ok('a guest arriving that day marks the inspection', sameDayIds([insp()], [arrival], dayOf).has('i'))
ok('an arrival the next day does not', !sameDayIds([insp()], [{ ...arrival, checkin_date: '2026-11-03' }], dayOf).size)
ok("another home's arrival does not", !sameDayIds([insp()], [{ ...arrival, address_id: 'other' }], dayOf).size)
ok('a clean keeps its own signal', !sameDayIds([insp({ job_type: 'clean' })], [arrival], dayOf).size)
ok('a cancelled inspection stays unmarked', !sameDayIds([insp({ status: 'cancelled' })], [arrival], dayOf).size)
const span = inspectionDays([insp({ day: '2026-11-05' }), insp({ id: 'k', day: '2026-11-02' }), insp({ job_type: 'clean', day: '2026-12-01' })], dayOf)
ok('only the inspections set the lookup', span.addressIds.join() === 'home' && span.from === '2026-11-02' && span.to === '2026-11-05')
ok('no inspections, nothing to look up', inspectionDays([{ id: 'c', job_type: 'clean', day: 'x' }], dayOf).from === null)
const rows = [{ id: 'i' }, { id: 'c' }]
const marked = markSameDay(rows, new Set(['i']))
ok('marking keeps the other rows as they were', marked[0].same_day_checkin === true && marked[1] === rows[1])
ok('nothing to mark returns the same list', markSameDay(rows, new Set()) === rows)

const labels = { turnover: 'Turnover', backToBack: 'Back-to-back' }
ok('the card says Back-to-back, after its service', kindParts({ job_type: 'inspection', same_day_checkin: true, service_types: { name: 'Final Inspection' } }, labels).join() === 'Final Inspection,↔ Back-to-back')
ok('an inspection with no arrival reads as before', kindParts({ job_type: 'inspection', service_types: { name: 'Final Inspection' } }, labels).join() === 'Final Inspection')

const reads = src('src/lib/jobReads.ts')
const read = reads.slice(reads.indexOf('export async function sameDayInspections'), reads.indexOf("// ── A job's screen"))
ok('the read asks for dates, never guest details', /\.select\('address_id, checkin_date'\)/.test(read))
ok('an owner block is not a guest', /\.neq\('platform', 'owner_block'\)/.test(read))
ok('a cancelled booking is not a guest', /\.neq\('status', 'cancelled'\)/.test(read))
ok('a failed read marks nothing', /return error \? new Set\(\)/.test(read))
for (const [screen, list] of [['src/screens/ScheduleScreen.tsx', 'sched'], ['src/screens/DashboardScreen.tsx', 'home']]) {
  ok(`${screen} marks its cards without waiting on the read`, new RegExp(`sameDayInspections\\(user, '${list}', \\w+\\)\\.then\\(ids => set\\w+\\(rows => markSameDay\\(rows, ids\\)\\)\\)\\.catch`).test(src(screen)))
}

ok('re-tapping a pressed Issue with a note asks', noteAtRisk('issue', null, 'No hot water') === 'No hot water')
ok('answering OK over a flagged line asks', noteAtRisk('issue', 'ok', 'No hot water') === 'No hot water')
ok('answering N/A over a flagged line asks', noteAtRisk('issue', 'na', 'No hot water') === 'No hot water')
ok('a flag with no words clears as before', noteAtRisk('issue', null, '  ') === null && noteAtRisk('issue', null, null) === null)
ok('editing the note on a flagged line never asks', noteAtRisk('issue', 'issue', 'x') === null)
ok('a line that is not flagged never asks', noteAtRisk('ok', null, 'x') === null && noteAtRisk(null, 'ok', 'x') === null)
for (const [file, call, risk] of [
  ['src/screens/JobDetailScreen.tsx', 'saveVerify(item, next)', 'noteAtRisk(item.result, next, item.issue_note)'],
  ['src/components/WalkthroughChecklist.tsx', 'answer(l, next)', 'noteAtRisk(l.result, next, notes[l.id] ?? l.issue_note)'],
]) {
  const s = src(file)
  ok(`${file} checks before it saves`, s.includes(risk) && s.indexOf(risk) < s.indexOf(`style: 'destructive', onPress: () => ${call}`))
  ok(`${file} saves only on Remove`, s.includes(`{ text: t('issue_remove_btn'), style: 'destructive', onPress: () => ${call} }`) && s.includes(`if (!risk) { ${call}; return }`))
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
