// Inspection walkthrough scenario test. Run with: node scripts/test-walkthrough.mjs
//
// Exercises the REAL src/lib/walkthrough.ts (pure), then checks the screens'
// wiring on their source text (src/ is copied next to the scenario by the
// runner): the outbox writes, the photo hand-off, the clean screen's split,
// and that every new string exists in all three languages.
//
// Asked for by CKS Perfections (2026-10-05): sections in her walk order, one
// "Looks good" per room, a line touched only when something is wrong.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isWalkthroughJob, groupWalkthrough, sectionState, pickupDaysLabel, WALKTHROUGH_BAND } from '../walkthrough'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8')

const L = (id: string, room: string, sort: number, result: any = null) => ({
  id, room, task: `${room} ${id}`, sort_order: sort, result, issue_note: null,
  photo_required: false, follow_up: null, info_key: null,
}) as any

// ── which jobs ──
ok('band is 20000 (the web migration)', WALKTHROUGH_BAND === 20000)
ok('all rows in the band: a walkthrough job', isWalkthroughJob([{ sort_order: 20001 }, { sort_order: 20002 }]))
ok('a cleaning row: not one', !isWalkthroughJob([{ sort_order: 20001 }, { sort_order: 10 }]))
ok('no rows: not one', !isWalkthroughJob([]))

// ── sections ──
const lines = [
  L('c', 'Bedroom 1', 20004), L('a', 'Arrival', 20001), L('b', 'Arrival', 20002, 'ok'),
  L('d', 'Bedroom 1', 20005, 'issue'), L('e', 'Kitchen', 20006), L('x', 'Other', 50),
]
const secs = groupWalkthrough(lines)
ok('sections follow sort_order, not array order', secs.map(s => s.name).join('|') === 'Arrival|Bedroom 1|Kitchen', secs.map(s => s.name).join('|'))
ok('lines outside the band are left out', !secs.some(s => s.lines.some(l => l.id === 'x')))
const a = sectionState(secs[0]), b = sectionState(secs[1])
ok('Arrival: 1 of 2 answered, 1 open', a.answered === 1 && a.total === 2 && a.open.join() === 'a' && !a.done)
ok('Bedroom 1: an issue counts as answered', b.answered === 1 && b.issues === 1 && b.open.join() === 'c')
ok('a fully answered section is done', sectionState({ name: 'x', lines: [L('q', 'x', 20001, 'na')] }).done)

// ── pickup days ──
ok('pickup: none', pickupDaysLabel(null) === null && pickupDaysLabel([]) === null && pickupDaysLabel([7]) === null)
ok('pickup: English default', pickupDaysLabel([5, 2]) === 'Tue & Fri', String(pickupDaysLabel([5, 2])))
ok('pickup: three days, joined', pickupDaysLabel([1, 3, 5]) === 'Mon, Wed & Fri')
const es = pickupDaysLabel([2, 5], 'es-US', 'y') ?? ''
ok('pickup: localised days joined with the language\'s "and"', / y /.test(es) && es.split(' y ').every(d => d.trim().length > 0), es)

// ── wiring ──
const comp = src('components/WalkthroughChecklist.tsx')
// The card's reads live in lib/walkthroughCard.ts (how soon the saved copy
// shows), built in lib/jobReads.ts, shared with the offline day pack.
const wtCard = src('lib/walkthroughCard.ts')
ok('reads only the band, in order', comp.includes('walkthroughCard({ show, setLoading })') && wtCard.includes('readSoon(walkthroughLinesRead(job.id), wait)') &&
  src('lib/jobReads.ts').includes(".eq('job_id', jobId).gte('sort_order', WALKTHROUGH_BAND).order('sort_order')"))
ok('queued offline answers overlay the cache', wtCard.includes("overlayPending('job_checklist_items'"))
ok('Looks good: one outbox write for the section\'s open lines',
  comp.includes("match: { job_id: job.id }, matchIn: { id: ids }") && comp.includes("values: { result: 'ok', completed_at: new Date().toISOString(), completed_by: user.id }"))
ok('an answer goes through the outbox, by line id', comp.includes("table: 'job_checklist_items', op: 'update', match: { id: line.id }"))
ok('a refused write reverts the line', comp.includes('patch([line.id], before)') && comp.includes('patch(ids, { result: null })'))
ok('a line photo hands its id to the photo screen, as a walkthrough photo', comp.includes('onAddPhoto({ title: l.task, jobItemId: l.id, walkthrough: true })'))
ok('owner-written text is translated', comp.includes('useMachineTranslation(lang,'))

const insp = src('screens/JobInspectionScreen.tsx')
ok('the inspection shows the walkthrough, read-only once filed', insp.includes('<WalkthroughChecklist job={job} user={user} readOnly={done} onAddPhoto={setPhotoLine} refreshKey={walkKey} />'))
ok('its photo screen opens in a modal (the form stays mounted)', insp.includes('<Modal visible={!!photoLine}') && insp.includes('preselectedItem={photoLine}'))

const detail = src('screens/JobDetailScreen.tsx')
// The checklist card's load lives in lib/checklistCard; the screen shows its view.
const card = src('lib/checklistCard.ts')
ok('a clean is a walkthrough clean when every row is in the band',
  card.includes('walkthrough: isWalkthroughJob(rows)') && detail.includes('setWalkthroughJob(v.walkthrough)'))
ok('the room accordion drops walkthrough lines, keeps the shots', detail.includes('const roomChecklist = walkthroughJob ? [] : checklist') && detail.includes('for (const item of roomChecklist)'))
ok('the clean screen renders the walkthrough card', detail.includes('<WalkthroughChecklist job={job} user={user}'))

// ── strings ──
const i18n = src('lib/i18n.ts')
const keys = [...comp.matchAll(/t\('(wt_[a-z_]+)'\)/g)].map(m => m[1])
const uniq = [...new Set(keys)]
ok('the component uses walkthrough strings', uniq.length >= 12, String(uniq.length))
for (const k of uniq) {
  const n = (i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length
  ok(`"${k}" in en, es and pt`, n === 3, String(n))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
if (failures) process.exit(1)
