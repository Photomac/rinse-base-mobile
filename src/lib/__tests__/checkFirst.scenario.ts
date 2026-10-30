// "Check first" scenario test. Run with: node scripts/test-check-first.mjs
//
// Exercises the REAL src/lib/checkFirst.ts (pure) against what the server's
// gate does (rinse-base-app migration 20261015130534_check_first_list:
// job_completion_blockers' check_first_unticked / check_first_photo_missing,
// job_check_first_cutoff), then checks the screens' wiring on their source
// text (src/ is copied next to the scenario by the runner): the card on top,
// the window at Start after the note's, ticks and "seen" through the outbox,
// the phone's own check before Complete, the photo's tag, the reads the
// offline day pack saves, and that every new string exists in all three
// languages.
//
// Asked for by CKS Perfections (Catherine, 2026-10-15): "I want them
// acknowledged, not just available to look at."
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isCheckFirstJob, activeLines, linesByProperty, firstClockIn, startedAt, blocksThisClean, lineState,
  outstanding, localBlockers, lineText, tickRow, seenRow, TICK_CONFLICT, SEEN_CONFLICT, CHECK_FIRST_CODES,
  CHECK_FIRST_MAX, type CheckFirstLine,
} from '../checkFirst'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8')
const between = (text: string, from: string, to: string) => {
  const i = text.indexOf(from)
  return i < 0 ? '' : text.slice(i, text.indexOf(to, i + from.length))
}

const L = (id: string, sort: number, created: string, extra: Partial<CheckFirstLine> = {}): CheckFirstLine => ({
  id, body: `Line ${id}`, photo_required: false, sort_order: sort, created_at: created, archived_at: null, ...extra,
})

// ── which jobs ──
ok('a clean (or a job with no type) has Check first', isCheckFirstJob({ job_type: 'clean' }) && isCheckFirstJob({ job_type: null }) && isCheckFirstJob({}))
ok('inspections, tasks and laundry runs never do',
  !isCheckFirstJob({ job_type: 'inspection' }) && !isCheckFirstJob({ job_type: 'task' }) && !isCheckFirstJob({ job_type: 'laundry_run' }) && !isCheckFirstJob(null))

// ── the list ──
const plants = L('plants', 1, '2026-10-10T12:00:00Z', { body: 'Water all the plants' })
const spa = L('spa', 2, '2026-10-10T12:00:00Z', { body: 'Spa photo', photo_required: true })
const propane = L('propane', 2, '2026-10-09T12:00:00Z', { body: 'Propane OFF' })
const old = L('old', 0, '2026-09-01T12:00:00Z', { archived_at: '2026-09-02T00:00:00Z' })
const late = L('late', 9, '2026-10-15T17:30:00Z', { body: 'Check the hot tub cover' })
ok('archived lines are not shown; the rest in the office\'s order (sort_order, then oldest first)',
  activeLines([spa, old, late, plants, propane]).map(l => l.id).join() === 'plants,propane,spa,late')
const byProp = linesByProperty([{ ...spa, address_id: 'A2' }, { ...plants, address_id: 'A2' }, { ...propane, address_id: 'A5' }, { ...old, address_id: 'A5' }])
ok('the prep card: lines grouped by property, in order, archived left out',
  Object.keys(byProp).sort().join() === 'A2,A5' && byProp.A2.map(l => l.id).join() === 'plants,spa' && byProp.A5.map(l => l.id).join() === 'propane')

// ── when the clean started (job_check_first_cutoff) ──
ok('first clock-in: the earliest of everyone\'s, punches with none skipped',
  firstClockIn([{ clocked_in_at: '2026-10-15T16:10:00Z' }, { clocked_in_at: null }, { clocked_in_at: '2026-10-15T16:02:00Z' }]) === '2026-10-15T16:02:00Z')
ok('no punches: none', firstClockIn([]) === null)
ok('start: the first clock-in, else started_at (daily time tracking), else not started',
  startedAt('2026-10-15T16:02:00Z', '2026-10-15T15:00:00Z') === '2026-10-15T16:02:00Z' &&
  startedAt(null, '2026-10-15T15:00:00Z') === '2026-10-15T15:00:00Z' && startedAt(null, undefined) === null)
const START = '2026-10-15T16:00:00Z'
ok('not started: every line counts', blocksThisClean(late, null))
ok('a line written before the start, or at it, counts', blocksThisClean(plants, START) && blocksThisClean({ created_at: START }, START))
ok('a line written after the start doesn\'t (it\'s still shown)', !blocksThisClean(late, START))

// ── a line's state ──
const none = new Set<string>()
ok('not ticked: todo', lineState(spa, none, none) === 'todo')
ok('a photo line ticked, its photo not taken: needs_photo', lineState(spa, new Set(['spa']), none) === 'needs_photo')
ok('…photo taken (or still on the phone): done', lineState(spa, new Set(['spa']), new Set(['spa'])) === 'done')
ok('an ordinary line: done once ticked', lineState(plants, new Set(['plants']), none) === 'done')

// ── what blocks Complete: the gate's two codes ──
const list = [plants, spa, propane, old, late]
const left = outstanding(list, new Set(['plants', 'spa']), none, START)
ok('mid-clean at CKS: Propane not ticked, the spa photo missing; the late line and the archived one don\'t block',
  left.map(x => `${x.line.id}:${x.state}`).join() === 'propane:todo,spa:needs_photo', left.map(x => `${x.line.id}:${x.state}`).join())
ok('all ticked, the spa photo waiting to upload: nothing left',
  outstanding(list, new Set(['plants', 'spa', 'propane']), new Set(['spa']), START).length === 0)
ok('the codes are the gate\'s', CHECK_FIRST_CODES.join() === 'check_first_unticked,check_first_photo_missing')

// ── the phone's own check: only where the company's switch is on ──
ok('switch on: what the gate would say', localBlockers(true, list, none, none, START).length === 3)
ok('switch off, or unknown (a failed read): never blocks here',
  localBlockers(false, list, none, none, START).length === 0 && localBlockers(null, list, none, none, START).length === 0 &&
  localBlockers(undefined, list, none, none, START).length === 0)
ok('no lines (a failed read): never blocks', localBlockers(true, [], none, none, START).length === 0)

// ── the rows the phone sends ──
const at = new Date('2026-10-15T16:20:00Z')
const tick = tickRow({ tenantId: 't-cks', jobId: 'J1', userId: 'u-nichole', line: { id: 'spa', body: '  Spa photo ' }, at })
ok('a tick: exactly the columns crew may insert (no id, no created_at)',
  JSON.stringify(tick) === JSON.stringify({ tenant_id: 't-cks', job_id: 'J1', line_id: 'spa', user_id: 'u-nichole', line_text: 'Spa photo', ticked_at: '2026-10-15T16:20:00.000Z' }))
ok('…the line kept within the column\'s 200 characters', lineText('x'.repeat(205)).length === CHECK_FIRST_MAX)
ok('…sent ON CONFLICT (job_id, line_id) DO NOTHING', TICK_CONFLICT === 'job_id,line_id')
ok('"seen at Start": exactly its insertable columns, once per person per clean',
  JSON.stringify(seenRow({ tenantId: 't-cks', jobId: 'J1', userId: 'u-nichole', at })) ===
    JSON.stringify({ tenant_id: 't-cks', job_id: 'J1', user_id: 'u-nichole', seen_at: '2026-10-15T16:20:00.000Z' }) &&
  SEEN_CONFLICT === 'job_id,user_id')

// ── the job screen ──
const detail = src('screens/JobDetailScreen.tsx')
const card = detail.indexOf('<CheckFirstCard')
ok('the card is the first thing on the screen: above the office\'s note and the property photo',
  card > 0 && card < detail.indexOf('<CrewNoteBanner note={crewNoteShown}') && card < detail.indexOf('{/* Property photo'))
ok('…shown before and after Start (not behind isStarted), cleans only',
  /\{!!checkFirst && !isTask && \(\s*<View onLayout=\{e => \{ cfY\.current = e\.nativeEvent\.layout\.y \}\}>\s*<CheckFirstCard/.test(detail))
// The card's reads live in lib/checkFirstCard (the screen loads through it).
const cfCard = src('lib/checkFirstCard.ts')
ok('its reads are the shared builders (the offline day pack saves them)',
  ['checkFirstLinesRead(addrId)', 'checkFirstTenantRead(user.tenant_id)', 'checkFirstTicksRead(job.id)', 'checkFirstPhotosRead(job.id)', 'checkFirstStartRead(job.id)']
    .every(r => cfCard.includes(`readSoon(${r}`)) &&
  /return cfCard\.load\(job, user, opts\)/.test(between(detail, 'function loadCheckFirst(', '\n  }\n')))
ok('only the screen opening shows the saved copy first; every other load waits for the live answer',
  (detail.match(/loadCheckFirst\(\{ soon: true \}\)/g) || []).length === 1 &&
  /loadCheckFirst\(\{ soon: true \}\)/.test(between(detail, 'flushOutbox().catch(() => {})', '}, [])')))
ok('a tick or a line photo keeps an earlier load\'s late answer off the card',
  [between(detail, 'async function writeCheckFirstTick(', '\n  }\n'), between(detail, 'async function shootCheckFirst(', '\n  }\n')]
    .every(f => f.indexOf('cfCard.edited()') > 0 && f.indexOf('cfCard.edited()') < f.indexOf('setCheckFirst(')))
ok('ticks queued offline show as ticked', cfCard.includes("overlayPending('job_check_first_ticks'"))
ok('a line photo still on the phone counts as taken', /queuedJobPhotos\(job\.id\)/.test(between(cfCard, 'async function viewOf(', '\n}\n')) && cfCard.includes('q.check_first_line_id'))
ok('a tick goes through the outbox (FIFO, ahead of a queued Complete), insert-only and idempotent',
  detail.includes("table: 'job_check_first_ticks', op: 'upsert', onConflict: TICK_CONFLICT, ignoreDuplicates: true"))
ok('so does "seen"', detail.includes("table: 'job_check_first_seen', op: 'upsert', onConflict: SEEN_CONFLICT, ignoreDuplicates: true"))
ok('neither is ever written around the outbox', !/from\('job_check_first_(ticks|seen)'\)/.test(detail))
const shoot = between(detail, 'async function shootCheckFirst(', '\n  }\n')
ok('a photo line: the photo is queued, then the line ticked', shoot.indexOf('captureCheckFirstPhoto(') > 0 && shoot.indexOf('captureCheckFirstPhoto(') < shoot.indexOf('writeCheckFirstTick(line)'))
ok('only someone who can tick does (the server takes ticks only from the clean\'s crew or the office)',
  /if \(cfBusy \|\| !cfCanTick\) return/.test(between(detail, 'async function tickCheckFirst(', '\n  }\n')) && /if \(cfBusy \|\| !cfCanTick\) return/.test(shoot) &&
  detail.includes("const cfCanTick = !isTask && job.status !== 'completed' && (onThisClean || isAdminRole)"))
ok('office text in the crew\'s language: the lines go through tx()', /useMachineTranslation\(lang, \[[\s\S]*?\.\.\.\(checkFirst\?\.lines \?\? \[\]\)\.map\(l => l\.body\),\s*\]\)/.test(detail))
ok('the window at Start is rendered, with "Not yet" backing out', detail.includes('<CheckFirstModal visible={!!cfPrompt}') && detail.includes('onNotYet={() => setCfPrompt(null)}'))

const complete = between(detail, 'async function completeJob(', '\n  }\n')
const rpcAt = complete.indexOf("supabase.rpc('job_completion_blockers'")
ok('Complete: the phone checks first, before asking the gate (offline the gate can\'t be asked)',
  complete.indexOf('localBlockers(cf.required,') > 0 && complete.indexOf('localBlockers(cf.required,') < rpcAt)
ok('…from a fresh load (the copy on screen if it\'s slow), and a load that fails blocks nothing',
  complete.includes('loadCheckFirst().catch(() => null),') && complete.includes('setTimeout(() => resolve(checkFirst), 8_000)') && complete.includes('if (cf) {'))
ok('…writes queued offline are sent before the gate is asked', complete.includes('Promise.all([flushQueue(), flushOutbox(), announceVideos()])') && complete.indexOf('flushOutbox()') < rpcAt)
ok('the gate\'s two codes get their own message, before the catch-all',
  complete.indexOf("b.code === 'check_first_unticked' || b.code === 'check_first_photo_missing'") > rpcAt &&
  complete.indexOf("b.code === 'check_first_unticked' || b.code === 'check_first_photo_missing'") < complete.indexOf("t('completion_blocked_generic')"))
ok('the message names the lines and goes back to the card', /function alertCheckFirst\(/.test(detail) && /scrollRef\.current\?\.scrollTo\(\{ y: Math\.max\(0, cfY\.current - 12\)/.test(detail))

// ── the card and the window ──
const comp = src('components/CheckFirst.tsx')
ok('"every line must be ticked" is said only where the switch is on', comp.includes("props.view.required && props.canTick && left > 0 && <Text style={styles.hint}>{t('check_first_hint')}") && comp.includes("props.view.required && <Text style={[styles.hint"))
ok('a photo line is ticked by its photo, not a tap', comp.includes('const tappable = canTick && !tick && !line.photo_required && busy === null'))
ok('"Not yet" is the crew note\'s own wording', comp.includes("t('crew_note_not_yet')"))

// ── the photo ──
const capture = src('lib/requiredPhotoCapture.ts')
const cfCapture = between(capture, 'export async function captureCheckFirstPhoto(', '\n}\n')
ok('a line\'s photo: photo_type after, tagged with its line', cfCapture.includes("photo_type: 'after'") && cfCapture.includes('check_first_line_id: line.id'))
const queue = src('lib/photoQueue.ts')
ok('the queue sends check_first_line_id only on such a photo', queue.includes('if (entry.check_first_line_id) row.check_first_line_id = entry.check_first_line_id') &&
  queue.includes('...(p.check_first_line_id ? { check_first_line_id: p.check_first_line_id } : {})'))
ok('…and a database without the column gets the row without it', queue.includes("const NEW_COLUMNS = ['taken_at', 'photo_sha256', 'check_first_line_id'] as const") && queue.includes("error.code === '42703'"))
ok('the Photos screen doesn\'t count a line\'s photo under After',
  src('screens/JobPhotosScreen.tsx').includes("photos.filter(p => p.photo_type === 'after' && !checkFirstPhoto(p))"))

// ── reads, the offline day pack, the cache ──
const reads = src('lib/jobReads.ts')
ok('lines: only the ones not archived, in order', reads.includes(".eq('address_id', addrId).is('archived_at', null)\n    .order('sort_order').order('created_at')"))
ok('the pack saves them for a clean, and the rest only where there are lines',
  /checkFirstTenantRead\(user\.tenant_id\),\s*\{ \.\.\.checkFirstLinesRead\(addrId\), then: rows => \(Array\.isArray\(rows\) && rows\.length\s*\? \[checkFirstTicksRead\(job\.id\), checkFirstPhotosRead\(job\.id\), checkFirstStartRead\(job\.id\)\] : \[\]\) \}/.test(reads))
ok('per-job and per-property keys are pruned with their stop', /'cfticks', 'cfphotos', 'cfstart'/.test(reads) && /'wttrash', 'cflines'\]/.test(reads))
ok('the prep card\'s copy is day-keyed like the rest of it', reads.includes('key: `prep:cflines:${user.id}:${ymd}`') && reads.includes('(addr|resv2|restock|linen|extras|cflines)'))
ok('…and the day pack saves it', src('lib/offlinePrefetch.ts').includes('add(p.checkFirst)'))

// ── the prep card ──
const prep = src('components/PrepCard.tsx')
ok('the prep card lists the day\'s lines per property, read-only', prep.includes('cachedRead(reads.checkFirst)') && prep.includes("t('check_first_prep_title')") && !/writeThrough|supabase/.test(prep))

// ── strings ──
const i18n = src('lib/i18n.ts')
const used = [...new Set([detail, comp, prep].flatMap(f => [...f.matchAll(/t\('(check_first_[a-z_]+)'\)/g)].map(m => m[1])))]
ok('the screens use the Check first strings', used.length >= 13, String(used.length))
for (const k of used) {
  const vals = [...i18n.matchAll(new RegExp(`\\b${k}: '([^']*)'`, 'g'))].map(m => m[1])
  ok(`"${k}" in en, es and pt`, vals.length === 3, String(vals.length))
  const holes = (v: string) => [...v.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join()
  ok(`"${k}": the same placeholders in every language`, vals.every(v => holes(v) === holes(vals[0])), vals.map(holes).join(' / '))
}
const titles = [...i18n.matchAll(/\bcheck_first_title: '([^']*)'/g)].map(m => m[1])
ok('"Check first" is "Revisar primero" and "Verificar primeiro"', titles.join('|') === 'Check first|Revisar primero|Verificar primeiro', titles.join('|'))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
if (failures) process.exit(1)
