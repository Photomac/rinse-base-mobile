#!/usr/bin/env node
// A finished clean is view only for the crew, and the walkthrough recorder
// opens on Arrival at the start of a day-shift clean (CKS, Catherine,
// 2026-10-28; src/lib/finishedClean.ts).
//
// Runs the REAL src/lib/finishedClean.ts (with jobScope.ts) under Node's type
// stripping and checks:
//   • who reads a finished clean without changing it: the crew, on a
//     completed clean; never the office, never before Complete, never an
//     inspection, task or laundry run;
//   • the recorder's default: Arrival before Start and for 15 minutes after,
//     Guest ready later, and Guest ready on a started clean with no time;
// and, in the screens: day shift hands the clean's Start to the recorder;
// every control on a clean's screen that writes is off when read-only (the
// checklist answers, room photos and sign-off, the laundry, pet, stay and
// incident cards, notes, the Supplies and walkthrough chips); the photos
// screen takes no photo and offers no delete; the finished banner and the
// inspection card come before everything else; the note exists in en, es, pt.
//
// Usage: node scripts/test-finished-clean.mjs
import { readFileSync } from 'node:fs'
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
// finishedClean imports './jobScope' the way Metro wants it; Node needs the file.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === './jobScope' && ctx.parentURL?.includes('/src/lib/')) {
      return next(pathToFileURL(join(repo, 'src/lib/jobScope.ts')).href, ctx)
    }
    return next(spec, ctx)
  },
})
const F = await import(join(repo, 'src/lib/finishedClean.ts'))

// ── who reads a finished clean ──────────────────────────────────────────────
const clean = (status, job_type = 'clean') => ({ status, job_type })
check('the crew, on a completed clean',
  ['cleaner', 'lead_cleaner', 'trainee', 'inspector', 'maintenance', null].map(r => F.finishedCleanReadOnly(r, clean('completed'))),
  [true, true, true, true, true, true])
check('never the office', ['owner', 'manager', 'dispatcher'].map(r => F.finishedCleanReadOnly(r, clean('completed'))), [false, false, false])
check('only once completed',
  ['pending_approval', 'scheduled', 'en_route', 'in_progress', 'paused', 'cancelled', 'no_show'].map(s => F.finishedCleanReadOnly('cleaner', clean(s))),
  [false, false, false, false, false, false, false])
check('cleans only: not an inspection, task or laundry run',
  ['inspection', 'task', 'laundry_run'].map(t => F.finishedCleanReadOnly('cleaner', clean('completed', t))), [false, false, false])
check('a row with no job_type is a clean', F.finishedCleanReadOnly('cleaner', { status: 'completed' }), true)
check('no job: nothing to lock', [F.finishedCleanReadOnly('cleaner', null), F.finishedCleanReadOnly('cleaner', undefined)], [false, false])

// ── the recorder's default ──────────────────────────────────────────────────
const start = '2026-10-28T15:00:00.000Z'
const at = min => Date.parse(start) + min * 60_000
const def = (started, startedAt, min) => F.walkthroughDefault({ started, startedAt, now: at(min) })
check('not started: Arrival', [def(false, null, 0), def(false, start, 90)], ['before', 'before'])
check('Arrival from Start to just under 15 minutes', [0, 1, 5, 14.99].map(m => def(true, start, m)), ['before', 'before', 'before', 'before'])
check('Guest ready from 15 minutes on', [15, 16, 45, 240].map(m => def(true, start, m)), ['after', 'after', 'after', 'after'])
check('a phone clock a little behind the start is still Arrival', def(true, start, -2), 'before')
check('started, no time known: Guest ready, as before', [def(true, null, 0), def(true, undefined, 0), def(true, '', 0), def(true, 'not a time', 0)], ['after', 'after', 'after', 'after'])
check('the window is 15 minutes', F.ARRIVAL_WINDOW_MS, 15 * 60_000)

// ── the screens ─────────────────────────────────────────────────────────────
const detail = readFileSync(join(repo, 'src/screens/JobDetailScreen.tsx'), 'utf8')
const photos = readFileSync(join(repo, 'src/screens/JobPhotosScreen.tsx'), 'utf8')
const stay = readFileSync(join(repo, 'src/components/StayRatingCard.tsx'), 'utf8')
const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
const has = (src, s) => src.includes(s)

check('read-only is the shared rule, for this viewer and this clean',
  has(detail, 'const readOnly = finishedCleanReadOnly(user.role, job)'), true)
check('day shift hands the clean\'s Start to the recorder',
  /const firstIn = timeEntries\[0\]\?\.clocked_in_at \|\| activeEntry\?\.clocked_in_at \|\| \(dailyMode \? jobStartAt : null\)/.test(detail), true)
check('the recorder starts on the shared default',
  has(detail, 'walkthroughDefault({ started: isStarted, startedAt: firstIn, now: Date.now() })') && has(detail, 'defaultType={defaultType}'), true)
check('no 15-minute rule of its own left on the screen', /15 \* 60_000/.test(detail), false)

check('checklist answers and ticks are off',
  [has(detail, '<TouchableOpacity key={v} disabled={readOnly}'), has(detail, '<TouchableOpacity disabled={readOnly} onPress={() => {\n                                    const newVal = !checked[item.id]')], [true, true])
check('room shots, Report an issue here and room sign-off are gone',
  [has(detail, '{!readOnly && <TouchableOpacity onPress={() => shootEvidence(e)}'),
   has(detail, "{g.key !== '__other__' && !isTask && !readOnly && ("),
   has(detail, ') : readOnly ? null : (')], [true, true, true])
check('a restock line does not open the Supplies counts',
  has(detail, "{/^restock/i.test((item.title || '').trim()) && item.room_uid && !readOnly && ("), true)
check('the walkthrough list, photos, stay rating and laundry bags are told',
  ['<WalkthroughChecklist job={job} user={user} readOnly={readOnly}',
   'readOnly={readOnly} onBack={() => { setShowPhotos(false)',
   '<StayRatingCard job={job} user={user} readOnly={readOnly} />',
   'bagColor={tx(bagColor)} readOnly={readOnly} />'].map(s => has(detail, s)), [true, true, true, true])
check('laundry on-site and pet toggles are off',
  [has(detail, 'onPress={toggleLaundryDoneOnsite} disabled={readOnly}'), has(detail, 'onPress={togglePetFee} disabled={readOnly}')], [true, true])
check('no new incident, no notes box',
  [has(detail, '{isStarted && (!isTask || isInspection) && !readOnly && <IncidentReportCard'), has(detail, '{isStarted && !readOnly && (\n          <View style={styles.card}>\n            <Text style={styles.sectionTitle}>{t(\'notes_optional\')}')], [true, true])
check('no Supplies or walkthrough chip',
  [has(detail, '{(!isTask || isInspection) && !readOnly && (\n              <TouchableOpacity style={styles.actionChip} onPress={() => setShowInventory(true)}>'),
   has(detail, '{!isTask && videoEnabled && !readOnly && (')], [true, true])
const bagCard = detail.slice(detail.indexOf('function TakeHomeLaundryCard'), detail.indexOf('const DEFAULT_CHECKLIST'))
check('laundry bags: no −, + or Save when read-only',
  (bagCard.match(/\{!readOnly && <TouchableOpacity/g) || []).length, 3)

const banner = detail.indexOf("{t('finished_view_only')}")
const card = detail.indexOf('<InspectionResultCard job={job} />')
const checkFirst = detail.indexOf('<CheckFirstCard ')
check('finished banner, then the inspection card, before Check first',
  [banner > 0, card > banner, checkFirst > card], [true, true, true])
check('the inspection card and the banner each appear once',
  [detail.split('<InspectionResultCard job={job} />').length - 1, detail.split('styles.completedBanner').length - 1], [1, 1])

check('photos screen: capture controls only when not read-only',
  has(photos, '{!readOnly && <>\n        {/* Photo type selector */}') && has(photos, '</TouchableOpacity>\n        </View>\n        </>}'), true)
check('photos screen: no note or delete on long press',
  has(photos, 'if (!photo.queued && !readOnly) openPhotoOptions(photo)'), true)
check('photos screen: "go take the required shots" not shown', has(photos, 'requiredOutstanding > 0 && !readOnly && ('), true)
check('stay rating: read-only shows text, never a save', (() => {
  const ro = stay.slice(stay.indexOf('if (readOnly) {'), stay.indexOf('  return (\n    <View style={styles.card}>\n      <Text style={styles.title}>{t(\'stay_rating_title\')}</Text>\n      <Text style={styles.sub}>'))
  return [ro.length > 0, /TouchableOpacity|TextInput|save\(/.test(ro), ro.includes('if (!rating) return null')]
})(), [true, false, true])

check('the view-only note in English, Spanish and Portuguese',
  (i18n.match(/finished_view_only: '/g) || []).length, 3)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
