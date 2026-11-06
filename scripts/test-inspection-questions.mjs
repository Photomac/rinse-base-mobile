#!/usr/bin/env node
// The inspection walkthrough's questions and clips (phase 2 of the checklist
// formats Five Star asked for, 2026-11-06; rinse-base-app migration
// 20261106230000_inspection_walkthrough_questions, after phase 1's
// 20261106190000_checklist_line_videos).
//
// Runs the REAL src/lib/walkthrough.ts and inspectionFiling.ts under Node's
// type stripping (Looks good never answers a question; what holds filing),
// compares the filing rule with the web's src/lib/inspectionFiling.ts when
// that worktree is here, then the REAL outbox.ts and videoQueue.ts (scenario:
// src/lib/__tests__/inspectionQuestions.scenario.ts): filing refused and named,
// an offline answer counting at once, a clip on the phone counting from 3
// seconds. And, in the screens: the walkthrough's own read, the answer
// controls, the problem answer for the office only, the recorder, the gate on
// filing.
//
// Usage: node scripts/test-inspection-questions.mjs
//   With the web worktree: RINSEBASE_WEB_PHASE2=/path/to/rinsebase-app-worktree node scripts/test-inspection-questions.mjs
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

// ── The rules ───────────────────────────────────────────────────────────────
const W = await import(join(repo, 'src/lib/walkthrough.ts'))
const F = await import(join(repo, 'src/lib/inspectionFiling.ts'))
const L = await import(join(repo, 'src/lib/lineVideos.ts'))
const line = (id, extra = {}) => ({ id, room: 'Bath', task: id, sort_order: 20000 + Number(id.slice(1)), result: null, issue_note: null, photo_required: false, follow_up: null, info_key: null, ...extra })
check('a question is yes_no / text / number; a check is tick or nothing', ['yes_no', 'text', 'number', 'tick', undefined, null].map(a => W.isQuestionLine({ answer_type: a })), [true, true, true, false, false, false])
check('answered: a check by its result, a question by its answer',
  [W.lineAnswered(line('c1', { result: 'ok' })), W.lineAnswered(line('c2')), W.lineAnswered(line('q1', { answer_type: 'yes_no', answer: 'no' })), W.lineAnswered(line('q2', { answer_type: 'text', result: 'ok' }))],
  [true, false, true, false])
{
  const s = { name: 'Bath', lines: [line('c1'), line('c2', { result: 'issue' }), line('q3', { answer_type: 'yes_no' }), line('q4', { answer_type: 'number', answer: '3' })] }
  const st = W.sectionState(s)
  check('"Looks good" answers open checks only, never a question', st.open, ['c1'])
  check('…the section counts a question\'s answer, and isn\'t done while one is open', [st.answered, st.total, st.done, st.issues], [2, 4, false, 1])
}
check('today\'s walkthrough (no asks): unchanged', W.sectionState({ name: 'B', lines: [line('c1'), line('c2', { result: 'ok' })] }).open, ['c1'])
{
  const r = L.lineAskRows([{ id: 'q1', answer_type: 'yes_no', video_mode: 'off', level: 'required', flag_answer: 'yes', answer: null }, { id: 'q2', answer_type: 'text', flag_answer: 'maybe', level: 7 }])
  check('the walkthrough\'s read brings level and the problem answer (anything else is none)',
    [r.asks.get('q1').level, r.asks.get('q1').flag_answer, r.asks.get('q2').level, r.asks.get('q2').flag_answer], ['required', 'yes', null, null])
}
const FL = [
  { id: 'q1', room: 'Bathroom', task: 'Water spots?', answer_type: 'yes_no', level: 'required', answer: null, video_mode: 'off' },
  { id: 'q2', room: 'Kitchen', task: 'Forks', answer_type: 'number', level: 'required', answer: '   ', video_mode: 'off' },
  { id: 'q3', room: ' ', task: 'Errors found?', answer_type: 'text', level: 'guidance', answer: null, video_mode: 'optional' },
  { id: 'q4', room: 'Bedroom', task: 'Lamps work?', answer_type: 'yes_no', level: 'required', answer: 'no', video_mode: 'off' },
  { id: 'v1', room: 'Kitchen', task: 'Video of errors', answer_type: 'tick', level: 'guidance', answer: null, video_mode: 'required' },
  { id: 'v2', room: 'Outside', task: 'Gate locked', answer_type: 'tick', level: 'guidance', answer: null, video_mode: 'required' },
  { id: 'v3', room: 'Outside', task: 'Hot tub', answer_type: 'tick', level: 'guidance', answer: null, video_mode: 'required' },
  { id: 'c1', room: 'Bathroom', task: 'Mirror', answer_type: null, level: 'required', answer: null, video_mode: null },
]
const CLIPS = [{ checklist_item_id: 'v1', duration_seconds: 2 }, { checklist_item_id: 'v2', duration_seconds: 3 }]
const WAY = [{ checklist_item_id: 'v3', duration_seconds: 8 }, { checklist_item_id: 'v1', duration_seconds: 1 }]
const statesFrom = (clips, way) => L.lineAskRows(FL.map(l => ({ id: l.id, job_videos: clips.filter(c => c.checklist_item_id === l.id), job_videos_on_the_way: way.filter(c => c.checklist_item_id === l.id) }))).server
const mine = F.filingGaps(FL, statesFrom(CLIPS, WAY))
check('filing waits for must-answer questions with no (or a blank) answer, and required clips under 3 s or none',
  mine, { questions: ['Bathroom · Water spots?', 'Kitchen · Forks'], clips: ['Kitchen · Video of errors'] })
check('…a clip still on this phone counts (lib/lineVideos lineClipStates)',
  F.filingGaps(FL, L.lineClipStates(statesFrom(CLIPS, WAY), [{ checklist_item_id: 'v1', video_type: 'line', duration_seconds: 4 }])).clips, [])
check('…a check line, an optional question or clip, an answered question: never', [F.hasFilingGaps({ questions: [], clips: [] }), F.hasFilingGaps(null)], [false, false])

const web = process.env.RINSEBASE_WEB_PHASE2 || '/Users/toddschaffer/app/rinsebase-app/.claude/worktrees/agent-a9733b9fd1bac860f'
const webLib = join(web, 'src/lib/inspectionFiling.ts')
if (existsSync(webLib)) {
  let webGaps = null
  try {
    const WF = await import(webLib)
    webGaps = WF.filingGapsFrom(FL, CLIPS, WAY)
  } catch (e) {
    console.log(`–  web inspectionFiling.ts didn't load under Node (${String(e?.message || e).slice(0, 120)}); comparing its rule by text`)
  }
  if (webGaps) check('the same answer as the web\'s filingGapsFrom on the same visit', mine, webGaps)
  const src = readFileSync(webLib, 'utf8')
  check('…its rule by text: (answer_type ?? tick) !== tick, level required, blank answer; video_mode required',
    src.includes("(l.answer_type ?? 'tick') !== 'tick' && l.level === 'required' && (l.answer ?? '').trim() === ''") && src.includes("l.video_mode === 'required' && !counted.has(l.id)"))
  const migDir = join(web, 'supabase/migrations')
  const mig = existsSync(migDir) && readdirSync(migDir).find(f => /_inspection_walkthrough_questions\.sql$/.test(f))
  if (mig) {
    const m = readFileSync(join(migDir, mig), 'utf8')
    check('the phase 2 migration gives walkthrough lines answer_type, video_mode, flag_answer and level',
      /RETURNS TABLE\(room text, task text, sort_order integer, follow_up text, info_key text, photo_required boolean, answer_type text, video_mode text, flag_answer text, level text\)/.test(m))
    check('…and says the database doesn\'t gate filing (the apps do)', /Filing an inspection \(job_inspections\.completed_at\) is NOT gated by the\s*--\s*database/.test(m))
  }
} else {
  console.log(`–  web half skipped (no ${webLib}; set RINSEBASE_WEB_PHASE2)`)
}

// ── The screens ─────────────────────────────────────────────────────────────
const reads = read('src/lib/jobReads.ts')
const card = read('src/lib/walkthroughCard.ts')
const comp = read('src/components/WalkthroughChecklist.tsx')
const insp = read('src/screens/JobInspectionScreen.tsx')
check('what each walkthrough line asks is its own read, walkthrough lines only',
  /walkthroughAsksRead = \(jobId: string\): CacheRead => \(\{\s*key: `wtasks:\$\{jobId\}`,\s*q: \(\) => supabase\.from\('job_checklist_items'\)\s*\.select\('id, answer_type, video_mode, flag_answer, level, answer, job_videos\(id, duration_seconds\), job_videos_on_the_way\(id, duration_seconds\)'\)\s*\.eq\('job_id', jobId\)\.gte\('sort_order', WALKTHROUGH_BAND\)\.or\('video_mode\.neq\.off,answer_type\.neq\.tick'\),/.test(reads))
check('…the lines\' own read is untouched', /walkthroughLinesRead[\s\S]{0,200}\.select\('id, room, task, sort_order, result, issue_note, photo_required, follow_up, info_key'\)/.test(reads))
check('…the day pack saves it with the walkthrough, and the prune knows it', /walkthroughLinesRead\(job\.id\), walkthroughPhotosRead\(job\.id\), walkthroughAsksRead\(job\.id\),/.test(reads) && /'wtcarry', 'wtasks',/.test(reads))
check('the card reads it with the others, answers queued offline laid over it, merged into the lines; a failed read: every line a check',
  /readSoon\(walkthroughAsksRead\(job\.id\), wait\),\s*\]\)/.test(card) && /const asked = lineAskRows\(await overlayPending\('job_checklist_items', list\(asks\?\.data\), \(\) => false\)\)/.test(card)
  && /return a \? \{ \.\.\.r, answer_type: a\.answer_type, answer: a\.answer, level: a\.level, video_mode: a\.video_mode, flag_answer: a\.flag_answer \} : r/.test(card))
check('"Looks good" still marks only sectionState\'s open lines (checks)', /const ids = looksGoodIds\(sectionState\(s\)\.open, carriedIds\)/.test(comp))
check('a question shows Yes / No, a text box or a number box in place of Looks good / Not right',
  /if \(questionType\(\{ answer_type: l\.answer_type, item_kind: 'task' \}\)\) \{[\s\S]{0,2400}\{questionControls\(l\)\}/.test(comp)
  && /keyboardType=\{type === 'number' \? 'decimal-pad' : 'default'\}/.test(comp) && /onPress=\{\(\) => saveAnswer\(l, on \? null : v\)\}/.test(comp))
check('…saved through the outbox like any answer, completed by me; cleared puts it all back', /values: answerWrite\(value, user\.id, new Date\(\)\.toISOString\(\)\),/.test(comp))
check('…what the server would refuse is refused on the phone', /const n = normaliseAnswer\(type, raw\)\s*if \(!n\.ok\) \{\s*Alert\.alert/.test(comp))
check('…locked once filed (readOnly): the answer is shown, not editable', /\{readOnly\s*\? <Text[^\n]*wt_answered[^\n]*\n\s*: <View style=\{\{ marginTop: 6 \}\}>\{questionControls\(l\)\}<\/View>\}/.test(comp) && /async function saveAnswer\(line: WalkthroughLine, value: string \| null\) \{\s*if \(readOnly\) return/.test(comp))
check('the problem answer only for owner / admin / manager / dispatcher', /const office = isOfficeRole\(user\?\.role\)/.test(comp)
  && (comp.match(/office && l\.answer_type === 'yes_no'/g) ?? []).length === 1 && /office && l\.flag_answer === v \? RED/.test(comp))
check('🎥 on checks and questions, optional or required, through the line recorder (a modal over the card)',
  (comp.match(/\{takesVideo\(l\) && clipChip\(l\)\}/g) ?? []).length === 2 && /<WalkthroughScreen job=\{job\} user=\{user\} defaultType="after" asked\s*line=\{\{ id: recordFor\.id,/.test(comp))
check('…an optional clip says nothing until recorded', /if \(!st && l\.video_mode !== 'required'\) return null/.test(comp))
check('the inspection screen refuses to file while something must be answered or recorded, and names it, before anything is written',
  /async function file\(\) \{[\s\S]{0,700}const gaps = walkState\.current \? filingGaps\(walkState\.current\.lines, walkState\.current\.clips\) : null\s*if \(gaps && hasFilingGaps\(gaps\)\) \{[\s\S]{0,400}return\s*\}\s*const problem = validate\(\)/.test(insp)
  && /onState=\{s => \{ walkState\.current = s \}\}/.test(insp))
const strings = read('src/lib/i18n.ts')
const keys = ['wt_problem_answer', 'wt_answered', 'wt_unanswered', 'wt_file_blocked_title', 'wt_file_blocked_msg', 'line_video_needed_line']
check('every new string in all three languages', keys.filter(k => (strings.match(new RegExp(`\\n    ${k}: `, 'g')) ?? []).length !== 3), [])

// ── The outbox and the queue, for real ──────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'inspection-questions-test-'))
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
  for (const f of ['timezone.ts', 'lineAnswers.ts', 'lineVideos.ts', 'walkthrough.ts', 'inspectionFiling.ts']) cpSync(join(repo, 'src/lib', f), join(work, f))
  writeFileSync(join(work, 'scenario.ts'), read('src/lib/__tests__/inspectionQuestions.scenario.ts').replace(/from '\.\.\/(\w+)'/g, `from './$1'`))
  execSync('npx --yes esbuild outbox.ts videoQueue.ts outbox.mocks.ts videosRequired.mocks.ts lineVideos.mocks.ts timezone.ts lineAnswers.ts lineVideos.ts walkthrough.ts inspectionFiling.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  try { execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' }) } catch { scenarioFailed = true }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${pass} checks passed, ${fail} failed`)
if (fail || scenarioFailed) process.exit(1)
