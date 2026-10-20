// Carried-lines scenario test. Run with: node scripts/test-carried-lines.mjs
//
// Exercises the REAL src/lib/carriedLines.ts (pure), then checks the screens'
// wiring on their source text (src/ is copied next to the scenario by the
// runner): the rpc and its key, the crew card on a clean, the "Missed last
// time" block on an inspection, Looks good leaving those lines alone, a
// walkthrough photo hidden from the client by default, and every new string
// in all three languages.
//
// Asked for by CKS Perfections (2026-10-19): "those missed items should show
// up on every inspection of that home going forward, so the crew and I see
// 'this is what got missed last time, here's the photo' until it stops
// getting missed."
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { carriedFromRpc, groupCarried, carriedItemIds, looksGoodIds, showsCrewCard, isWalkthroughVisit, photosToSave } from '../carriedLines'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8')

const row = (task: string, room: string | null, sort: number, extra: Record<string, unknown> = {}) => ({
  room, task, sort_order: sort, issue_note: null, photo_urls: [], missed_at: '2026-10-19T23:01:11Z',
  missed_job_id: 'v1', missed_item_id: `i-${task}-${room}`, times_missed: 1, inspector_name: 'Catherine Krause',
  this_item_id: null, this_result: null, ...extra,
})

// ── shaping the rpc's rows ──
const shaped = carriedFromRpc([
  row('Spa towels stocked', 'Kitchen', 20031, { issue_note: '  No spa towels were put out ' }),
  row('Floors and baseboards', 'Hallways & general', 20023, { photo_urls: ['https://x/p.jpg', '', 7] }),
  { room: 'Kitchen', task: '  ', missed_at: '2026-10-19T00:00:00Z' },
  { room: 'Kitchen', task: 'No date' },
  row('Restocked', null, 20015, { times_missed: 0, this_result: 'maybe' }),
  null,
])
ok('rows without a line or a date are dropped', shaped.length === 3, String(shaped.length))
ok('the note is trimmed', shaped[0].issue_note === 'No spa towels were put out')
ok('only real photo urls', JSON.stringify(shaped[1].photo_urls) === '["https://x/p.jpg"]')
ok('times_missed is at least 1; an unknown answer is none', shaped[2].times_missed === 1 && shaped[2].this_result === null)
ok('a non-array is no lines', carriedFromRpc(null).length === 0 && carriedFromRpc({ rows: [] }).length === 0)

// ── HACIENDA #1802 (2026-10-19), her notes as lines, in her walk order ──
const hacienda = carriedFromRpc([
  row('Spa towels stocked', 'Kitchen', 20032, { issue_note: 'No spa towels were put out' }),
  row('Patio furniture in place, wiped, no trash', 'Outside', 20039, { issue_note: 'Three pieces of trash right outside the front door' }),
  row('Restocked: towels, 3 rolls of toilet paper, small trash bag, amenities', 'Bathroom 1', 20015, { issue_note: 'No toilet paper' }),
  row('Restocked: towels, 3 rolls of toilet paper, small trash bag, amenities', 'Bathroom 2', 20022, { issue_note: 'No toilet paper' }),
  row('Floors and baseboards', 'Hallways & general', 20023, { issue_note: 'Hard floors not mopped', photo_urls: ['https://x/floor.jpg', 'https://x/floor2.jpg'] }),
  row('Restocked: kitchen towels, trash bags, paper towels, sponges, dish pods, soap', 'Kitchen', 20030, { issue_note: 'No paper towels, dirty sponge', photo_urls: ['https://x/sponge.jpg'] }),
])
const secs = groupCarried(hacienda)
ok('sections in walk order', secs.map(s => s.room).join('|') === 'Bathroom 1|Bathroom 2|Hallways & general|Kitchen|Outside', secs.map(s => s.room).join('|'))
ok('the same text in two bathrooms is two lines', secs[0].lines.length === 1 && secs[1].lines.length === 1)
ok('a section keeps its lines in walk order', secs[3].lines.map(l => l.sort_order).join(',') === '20030,20032')
ok('a line with no section goes under "Other"', groupCarried(carriedFromRpc([row('Lint', null, 1)])).map(s => s.room)[0] === 'Other')
ok('the day pack saves the first photo of each line', JSON.stringify(photosToSave(hacienda)) === '["https://x/floor.jpg","https://x/sponge.jpg"]')
ok('…at most 8 a stop', photosToSave(Array.from({ length: 12 }, (_, i) => carriedFromRpc([row(`l${i}`, 'K', i, { photo_urls: [`https://x/${i}.jpg`] })])[0])).length === 8)

// ── Looks good leaves them alone ──
const onVisit = carriedFromRpc([
  row('Spa towels stocked', 'Kitchen', 20032, { this_item_id: 'k-spa' }),
  row('Restocked: kitchen towels', 'Kitchen', 20030, { this_item_id: 'k-restock', this_result: 'ok' }),
  row('Patio no trash', 'Outside', 20039),
])
const carried = carriedItemIds(onVisit)
ok('the carried lines\' rows on this visit', [...carried].sort().join(',') === 'k-restock,k-spa')
ok('Looks good answers the rest', looksGoodIds(['k-sink', 'k-spa', 'k-fridge'], carried).join(',') === 'k-sink,k-fridge')
ok('Looks good with only carried lines open answers nothing', looksGoodIds(['k-spa'], carried).length === 0)
ok('a visit with its own rows is a walkthrough visit', isWalkthroughVisit(onVisit) && !isWalkthroughVisit(hacienda))

// ── which jobs get the crew card ──
ok('an open clean', showsCrewCard({ job_type: 'clean', status: 'scheduled' }) && showsCrewCard({ status: 'in_progress' }))
ok('not a finished or called-off one', !showsCrewCard({ job_type: 'clean', status: 'completed' }) && !showsCrewCard({ job_type: 'clean', status: 'cancelled' }) && !showsCrewCard({ job_type: 'clean', status: 'no_show' }))
ok('not an inspection, task or laundry run', !showsCrewCard({ job_type: 'inspection', status: 'scheduled' }) && !showsCrewCard({ job_type: 'task', status: 'scheduled' }) && !showsCrewCard(null))

// ── the screens ──
const reads = src('lib/jobReads.ts')
ok('the read calls the rpc with p_job_id as a GET (a read\'s deadline), keyed wtcarry:<job>',
  reads.includes("key: `wtcarry:${jobId}`") && reads.includes("supabase.rpc('walkthrough_carried_lines', { p_job_id: jobId }, { get: true })"))
ok('the day pack carries it for cleans and walkthrough visits',
  /if \(!isTask && addrId\) reads\.push\(carriedLinesRead\(job\.id\)\)/.test(reads) && /trashDaysRead\(addrId\), carriedLinesRead\(job\.id\)/.test(reads))
ok('its key is pruned with the stop', /'wtcarry'/.test(reads))
const card = src('components/CarriedLinesCard.tsx')
ok('the crew card shows no counts or names', !/times_missed|inspector_name/.test(card))
ok('the crew card is gated: open cleans, not a walkthrough visit', card.includes('showsCrewCard(job)') && card.includes('isWalkthroughVisit(view.lines)'))
ok('the crew card shows photos from the saved file first', card.includes('view.files[u] ?? u'))
const detail = src('screens/JobDetailScreen.tsx')
ok('the job screen shows it before and after Start, on cleans that aren\'t walkthroughs',
  /\{!isTask && !walkthroughJob && <CarriedLinesCard job=\{job\} \/>\}/.test(detail))
const walk = src('components/WalkthroughChecklist.tsx')
ok('Looks good goes through looksGoodIds', /const ids = looksGoodIds\(sectionState\(s\)\.open, carriedIds\)/.test(walk))
ok('a carried line is answered on this visit\'s own row, in the block on top',
  walk.includes('lines.find(l => l.id === c.this_item_id)') && walk.includes('{controls(row)}'))
ok('in its section a carried line is tagged and not expandable', walk.includes("t('wt_carried_tag')") && walk.includes('!readOnly && !isCarried'))
ok('the inspector sees how many times in a row', walk.includes("t('wt_carried_run')"))
const card2 = src('lib/walkthroughCard.ts')
ok('the walkthrough card reads the carried lines with the rest, never waiting on them', card2.includes('carriedSoon(carriedLinesRead(job.id), wait)') && card2.includes('const r = readSoon(read, wait)'))
const photos = src('screens/JobPhotosScreen.tsx')
ok('a walkthrough line photo is hidden from the client unless turned on', photos.includes('useState(!preselectedItem?.walkthrough)'))
ok('the walkthrough hands its photos over as walkthrough photos', walk.includes('onAddPhoto({ title: l.task, jobItemId: l.id, walkthrough: true })'))
const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8')
ok('signing out deletes the saved photos', /clearDataCache\(\); clearCarriedPhotos\(\)/.test(app))

// ── strings ──
const i18n = src('lib/i18n.ts')
const keys = ['carried_title', 'carried_hint', 'carried_flagged', 'carried_photo', 'wt_carried_title', 'wt_carried_hint',
  'wt_carried_hint_filed', 'wt_carried_once', 'wt_carried_run', 'wt_carried_ok', 'wt_carried_ok_filed', 'wt_carried_again',
  'wt_carried_unchecked', 'wt_carried_not_listed', 'wt_carried_not_listed_filed', 'wt_carried_tag',
  'wt_carried_section_one', 'wt_carried_section_many']
for (const k of keys) {
  const n = (i18n.match(new RegExp(`\\b${k}:`, 'g')) ?? []).length
  ok(`"${k}" in en, es and pt`, n === 3, String(n))
}
for (const k of keys) {
  if (!new RegExp(`t\\('${k}'\\)`).test(card + walk)) ok(`"${k}" is used`, false)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
if (failures) throw new Error(`${failures} failed`)
