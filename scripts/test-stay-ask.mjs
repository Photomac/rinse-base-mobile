#!/usr/bin/env node
// The clean's screen in the order of the work, and "How did the guests leave
// it?" asked once at Complete (CKS, Catherine, 2026-11-03; Todd 2026-11-06,
// every company). src/lib/stayAsk.ts, src/lib/stayRating.ts.
//
// Runs the REAL lib/stayAsk.ts, and lib/stayRating.ts with AsyncStorage and
// the outbox stubbed, under Node's type stripping, and checks:
//   • when Complete asks: a clean that shows the card, unrated, not asked here;
//   • the stay_* write is the card's old one (trimmed note, null when empty);
//   • the asked list: no repeats, newest last, capped, junk dropped;
//   • a save goes through the outbox (queued counts as saved) and only a
//     save that wasn't refused marks the clean as asked; remembering two
//     cleans at once keeps both;
// and, in the screens: the rating card and Report an issue come right after
// the time card, before the walkthrough list and the checklist, with the
// office notes after them; Report an issue keeps its incidentY scroll target;
// Complete asks after the lead sign-off check and before anything else it
// checks; Skip carries on, closing stops, a refused save stops; the card and
// the ask share one rating and one save; the strings exist in en, es and pt.
//
// Usage: node scripts/test-stay-ask.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

// ── stubs for lib/stayRating's two imports ──────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'stay-ask-test-'))
writeFileSync(join(work, 'async-storage.mjs'), `
const store = globalThis.__stayStore = new Map()
export default {
  async getItem(k) { await new Promise(r => setTimeout(r, 1)); return store.has(k) ? store.get(k) : null },
  async setItem(k, v) { await new Promise(r => setTimeout(r, 1)); store.set(k, v) },
}`)
writeFileSync(join(work, 'outbox.mjs'), `
export const writes = globalThis.__stayWrites = []
export async function writeThrough(w) {
  writes.push(w)
  return globalThis.__stayAnswer ?? { error: null, queued: false }
}`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@react-native-async-storage/async-storage') return next(pathToFileURL(join(work, 'async-storage.mjs')).href, ctx)
    if (ctx.parentURL?.includes('/src/lib/')) {
      if (spec === './outbox') return next(pathToFileURL(join(work, 'outbox.mjs')).href, ctx)
      if (spec === './stayAsk') return next(pathToFileURL(join(repo, 'src/lib/stayAsk.ts')).href, ctx)
    }
    return next(spec, ctx)
  },
})

try {
  const A = await import(join(repo, 'src/lib/stayAsk.ts'))
  const R = await import(join(repo, 'src/lib/stayRating.ts'))

  // ── when Complete asks ──────────────────────────────────────────────────
  const ask = (shows, rated, askedBefore) => A.asksAtComplete({ shows, rated, askedBefore })
  check('asks: a clean that shows the card, unrated, not asked here', ask(true, false, false), true)
  check('never on a clean without the card (residential, task, read-only)', ask(false, false, false), false)
  check('never once it has a rating', ask(true, true, false), false)
  check('never twice for the same clean', ask(true, false, true), false)

  // ── the write ───────────────────────────────────────────────────────────
  const at = new Date('2026-11-07T15:04:05.000Z')
  check('the card\'s five columns, note trimmed',
    A.stayWrite({ rating: 4, flags: ['pets'], note: '  dog hair on the sofa ' }, 'u1', at),
    { stay_rating: 4, stay_condition_flags: ['pets'], stay_condition_note: 'dog hair on the sofa', stay_rated_at: '2026-11-07T15:04:05.000Z', stay_rated_by: 'u1' })
  check('an empty note is null, no user is null',
    [A.stayWrite({ rating: 2, flags: [], note: '   ' }, undefined, at).stay_condition_note, A.stayWrite({ rating: 2, flags: [], note: '' }, null, at).stay_rated_by],
    [null, null])
  check('the six flags the web card knows, in its order',
    A.STAY_FLAGS.map(f => f.key), ['heavy_mess', 'damage', 'smoking', 'pets', 'extra_time', 'items_moved'])

  // ── the asked list ──────────────────────────────────────────────────────
  check('added newest last', A.withAsked(['a', 'b'], 'c'), ['a', 'b', 'c'])
  check('no repeats: asked again moves to the end', A.withAsked(['a', 'b', 'c'], 'a'), ['b', 'c', 'a'])
  check('capped: the oldest goes', A.withAsked(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd'])
  check('the default cap', A.withAsked(Array.from({ length: 500 }, (_, i) => `j${i}`), 'new').length, A.ASKED_KEEP)
  check('junk stored is dropped', [A.withAsked(null, 'x'), A.withAsked({ a: 1 }, 'x'), A.withAsked(['ok', 7, null], 'x')], [['x'], ['x'], ['ok', 'x']])
  check('wasAsked', [A.wasAsked(['a', 'b'], 'b'), A.wasAsked(['a'], 'b'), A.wasAsked('b', 'b'), A.wasAsked(null, 'b')], [true, false, false, false])

  // ── lib/stayRating: storage and the save ────────────────────────────────
  check('nothing asked yet', await R.stayAskedBefore('job-1'), false)
  await R.rememberStayAsked('job-1')
  check('remembered', await R.stayAskedBefore('job-1'), true)
  await Promise.all([R.rememberStayAsked('job-2'), R.rememberStayAsked('job-3')])
  check('two at once: both kept (the passes take turns)', JSON.parse(globalThis.__stayStore.get('stayAskedAtComplete')), ['job-1', 'job-2', 'job-3'])
  globalThis.__stayStore.set('stayAskedAtComplete', '{not json')
  check('unreadable storage answers no', await R.stayAskedBefore('job-1'), false)
  globalThis.__stayStore.delete('stayAskedAtComplete')

  globalThis.__stayAnswer = { error: null, queued: true }
  const queued = await R.saveStayRating('job-4', 'u9', { rating: 5, flags: ['damage'], note: '' })
  const w = globalThis.__stayWrites.at(-1)
  check('the save is an outbox write on the clean', [w.table, w.op, w.match, w.values.stay_rating, w.values.stay_condition_flags, w.values.stay_rated_by], ['jobs', 'update', { id: 'job-4' }, 5, ['damage'], 'u9'])
  check('queued on the phone counts as saved', queued, { error: null, queued: true })
  await new Promise(r => setTimeout(r, 20))
  check('a saved rating means Complete won\'t ask', await R.stayAskedBefore('job-4'), true)
  globalThis.__stayAnswer = { error: { message: 'refused' }, queued: false }
  const refused = await R.saveStayRating('job-5', 'u9', { rating: 3, flags: [], note: '' })
  await new Promise(r => setTimeout(r, 20))
  check('a refused save says so, and isn\'t remembered', [refused.error?.message, await R.stayAskedBefore('job-5')], ['refused', false])
} finally {
  rmSync(work, { recursive: true, force: true })
}

// ── the screens ───────────────────────────────────────────────────────────
const detail = readFileSync(join(repo, 'src/screens/JobDetailScreen.tsx'), 'utf8')
const card = readFileSync(join(repo, 'src/components/StayRatingCard.tsx'), 'utf8')
const lib = readFileSync(join(repo, 'src/lib/stayRating.ts'), 'utf8')
const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
const has = (src, s) => src.includes(s)
const at_ = s => detail.indexOf(s)

const body = detail.slice(at_('<ScrollView ref={scrollRef}'), at_('</ScrollView>'))
const pos = s => body.indexOf(s)
const order = [
  ["the time card's Complete", "{ text: t('complete_job'), onPress: completeJob }"],
  ['the rating card', '<StayRatingCard stay={stay}'],
  ['Report an issue', '<IncidentReportCard '],
  ['the walkthrough list', '<WalkthroughChecklist '],
  ['the checklist', "{t('cleaning_checklist')}"],
  ['laundry and pets', 'toggleLaundryDoneOnsite'],
  ['the office notes', "{t('notes_for_office')}"],
]
check('every card is on the screen once',
  order.map(([n, s]) => [n, body.split(s).length - 1 >= 1]), order.map(([n]) => [n, true]))
check('the order of the work: time card, rating, Report an issue, walkthrough, checklist, laundry, notes',
  order.map(([, s]) => pos(s)).every((p, i, all) => p > 0 && (i === 0 || p > all[i - 1])), true)
check('the rating and the issue card each appear once',
  [body.split('<StayRatingCard ').length - 1, body.split('<IncidentReportCard ').length - 1], [1, 1])
check('Report an issue keeps its scroll target',
  /<View onLayout=\{e => \{ incidentY\.current = e\.nativeEvent\.layout\.y \}\}>\s*\{\/\*[\s\S]*?\*\/\}\s*\{isStarted && \(!isTask \|\| isInspection\) && !readOnly && <IncidentReportCard /.test(body), true)
check('the room buttons still scroll to it', has(detail, 'scrollRef.current?.scrollTo({ y: Math.max(0, incidentY.current - 12), animated: true })'), true)

check('the card shows on the gate it always had', has(detail, 'const stayShows = isStarted && !isTask && !isResidential'), true)
check('one rating for the card and the ask', [has(detail, 'const stay = useStayRating(job, user, stayShows)'), has(body, '{stayShows && <StayRatingCard stay={stay} readOnly={readOnly}'), has(detail, '<StayAskModal visible={stayAskOpen} stay={stay}')], [true, true, true])
check('the card reads nothing until it shows', has(card, 'if (!enabled) return'), true)
check('one save, through the outbox (no live-only write left in the card)',
  [has(card, 'await saveStayRating(job.id, user?.id, { rating, flags, note })'), /\.update\(/.test(card), has(lib, "writeThrough({ table: 'jobs', op: 'update', match: { id: jobId }")], [true, false, true])

const complete = detail.slice(at_('  async function completeJob() {'), at_('  // complete_when_photos_land'))
const p = s => complete.indexOf(s)
check('Complete asks after the lead sign-off check, before Check first',
  [p('canSignOffAsViewer(answering)') > 0, p('if (!(await askStayFirst())) return') > p('canSignOffAsViewer(answering)'), p('if (cfHasLines.current)') > p('if (!(await askStayFirst())) return')], [true, true, true])
check('not on a task or an inspection: both leave before it',
  [p('if (isInspection) {') < p('askStayFirst'), p('if (isTask) { await completeJobNoPhotoCheck(); return }') < p('askStayFirst')], [true, true])
const askFn = detail.slice(at_('  async function askStayFirst()'), at_('  async function completeJob() {'))
check('asked only on a clean that shows the card, unrated, not asked',
  has(askFn, 'asksAtComplete({ shows: stayShows && !readOnly, rated: stay.saved, askedBefore })'), true)
check('remembered as soon as it is shown', askFn.indexOf('rememberStayAsked(job.id)') < askFn.indexOf('setStayAskOpen(true)'), true)
check('an answer is taken once, and handed over after the sheet has gone',
  [has(askFn, 'if (!stayAnswer.current || stayGo.current !== null) return'), has(askFn, 'setTimeout(stayAskGone, 600)')], [true, true])
const modal = detail.slice(at_('<StayAskModal '), at_('<StayAskModal ') + 700)
check('Save carries on unless refused; Skip carries on; closing stops',
  [has(modal, 'const { error } = await stay.save()\n          answerStayAsk(!error)'), has(modal, 'onSkip={() => answerStayAsk(true)}'), has(modal, 'onClose={() => answerStayAsk(false)}')], [true, true, true])
check('the Complete still goes through the outbox', has(detail, "const { error: doneErr, queued: doneQueued } = await writeThrough({\n      table: 'jobs', op: 'update', match: { id: job.id },"), true)

const sheet = card.slice(card.indexOf('export function StayAskModal'))
check('the ask: the card\'s question, stars and flags, Save and complete, Skip',
  ["t('stay_rating_title')", '<StayPicker stay={stay} />', "t('stay_ask_save_complete')", "t('stay_ask_skip')", 'onRequestClose={onClose}', 'disabled={!picked || stay.saving}'].map(s => has(sheet, s)),
  [true, true, true, true, true, true])
check('the new strings in English, Spanish and Portuguese',
  ['stay_ask_save_complete', 'stay_ask_skip'].map(k => (i18n.match(new RegExp(`\\b${k}: '`, 'g')) ?? []).length), [3, 3])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
