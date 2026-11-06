#!/usr/bin/env node
// A checklist line can ask a question (Yes/No, text, a number) and ask for a
// video clip, optional or required, as it can ask for a photo (Five Star
// Hospitality, 2026-11-06; rinse-base-app migration
// 20261106190000_checklist_line_videos).
//
// Runs the REAL src/lib/lineVideos.ts and lineAnswers.ts under Node's type
// stripping (answers: number normalisation and refusals, the gate's codes), then the
// REAL videoQueue.ts beside the REAL outbox.ts (scenario:
// src/lib/__tests__/lineVideos.scenario.ts): a line clip's record and row name
// the line, a walkthrough clip is sent exactly as before, and a line deleted
// while its clip waited doesn't strand the clip. And, in the screens: the line
// shows a record button and can't be ticked before its clip, the recorder's
// line mode, Complete names the lines, the reads change nothing before the
// migration applies.
//
// Usage: node scripts/test-line-videos.mjs
//   With the web repo: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-line-videos.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(repo, p), 'utf8')
let pass = 0, fail = 0
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

// ── The rules (lib/lineVideos) ──────────────────────────────────────────────
const L = await import(join(repo, 'src/lib/lineVideos.ts'))
check('a clip counts from 3 seconds, a line clip runs at most a minute', [L.LINE_CLIP_MIN_SECONDS, L.LINE_CLIP_MAX_SECONDS], [3, 60])
check('the caption is room · wording', L.lineClipCaption(' Bathroom 2 ', 'Whole view'), 'Bathroom 2 · Whole view')
check('…a line with no room is its wording', L.lineClipCaption(null, 'Lock every door'), 'Lock every door')
check('…never over the server\'s 300', L.lineClipCaption('R', 'x'.repeat(400)).length, 300)
const rowsRead = [
  { id: 'A', video_mode: 'required', answer_type: 'tick', answer: null, job_videos: [{ id: 'v1', duration_seconds: 20 }], job_videos_on_the_way: [] },
  { id: 'B', video_mode: 'optional', answer_type: 'yes_no', answer: 'no', job_videos: [], job_videos_on_the_way: [{ id: 'w1', duration_seconds: 5 }] },
  { id: 'C', video_mode: 'required', answer_type: 'number', answer: '16', job_videos: [{ id: 'v2', duration_seconds: 2 }], job_videos_on_the_way: [{ id: 'w2', duration_seconds: 1 }] },
  { id: 'D', video_mode: 'sometimes', answer_type: 'essay', answer: 7, job_videos: [{ id: 'v3', duration_seconds: null }] },
]
{
  const r = L.lineAskRows(rowsRead)
  check('the read: what each line asks', [...r.asks.entries()].map(([id, a]) => [id, a.video_mode, a.answer_type, a.answer]),
    [['A', 'required', 'tick', null], ['B', 'optional', 'yes_no', 'no'], ['C', 'required', 'number', '16'], ['D', 'off', 'tick', null]])
  check('…a value it doesn\'t know reads as the default, never stricter', r.asks.get('D'), { video_mode: 'off', answer_type: 'tick', answer: null })
  check('…landed is uploaded, announced is sending, too short or no length is nothing', r.server, { A: 'uploaded', B: 'sending' })
}
check('a failed read (or a server before the migration): every line a tick', [L.lineAskRows(null).asks.size, L.lineAskRows({ message: 'column does not exist' }).asks.size], [0, 0])
const q = (checklist_item_id, duration_seconds, video_type = 'line') => ({ checklist_item_id, duration_seconds, video_type })
check('this phone\'s clips laid over the server\'s; a landed clip wins',
  L.lineClipStates({ A: 'uploaded' }, [q('A', 10), q('C', 10), q('D', 2), q('E', 10, 'after')]), { A: 'uploaded', C: 'sending' })
check('a clip on this phone for the line, long enough', [L.lineClipOnPhone('C', [q('C', 3)]), L.lineClipOnPhone('C', [q('C', 2)]), L.lineClipOnPhone('C', [q('C', 9, 'after')])], [true, false, false])
const blockers = [
  { code: 'missing_required_photo', checklist_item_id: 'P' },
  { code: 'missing_required_video', checklist_item_id: 'A', room: 'Bathroom', task: 'Whole view' },
  { code: 'no_finished_video' },
]
check('the gate\'s video lines', L.videoLinesInBlockers(blockers), [{ checklist_item_id: 'A', room: 'Bathroom', task: 'Whole view' }])
check('…none, no answer', [L.videoLinesInBlockers([{ code: 'no_after_photo' }]), L.videoLinesInBlockers(null)], [[], []])
check('a refused Complete names its lines', L.videoLinesInRefusal(`RB_BLOCKED: ${JSON.stringify(blockers)}`).map(b => b.checklist_item_id), ['A'])
check('…another error, broken JSON, nothing', [L.videoLinesInRefusal('new row violates row-level security'), L.videoLinesInRefusal('RB_BLOCKED: [{"code":'), L.videoLinesInRefusal(null)], [[], [], []])
check('with no answer from the gate: only REQUIRED video lines with no clip are owed (optional never)',
  L.videoLinesMissing([{ jobItemId: 'A', video_mode: 'required' }, { jobItemId: 'B', video_mode: 'required' }, { jobItemId: 'C', video_mode: 'optional' },
    { jobItemId: 'E', video_mode: 'off' }, { video_mode: 'required' }], { A: 'sending' }).map(i => i.jobItemId),
  ['B'])

// ── Questions (lib/lineAnswers) ─────────────────────────────────────────────
const A = await import(join(repo, 'src/lib/lineAnswers.ts'))
check('a question is yes_no / text / number on a Do line', [
  A.questionType({ answer_type: 'yes_no', item_kind: 'task' }), A.questionType({ answer_type: 'text' }), A.questionType({ answer_type: 'number', item_kind: 'task' }),
  A.questionType({ answer_type: 'tick', item_kind: 'task' }), A.questionType({ answer_type: 'yes_no', item_kind: 'verify' }), A.questionType({}), A.questionType(null)],
  ['yes_no', 'text', 'number', null, null, null, null])
const n = (type, raw) => { const r = A.normaliseAnswer(type, raw); return r.ok ? r.value : `refused:${r.reason}` }
check('numbers: a comma is a point, spaces and a + dropped, "3." and ".5" tidied', [n('number', '3,5'), n('number', ' 1 6 '), n('number', '+3'), n('number', '3.'), n('number', '.5'), n('number', '-.25'), n('number', '-2'), n('number', '0')],
  ['3.5', '16', '3', '3', '0.5', '-0.25', '-2', '0'])
check('numbers the server would refuse are refused here', [n('number', 'abc'), n('number', '1e5'), n('number', '1,234,5'), n('number', '3.12345'), n('number', '1234567890123'), n('number', '--1'), n('number', '1-2'), n('number', '12 kg')],
  Array(8).fill('refused:number'))
check('…the longest the server takes', [n('number', '123456789012.1234'), n('number', '-123456789012.1234')], ['123456789012.1234', '-123456789012.1234'])
check('numbers: empty clears', [n('number', ''), n('number', '  '), n('number', null)], [null, null, null])
check('Yes / No: only yes or no; empty clears', [n('yes_no', 'yes'), n('yes_no', 'NO'), n('yes_no', 'maybe'), n('yes_no', ''), n('yes_no', null)], ['yes', 'no', 'refused:yes_no', null, null])
check('text: trimmed; blank clears; over 2,000 refused; 2,000 taken', [n('text', '  Two towels missing '), n('text', '   '), n('text', 'x'.repeat(2001)), n('text', 'x'.repeat(2000)).length],
  ['Two towels missing', null, 'refused:too_long', 2000])
check('the app\'s number rule is the server\'s', A.NUMBER_ANSWER.source, '^-?[0-9]{1,12}(\\.[0-9]{1,4})?$')
check('an answer is written as a tick: answered = completed by them, now', A.answerWrite('yes', 'U1', '2026-11-06T15:00:00.000Z'),
  { answer: 'yes', completed: true, completed_at: '2026-11-06T15:00:00.000Z', completed_by: 'U1' })
check('…cleared = not completed', A.answerWrite(null, 'U1', 'x'), { answer: null, completed: false, completed_at: null, completed_by: null })
{
  const items = [
    { jobItemId: 'T1', answer_type: 'tick', item_kind: 'task', title: 'Mop floors' },
    { jobItemId: 'Q1', answer_type: 'yes_no', item_kind: 'task', title: 'Any water spots?' },
    { jobItemId: 'Q2', answer_type: 'number', item_kind: 'task', title: 'Pool temperature' },
  ]
  const req = [
    { code: 'unchecked_required_item', checklist_item_id: 'T1', room: 'Kitchen', task: 'Mop floors' },
    { code: 'unchecked_required_item', checklist_item_id: 'Q1', room: 'Bathroom', task: 'Any water spots?' },
    { code: 'unchecked_required_item', checklist_item_id: 'X9', room: 'Kitchen', task: 'Unknown here' },
    { code: 'unchecked_required_item', checklist_item_id: 'Q2', room: 'Outside', task: 'Pool temperature' },
  ]
  check('the gate\'s required items: rooms for ticks (once each), then "Answer: …" for each question',
    A.requiredItemBullets(req, items, { room: r => r, answer: (item, task) => `Answer: ${item ? item.title : task}` }),
    ['Kitchen', 'Answer: Any water spots?', 'Answer: Pool temperature'])
}

// ── The screens ─────────────────────────────────────────────────────────────
const detail = read('src/screens/JobDetailScreen.tsx')
const walk = read('src/screens/WalkthroughScreen.tsx')
const reads = read('src/lib/jobReads.ts')
const card = read('src/lib/checklistCard.ts')
const queue = read('src/lib/videoQueue.ts')
check('what each line asks is its own read: video, question, answer, clips; only lines that ask for more than a tick',
  /lineVideosRead = \(jobId: string\): CacheRead => \(\{\s*key: `linevids:\$\{jobId\}`,\s*q: \(\) => supabase\.from\('job_checklist_items'\)\s*\.select\('id, video_mode, answer_type, flag_answer, answer, job_videos\(id, duration_seconds\), job_videos_on_the_way\(id, duration_seconds\)'\)\s*\.eq\('job_id', jobId\)\.or\('video_mode\.neq\.off,answer_type\.neq\.tick'\),/.test(reads))
check('…so the line read the card has always made is untouched',
  /checklistRowsRead[\s\S]{0,200}\.select\('id, room, task, sort_order, completed, photo_required, room_id, item_kind, level, result, issue_note'\)/.test(reads))
check('the card reads it with the others; answers given with no signal overlay it; a failed read is every line a tick',
  /readSoon\(lineVideosRead\(job\.id\), wait\)/.test(card) && /lineVids: r\[9\]\.data/.test(card)
  && /const asked = lineAskRows\(await overlayPending\('job_checklist_items', list\(p\.lineVids\), \(\) => false\)\)/.test(card)
  && /video_mode: a\?\.video_mode \?\? 'off', answer_type: a\?\.answer_type \?\? 'tick', answer: a\?\.answer \?\? null/.test(card))
check('the day pack saves it for cleans (answers, the record button, Complete with no signal)', /\.\.\.\(!isTask \? \[lineVideosRead\(job\.id\)\] : \[\]\)/.test(reads))
check('a REQUIRED video line can\'t be ticked before its clip (an optional one can)', /if \(newVal && item\.video_mode === 'required' && !lineClips\[item\.jobItemId\]\) \{\s*Alert\.alert\(`🎥 \$\{t\('line_video_required_title'\)\}`, t\('line_video_before_check_msg'\), \[\s*\{ text: t\('line_video_record'\), onPress: \(\) => openLineRecorder\(item\) \}/.test(detail))
check('…before the photo check, so a line asking for both asks for the clip first',
  detail.indexOf("if (newVal && item.video_mode === 'required' && !lineClips[item.jobItemId])") < detail.indexOf('if (newVal && item.requires_photo && !itemPhotos[item.id])'))
check('the record button on task, Check, room-complete and question lines, optional or required', (detail.match(/\{takesVideo\(item\) && lineVideoButton\(item\)\}/g) ?? []).length, 4)
check('…and the note under each', (detail.match(/\{takesVideo\(item\) && lineVideoNote\(item\)\}/g) ?? []).length, 4)
check('…an optional line with no clip says nothing; only a required one says "Video required" and shows 🎥!',
  /if \(!st && item\.video_mode !== 'required'\) return null/.test(detail) && /\{st \? '🎥 ✓' : item\.video_mode === 'required' \? '🎥!' : '🎥'\}/.test(detail))
check('a saved clip ticks only a required Do line, from 3 seconds (never an optional clip, a Check line or a question)',
  /if \(seconds < LINE_CLIP_MIN_SECONDS \|\| item\.video_mode !== 'required' \|\| item\.item_kind === 'verify'\s*\|\| questionType\(item\) \|\| checked\[item\.id\]\) return\s*setChecked\(prev => \(\{ \.\.\.prev, \[item\.id\]: true \}\)\)\s*saveCheckItem\(item, true\)/.test(detail))
check('a question shows its answer control in place of the checkbox, in every room mode',
  /if \(questionType\(item\) && item\.jobItemId\) return questionRow\(item\)\s*\/\/ task row[^\n]*\n\s*if \(g\.mode === 'room_complete'\)/.test(detail))
check('…Yes / No as two buttons, the chosen one again clears it', /onPress=\{\(\) => \{ saveAnswer\(item, on \? null : v\) \}\}/.test(detail))
check('…text and number typed, saved on blur or Done; a number on the decimal pad',
  /onBlur=\{\(\) => \{ commitAnswer\(item\) \}\}\s*onSubmitEditing=\{\(\) => \{ commitAnswer\(item\) \}\}/.test(detail) && /keyboardType=\{type === 'number' \? 'decimal-pad' : 'default'\}/.test(detail) && /multiline=\{type === 'text'\}/.test(detail))
check('…saved through the outbox like a tick (answered = completed), and put back if the server says no',
  /values: answerWrite\(answer, user\.id, new Date\(\)\.toISOString\(\)\),\s*\}\)\s*if \(error\) \{\s*setChecklist/.test(detail) && /table: 'job_checklist_items', op: 'update', match: \{ id: item\.jobItemId \},\s*values: answerWrite\(answer/.test(detail))
check('…what the server would refuse is refused on the phone, the saved answer kept', /const n = normaliseAnswer\(type, raw\)\s*if \(!n\.ok\) \{\s*Alert\.alert/.test(detail))
check('…an answer still being typed is saved before Complete asks the gate, and when the screen closes',
  /async function completeJob\(\) \{\s*\/\/[^\n]*\n\s*await commitAllAnswers\(\)/.test(detail) && /useEffect\(\(\) => \(\) => \{\s*const drafts = answerDraftsRef\.current/.test(detail))
check('the office\'s problem answer is never shown to the crew', /flag_answer/.test(detail), false)
check('Complete: a required question names itself as "Answer: …" among the required items',
  /const roomsLeft = requiredItemBullets\(requiredLeft, checklist, \{\s*room: \(r: string\) => tx\(r\),\s*answer: \(item: any, task: string\) => ti\(t\('answer_needed_line'\), \{ task: tx\(item\?\.title \?\? task\) \}\),/.test(detail))
check('the recorder opens in line mode with the line', /if \(lineFor\) \{[\s\S]{0,400}?return <WalkthroughScreen job=\{job\} user=\{user\} defaultType="after" asked\s*line=\{\{ id: lineFor\.jobItemId,/.test(detail))
check('Complete names the lines the gate says still need a clip, and opens the first',
  /const missing: VideoLineBlocker\[\] = !gateErr\s*\? videoLinesInBlockers\(blockers\)/.test(detail) && /alertVideoLinesNeeded\(left\); return/.test(detail))
check('…with no answer, the phone\'s own copy', /: videoLinesMissing\(checklist, lineClipStates\(lineClipsServer, onPhone\)\)/.test(detail))
check('…a clip on this phone the server hasn\'t heard of is still sending, not asked for again',
  /const left = missing\.filter\(b => !\(b\.checklist_item_id && lineClipOnPhone\(b\.checklist_item_id, onPhone\)\)\)/.test(detail))
check('…ahead of the generic "can\'t be completed" (an older phone\'s answer to this code)',
  detail.indexOf('videoLinesInBlockers(blockers)') > 0 && detail.indexOf('videoLinesInBlockers(blockers)') < detail.indexOf("t('completion_blocked_generic')"))
check('a refused Complete names the lines', /const refusedLines = videoLinesInRefusal\(doneErr\.message\)\s*if \(refusedLines\.length > 0\) \{ alertVideoLinesNeeded\(refusedLines\); return \}/.test(detail))
check('line mode: a minute at most, Arrival / Finished hidden', /const maxSeconds = lineId \? LINE_CLIP_MAX_SECONDS : WALKTHROUGH_MAX_SECONDS/.test(walk)
  && /maxDuration: maxSeconds,/.test(walk) && /\{!line && <View style=\{styles\.typeRow\}>/.test(walk))
check('…a clip under 3 seconds can only be retaken', /const lineTooShort = !!line && !!recorded && recorded\.duration < LINE_CLIP_MIN_SECONDS/.test(walk) && /disabled=\{saving \|\| lineTooShort\}/.test(walk))
check('…saved as a line clip with its line and caption, then back to the clean',
  /video_type: line \? 'line' : videoType,[\s\S]{0,80}\.\.\.\(line \? \{ checklist_item_id: line\.id, caption: lineClipCaption\(line\.room, line\.title\) \} : \{\}\)/.test(walk)
  && /onLineSaved\?\.\(recorded\.duration\)\s*onBack\(\)/.test(walk))
check('the walkthrough list never shows a line clip as Arrival or Finished',
  /videos\.in\('video_type', \['before', 'after'\]\)/.test(walk) && /v\.video_type !== 'line'/.test(walk))
check('…and line mode lists that line\'s clips', /videos\.eq\('checklist_item_id', lineId\)/.test(walk) && /v\.video_type === 'line' && v\.checklist_item_id === lineId/.test(walk))
check('the queue sends a walkthrough exactly as before: the line and caption keys only on a line clip',
  /\.\.\.\(entry\.video_type === 'line' \? \{ caption: entry\.caption \?\? null \} : \{\}\),\s*\.\.\.\(withLine && lineOf\(entry\) \? \{ checklist_item_id: lineOf\(entry\) \} : \{\}\),/.test(queue)
  && /\.\.\.\(withLine && lineOf\(v\) \? \{ checklist_item_id: lineOf\(v\) \} : \{\}\),/.test(queue))
check('…every record in a batch keeps its line (not map(row), whose index would drop the first)', /sendRecords\(due\.map\(v => row\(v\)\)\)/.test(queue))
const strings = read('src/lib/i18n.ts')
const keys = ['line_video_title', 'line_video_clip', 'line_video_intro', 'line_video_too_short', 'video_required_short', 'line_video_sending',
  'line_video_uploaded', 'line_video_record', 'line_video_required_title', 'line_video_before_check_msg', 'line_videos_missing_msg',
  'answer_required_short', 'answer_text_ph', 'answer_number_ph', 'answer_number_invalid', 'answer_too_long', 'answer_needed_line']
check('every new string in all three languages', keys.filter(k => (strings.match(new RegExp(`\\n    ${k}: `, 'g')) ?? []).length !== 3), [])
check('nothing new reaches past what the store builds have (expo-camera, expo-file-system)',
  [...new Set([...walk.matchAll(/from '([^.][^']*)'/g), ...queue.matchAll(/from '([^.][^']*)'/g)].map(m => m[1]))].sort(),
  ['@react-native-async-storage/async-storage', 'expo-camera', 'expo-file-system/legacy', 'expo-keep-awake', 'react', 'react-native', 'react-native-safe-area-context'])

// ── The web migration, when that repo is here ───────────────────────────────
const web = process.env.RINSEBASE_WEB_REPO || join(repo, '..', '..', '..', '..', 'rinsebase-app')
const migDir = join(web, 'supabase/migrations')
const migFile = existsSync(migDir) && readdirSync(migDir).find(f => /_checklist_line_videos\.sql$/.test(f))
if (migFile) {
  const mig = readFileSync(join(migDir, migFile), 'utf8')
  check('the web migration raises missing_required_video, for required lines only', mig.includes("'missing_required_video'") && /and c\.video_mode = 'required'/.test(mig))
  check('…and counts a clip from the same 3 seconds, landed or on its way', (mig.match(/duration_seconds >= 3\b/g) ?? []).length, 2)
  check('…takes video_type \'line\' on both tables', (mig.match(/video_type in \('before', 'after', 'line'\)/g) ?? []).length, 2)
  check('…video_mode off / optional / required, answer_type tick / yes_no / text / number',
    /check \(video_mode in \('off', 'optional', 'required'\)\)/.test(mig) && /check \(answer_type in \('tick', 'yes_no', 'text', 'number'\)\)/.test(mig))
  check('…the answer rule is the app\'s: yes / no, the number pattern, 1 to 2,000 characters',
    mig.includes("char_length(answer) between 1 and 2000") && mig.includes("(answer_type <> 'yes_no' or answer in ('yes', 'no'))")
    && mig.includes(`answer ~ '${A.NUMBER_ANSWER.source}'`) && A.ANSWER_MAX === 2000)
  check('…a required question\'s missing answer is unchecked_required_item', /select 'unchecked_required_item'::text, c\.id, c\.room, c\.task, null::uuid[\s\S]{0,400}and c\.answer_type <> 'tick'\s*and c\.answer is null/.test(mig))
  check('…lets the phone send the record\'s line', mig.includes('grant insert (checklist_item_id) on public.job_videos_on_the_way to authenticated'))
  check('…and refuses a deleted or foreign line with 23503, as this app expects', /using errcode = '23503'/.test(mig))
} else {
  console.log(`–  web half skipped (no *_checklist_line_videos.sql under ${migDir}; set RINSEBASE_WEB_REPO)`)
}

// ── The queue, for real ─────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'line-videos-test-'))
let scenarioFailed = false
try {
  const outbox = read('src/lib/outbox.ts')
    .replace(`from '@react-native-async-storage/async-storage'`, `from './outbox.mocks'`)
    .replace(`import AsyncStorage`, `import { AsyncStorage }`)
    .replace(`from './supabase'`, `from './outbox.mocks'`)
    .replace(`from './errorReporter'`, `from './outbox.mocks'`)
    .replace(`from './photoQueue'`, `from './outbox.mocks'`)
    .replace(`from './netFetch'`, `from './outbox.mocks'`)
  writeFileSync(join(work, 'outbox.ts'), outbox)
  const videoQueue = read('src/lib/videoQueue.ts')
    .replace(`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from './lineVideos.mocks'`)
    .replace(`import * as FileSystem from 'expo-file-system/legacy'`, `import { FileSystem } from './lineVideos.mocks'`)
    .replace(`from './supabase'`, `from './lineVideos.mocks'`)
    .replace(`from './errorReporter'`, `from './lineVideos.mocks'`)
  writeFileSync(join(work, 'videoQueue.ts'), videoQueue)
  for (const f of ['outbox.mocks.ts', 'videosRequired.mocks.ts', 'lineVideos.mocks.ts']) cpSync(join(repo, 'src/lib/__tests__', f), join(work, f))
  cpSync(join(repo, 'src/lib/timezone.ts'), join(work, 'timezone.ts'))
  for (const f of ['lineAnswers.ts', 'lineVideos.ts']) cpSync(join(repo, 'src/lib', f), join(work, f))
  writeFileSync(join(work, 'scenario.ts'), read('src/lib/__tests__/lineVideos.scenario.ts')
    .replace(`from '../videoQueue'`, `from './videoQueue'`)
    .replace(`from '../outbox'`, `from './outbox'`)
    .replace(`from '../lineAnswers'`, `from './lineAnswers'`)
    .replace(`from '../lineVideos'`, `from './lineVideos'`))
  execSync('npx --yes esbuild outbox.ts videoQueue.ts outbox.mocks.ts videosRequired.mocks.ts lineVideos.mocks.ts timezone.ts lineAnswers.ts lineVideos.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  try { execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' }) } catch { scenarioFailed = true }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${pass} checks passed, ${fail} failed`)
if (fail || scenarioFailed) process.exit(1)
