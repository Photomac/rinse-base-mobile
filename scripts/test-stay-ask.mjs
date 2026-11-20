#!/usr/bin/env node
// The clean's screen in the order of the work, and "How did the guests leave
// it?" asked at Complete (CKS, Catherine, 2026-11-03; Todd 2026-11-06, every
// company) and right after a Finished walkthrough video is saved (CKS,
// Catherine 2026-11-13). src/lib/stayAsk.ts, src/lib/stayRating.ts.
//
// Runs the REAL lib/stayAsk.ts, and lib/stayRating.ts with AsyncStorage and
// the outbox stubbed, under Node's type stripping, and checks:
//   • when Complete asks: a clean that shows the card, unrated, not answered
//     here; and always with a 1-4 star pick left unsaved;
//   • when a saved video asks: a Finished one, on a clean that shows the card
//     and has no rating (a Skip before doesn't stop it);
//   • the ways out of the ask: under 5 stars short of photos none; Skip only
//     before a star or at 5; Save once picked; closing unless short; after a
//     Finished video a rating is required: no Skip and no closing at all;
//   • the stay_* write is the card's old one (trimmed note, null when empty);
//   • the asked list: no repeats, newest last, capped, junk dropped;
//   • a save goes through the outbox (queued counts as saved) and only a
//     save that wasn't refused marks the clean as asked; remembering two
//     cleans at once keeps both;
// and, in the screens: the rating card and Report an issue come right after
// the time card, before the walkthrough list and the checklist, with the
// office notes after them; Report an issue keeps its incidentY scroll target;
// Complete asks after the lead sign-off check and before anything else it
// checks; it's remembered only on an answer (Skip, a saved rating), never
// because it showed; Skip carries on, closing stops, a refused save stops;
// saving a Finished video closes the recorder and opens the ask with Save
// (a line clip never does); the card and the ask share one rating and one
// save; the strings exist in en, es and pt.
//
// At a company that rates at arrival (tenants.stay_rating_at_arrival, CKS
// 2026-11-17): an Arrival video asks too, the ask there requires a rating and
// has no No photos to add (photosOnly); Start opens the recorder on Arrival
// (arrivalStep), with a clean that has its arrival video asks straight away;
// leaving that recorder without a video still asks; the switch is its own
// cached read, in the day pack, off on any error.
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
  check('never twice for the same clean once answered', ask(true, false, true), false)
  const askLow = (shows, rated, askedBefore, lowUnsaved) => A.asksAtComplete({ shows, rated, askedBefore, lowUnsaved })
  check('a 1-4 pick left unsaved: asked again, whatever was answered before',
    [askLow(true, false, true, true), askLow(true, true, true, true), askLow(true, false, false, true)], [true, true, true])
  check('…but never on a clean without the card', askLow(false, false, false, true), false)
  check('no 1-4 pick unsaved: as before', [askLow(true, false, true, false), askLow(true, true, false, false)], [false, false])

  const low = (rating, saved, dirty) => A.lowPickUnsaved({ rating, saved, dirty })
  check('a 1-4 pick never saved is left unsaved', [1, 2, 3, 4].map(n => low(n, false, false)), [true, true, true, true])
  check('…and one changed from the saved rating', [low(3, true, true), low(4, true, true)], [true, true])
  check('not 5 stars, not no star, not a saved pick', [low(5, false, true), low(0, false, false), low(3, true, false), low(NaN, false, true)], [false, false, false, false])

  const vid = (type, shows, rated) => A.asksAfterVideo({ type, shows, rated })
  check('a saved Finished video asks, on a clean that shows the card, unrated', vid('after', true, false), true)
  check('not an Arrival video, not a line clip', [vid('before', true, false), vid('line', true, false)], [false, false])
  check('not on a clean without the card, not once rated', [vid('after', false, false), vid('after', true, true)], [false, false])
  const vidA = (type, shows, rated) => A.asksAfterVideo({ type, shows, rated, atArrival: true })
  check('rating at arrival: an Arrival video asks too, and a Finished one still does (a clean left unrated)',
    [vidA('before', true, false), vidA('after', true, false)], [true, true])
  check('…never a line clip, a clean without the card, or a rated one',
    [vidA('line', true, false), vidA('before', false, false), vidA('before', true, true)], [false, false, false])
  check('…off: an Arrival video never asks', A.asksAfterVideo({ type: 'before', shows: true, rated: false, atArrival: false }), false)

  const step = (hasArrival, rated) => A.arrivalStep({ hasArrival, rated })
  check('Start, no arrival video on the clean (or no answer): the recorder', [step(false, false), step(null, null), step(false, true), step(null, false)], ['record', 'record', 'record', 'record'])
  check('…one there already and no rating (or no answer): the ask', [step(true, false), step(true, null)], ['ask', 'ask'])
  check('…one there and a rating: nothing', step(true, true), null)

  const exits = (rating, short) => A.askExits(rating, short)
  check('no star yet: Skip and closing, no Save', exits(0, 0), { save: false, skip: true, close: true, noPhotos: false })
  check('5 stars: Save, Skip, closing', exits(5, 0), { save: true, skip: true, close: true, noPhotos: false })
  check('1-4 stars, nothing short: Save and closing, no Skip (a low pick is an answer)',
    [1, 2, 3, 4].map(n => exits(n, 0)), Array(4).fill({ save: true, skip: false, close: true, noPhotos: false }))
  check('1-4 stars, short of photos: no Save, no Skip, no closing; only No photos to add (CKS 2026-11-16)',
    [1, 2, 3, 4].map(n => exits(n, 2)), Array(4).fill({ save: false, skip: false, close: false, noPhotos: true }))
  check('No photos to add never without a star, nor with nothing short',
    [exits(0, 2).noPhotos, exits(5, 0).noPhotos, exits(3, 0).noPhotos], [false, false, false])
  const req = (rating, short) => A.askExits(rating, short, { ratingRequired: true })
  check('rating required (after a video), no star yet: nothing but picking one', req(0, 0), { save: false, skip: false, close: false, noPhotos: false })
  check('rating required, 5 stars: Save only (no Skip, no closing)', req(5, 0), { save: true, skip: false, close: false, noPhotos: false })
  check('rating required, 1-4 stars with the photos: Save only', [1, 2, 3, 4].map(n => req(n, 0)), Array(4).fill({ save: true, skip: false, close: false, noPhotos: false }))
  check('rating required, 1-4 stars short of photos: only No photos to add', [1, 2, 3, 4].map(n => req(n, 1)), Array(4).fill({ save: false, skip: false, close: false, noPhotos: true }))
  check('not required unless asked for (the Complete ask is as above)', [A.askExits(0, 0, {}), A.askExits(0, 0, { ratingRequired: false })], [exits(0, 0), exits(0, 0)])
  const arr = (rating, short) => A.askExits(rating, short, { ratingRequired: true, photosOnly: true })
  check('at arrival, 1-4 stars short of photos: no way out at all, not even No photos to add (the photos or 5 stars)',
    [1, 2, 3, 4].map(n => arr(n, 1)), Array(4).fill({ save: false, skip: false, close: false, noPhotos: false }))
  check('at arrival, with the photos or at 5 stars: Save only; no star yet: nothing',
    [arr(3, 0), arr(5, 0), arr(0, 0)], [{ save: true, skip: false, close: false, noPhotos: false }, { save: true, skip: false, close: false, noPhotos: false }, { save: false, skip: false, close: false, noPhotos: false }])

  // ── the write ───────────────────────────────────────────────────────────
  const at = new Date('2026-11-07T15:04:05.000Z')
  check('the card\'s five columns, note trimmed',
    A.stayWrite({ rating: 4, flags: ['pets'], note: '  dog hair on the sofa ' }, 'u1', at),
    { stay_rating: 4, stay_condition_flags: ['pets'], stay_condition_note: 'dog hair on the sofa', stay_rated_at: '2026-11-07T15:04:05.000Z', stay_rated_by: 'u1' })
  check('an empty note is null, no user is null',
    [A.stayWrite({ rating: 2, flags: [], note: '   ' }, undefined, at).stay_condition_note, A.stayWrite({ rating: 2, flags: [], note: '' }, null, at).stay_rated_by],
    [null, null])
  check('no photosSkipped (the company not asking for photos): the column is left out',
    Object.hasOwn(A.stayWrite({ rating: 3, flags: [], note: '' }, 'u1', at), 'stay_photos_skipped'), false)
  check('photosSkipped true / false: written as said (No photos to add / saved with them)',
    [A.stayWrite({ rating: 3, flags: [], note: '', photosSkipped: true }, 'u1', at).stay_photos_skipped,
     A.stayWrite({ rating: 5, flags: [], note: '', photosSkipped: false }, 'u1', at).stay_photos_skipped], [true, false])
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
  check('…with no photosSkipped, no flag column in the write', Object.hasOwn(w.values, 'stay_photos_skipped'), false)
  await R.saveStayRating('job-6', 'u9', { rating: 2, flags: [], note: '', photosSkipped: true })
  check('No photos to add: the flag rides in the same write', globalThis.__stayWrites.at(-1).values.stay_photos_skipped, true)
  await new Promise(r => setTimeout(r, 20))
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
  [has(card, 'await saveStayRating(job.id, user?.id, { rating, flags, note, photosSkipped })'), /\.update\(/.test(card), has(lib, "writeThrough({ table: 'jobs', op: 'update', match: { id: jobId }")], [true, false, true])

const complete = detail.slice(at_('  async function completeJob() {'), at_('  // complete_when_photos_land'))
const p = s => complete.indexOf(s)
check('Complete asks after the lead sign-off check, before Check first',
  [p('canSignOffAsViewer(answering)') > 0, p('if (!(await askStayFirst())) return') > p('canSignOffAsViewer(answering)'), p('if (cfHasLines.current)') > p('if (!(await askStayFirst())) return')], [true, true, true])
check('not on a task or an inspection: both leave before it',
  [p('if (isInspection) {') < p('askStayFirst'), p('if (isTask) { await completeJobNoPhotoCheck(); return }') < p('askStayFirst')], [true, true])
const askFn = detail.slice(at_('  async function askStayFirst()'), at_('  async function completeJob() {'))
const fnBody = name => { const i = askFn.indexOf(name); return i < 0 ? '' : askFn.slice(i, askFn.indexOf('\n  }\n', i)) }
const firstFn = fnBody('async function askStayFirst()')
check('asked on a clean that shows the card: unrated and not answered, or a 1-4 pick unsaved',
  [has(firstFn, 'const lowUnsaved = lowPickUnsaved({ rating: stay.value.rating, saved: stay.saved, dirty: stay.dirty })'),
   has(firstFn, 'asksAtComplete({ shows: stayShows && !readOnly, rated: stay.saved, askedBefore, lowUnsaved })')], [true, true])
check('not remembered because it showed: only Skip remembers (a saved rating does in lib/stayRating)',
  [has(firstFn, 'rememberStayAsked'), has(firstFn, 'stayAskedHere.current = true'), has(fnBody('function skipStayAsk()'), 'rememberStayAsked(job.id)'),
   has(fnBody('function skipStayAsk()'), 'stayAskedHere.current = true'), has(fnBody('function closeStayAsk()'), 'remember'), has(fnBody('async function saveStayAsk()'), 'remember')],
  [false, false, true, true, false, false])
check('at Complete it opens in the Complete mode', has(firstFn, "setStayAskMode('complete')\n      setStayAskOpen(true)"), true)
check('an answer is taken once, and handed over after the sheet has gone',
  [has(askFn, 'if (!stayAnswer.current || stayGo.current !== null) return'), has(askFn, 'setTimeout(stayAskGone, 600)')], [true, true])
const saveFn = fnBody('async function saveStayAsk(opts?: { photosSkipped?: boolean })'), skipFn = fnBody('function skipStayAsk()'), closeFn = fnBody('function closeStayAsk()')
check('at Complete: Save carries on unless refused; Skip carries on; closing stops',
  [has(saveFn, "const { error } = await stay.save(opts)\n    if (stayAskMode === 'complete') answerStayAsk(!error)"),
   has(skipFn, "if (stayAskMode === 'complete') answerStayAsk(true)"), has(closeFn, "if (stayAskMode === 'complete') answerStayAsk(false)")], [true, true, true])
check('after a video each just closes the sheet; a refused save says why',
  [saveFn, skipFn, closeFn].map(f => has(f, 'else setStayAskOpen(false)')).concat(has(saveFn, "if (error) setTimeout(() => Alert.alert(t('error'), error.message || String(error)), 650)")),
  [true, true, true, true])
const modal = detail.slice(at_('<StayAskModal '), at_('<StayAskModal ') + 400)
check('the sheet: one rating, its mode, the answers (No photos to add = a Save with the flag), Take photos',
  ['visible={stayAskOpen} stay={stay} mode={stayAskMode} videoSaved={stayAskVideoSaved}', 'onSave={() => saveStayAsk()}', 'onSaveNoPhotos={() => saveStayAsk({ photosSkipped: true })}', 'onSkip={skipStayAsk}', 'onClose={closeStayAsk}', 'onTakePhotos={takeStayPhotos} />'].map(x => has(modal, x)),
  [true, true, true, true, true, true])

// ── after a Finished video ────────────────────────────────────────────────
const vidFn = fnBody('function askStayAfterVideo(type: WalkthroughType): boolean {')
check('after a video: a Finished one (an Arrival one where the company rates at arrival), on a clean that shows the card, unrated, nothing open already',
  has(vidFn, 'if (stayAskOpen || !asksAfterVideo({ type, shows: stayShows && !readOnly, rated: stay.saved, atArrival: ratesAtArrival })) return false'), true)
check('…the recorder closes (owed videos re-read), the ask opens in the video mode (arrival for an Arrival video), and says the video is saved',
  ['setShowWalkthrough(false)', 'if (videoEnabled && !isTask) loadVideosOwed()', "setStayAskMode(type === 'before' ? 'arrival' : 'video')", 'setStayAskVideoSaved(true)', 'setStayAskOpen(true)', 'return true'].map(x => has(vidFn, x)),
  [true, true, true, true, true, true])
check('…any saved video ends Start\'s guided recorder', has(vidFn, 'arrivalGuided.current = false'), true)
check('…nothing waits on it (no Complete is held)', [has(vidFn, 'stayAnswer.current ='), has(vidFn, 'new Promise')], [false, false])
const recorderMount = detail.slice(at_('  if (showWalkthrough) {'), at_('  if (showWalkthrough) {') + 1200)
check('the walkthrough recorder hands its saves over; the line recorder does not',
  [has(recorderMount, 'onSaved={askStayAfterVideo}'), detail.split('onSaved={askStayAfterVideo}').length - 1,
   has(detail.slice(at_('  if (lineFor) {'), at_('  if (showWalkthrough) {')), 'onSaved=')], [true, 1, false])
const walk = readFileSync(join(repo, 'src/screens/WalkthroughScreen.tsx'), 'utf8')
const walkSave = walk.slice(walk.indexOf('  async function save() {'), walk.indexOf('  function retake() {'))
const lineBranch = walkSave.slice(walkSave.indexOf('if (line) {'), walkSave.indexOf('setRecorded(null)\n      setJustSaved(true)'))
check('the recorder: a saved Arrival/Finished video is offered to the clean\'s screen after it is queued, a line clip never',
  [walkSave.indexOf('await enqueueVideo(') < walkSave.indexOf('if (onSaved?.(videoType)) {'), has(lineBranch, 'onSaved'), has(walk, 'onSaved?: (type: WalkthroughType) => boolean')],
  [true, false, true])
check('…taken over: the upload still starts, and the screen stops there (no list read on the way out)',
  /if \(onSaved\?\.\(videoType\)\) \{\n\s*flushVideoQueue\(\)\.catch\(\(\) => \{\}\)\n\s*return\n\s*\}\n\s*await loadList\(\)/.test(walkSave), true)
check('the Complete still goes through the outbox', has(detail, "const { error: doneErr, queued: doneQueued } = await writeThrough({\n      table: 'jobs', op: 'update', match: { id: job.id },"), true)

const sheet = card.slice(card.indexOf('export function StayAskModal'))
check('the ask: the card\'s question, stars and flags, Save (and complete), Skip',
  ["t('stay_rating_title')", '<StayPicker stay={stay} />', "t(mode === 'complete' ? 'stay_ask_save_complete' : 'stay_save')", "t('stay_ask_skip')"].map(s => has(sheet, s)),
  [true, true, true, true])
check('…its ways out from askExits: Save, Skip, and closing only when it allows',
  ['const exits = askExits(rating, stay.photosShort, { ratingRequired: mode !== \'complete\', photosOnly: mode === \'arrival\' })', 'disabled={!exits.save || stay.saving}', '{exits.skip && (', 'onRequestClose={() => { if (exits.close && !stay.saving) onClose() }}'].map(s => has(sheet, s)),
  [true, true, true, true])
check('…after a video it says the video is saved', has(sheet, "{mode === 'video' && <Text style={styles.askVideoSaved}>✓ {t('stay_ask_after_video')}</Text>}"), true)
// (Under 5 stars, short of the company's photos, the ask neither saves nor
// skips: scripts/test-stay-photos.mjs.)
check('…at arrival it says the arrival video is saved, or, with none, that it comes before the cleaning',
  [has(sheet, "{mode === 'arrival' && (videoSaved"), has(sheet, "t('stay_ask_after_arrival')"), has(sheet, "t('stay_ask_before_cleaning')")], [true, true, true])
check('the new strings in English, Spanish and Portuguese',
  ['stay_ask_save_complete', 'stay_ask_skip', 'stay_ask_after_video', 'stay_save', 'stay_ask_after_arrival', 'stay_ask_before_cleaning'].map(k => (i18n.match(new RegExp(`\\b${k}: '`, 'g')) ?? []).length), [3, 3, 3, 3, 3, 3])

// ── at arrival: Start opens the recorder (CKS 2026-11-17) ──────────────────
const reads = readFileSync(join(repo, 'src/lib/jobReads.ts'), 'utf8')
// Its own key and its own column, through the company's shared settings read
// (lib/tenantColumnsCore): a database without the column still fails this read
// alone (scripts/test-tenant-settings.mjs).
check('the switch: its own read of its own column, cached', has(reads, "export const stayAtArrivalTenantRead = (tenantId: string): CacheRead => ({\n  key: `sraten:${tenantId}`,\n  q: () => tenantColumns(tenantId, ['stay_rating_at_arrival']),"), true)
check('…in the day pack (Start opens the recorder with no signal)', has(reads, 'if (!isTask) reads.push(stayAtArrivalTenantRead(user.tenant_id))'), true)
check('…read on open; an error or no column is off', has(detail, "cachedRead(stayAtArrivalTenantRead(user.tenant_id))\n      .then(r => setRateAtArrival(!r.error && (r.data as any)?.stay_rating_at_arrival === true))"), true)
check('…only with videos on, on a clean with the rating card', has(detail, 'const ratesAtArrival = rateAtArrival && videoEnabled && !isTask && !isResidential'), true)
const arrivalAsk = detail.slice(at_('  function askArrivalVideo() {'), at_('  function openWalkthrough('))
check('Start, rating at arrival: no question, the recorder (once, for whoever works it, not on a view-only clean)',
  [has(arrivalAsk, 'if (!arrivalAsked.current && !recordsForOthers && ratesAtArrival && !readOnly) {\n      arrivalAsked.current = true\n      void guideArrival()\n      return\n    }'),
   arrivalAsk.indexOf('void guideArrival()') < arrivalAsk.indexOf("Alert.alert(`🎥 ${t('walkthrough_arrival_title')}`")], [true, true])
check('…what the clean has decides: the recorder on Arrival (remembered as guided), or the ask at once',
  [has(arrivalAsk, 'const step = arrivalStep({ hasArrival, rated: stay.saved || rated })'),
   has(arrivalAsk, "arrivalGuided.current = true\n      openWalkthrough('before')"), has(arrivalAsk, 'askStayAtArrival(false)')], [true, true, true])
check('…read live, at most 4 seconds each, the phone\'s own clips counted',
  [(arrivalAsk.match(/, 4000\)/g) ?? []).length, has(arrivalAsk, 'queuedJobVideos(job.id).catch(() => null)'), has(arrivalAsk, 'return lists ? arrivalOnClean(lists) : null')], [2, true, true])
const leftFn = fnBody('function leftArrivalRecorder() {')
check('leaving Start\'s recorder without a video still asks (unrated, card showing), once',
  ['if (!arrivalGuided.current) return', 'arrivalGuided.current = false', 'if (stayShows && !readOnly && !stay.saved) askStayAtArrival(false)'].map(x => has(leftFn, x)), [true, true, true])
check('…wired to the recorder\'s back', has(recorderMount, 'loadVideosOwed(); leftArrivalRecorder() }} />'), true)
const atArrFn = fnBody('function askStayAtArrival(videoSaved: boolean) {')
check('the ask at arrival: arrival mode, says whether a video was saved, nothing waits on it',
  ["setStayAskMode('arrival')", 'setStayAskVideoSaved(videoSaved)', 'setStayAskOpen(true)'].map(x => has(atArrFn, x)).concat(has(atArrFn, 'stayAnswer.current =')), [true, true, true, false])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
