#!/usr/bin/env node
// A checklist line can ask for a video clip, as it can ask for a photo (Five
// Star Hospitality, 2026-11-06; rinse-base-app migration
// 20261106190000_checklist_line_videos).
//
// Runs the REAL src/lib/lineVideos.ts under Node's type stripping, then the
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
  { id: 'A', job_videos: [{ id: 'v1', duration_seconds: 20 }], job_videos_on_the_way: [] },
  { id: 'B', job_videos: [], job_videos_on_the_way: [{ id: 'w1', duration_seconds: 5 }] },
  { id: 'C', job_videos: [{ id: 'v2', duration_seconds: 2 }], job_videos_on_the_way: [{ id: 'w2', duration_seconds: 1 }] },
  { id: 'D', job_videos: [{ id: 'v3', duration_seconds: null }] },
]
{
  const r = L.lineVideoRows(rowsRead)
  check('the read: every line that asks for a clip', [...r.lines].sort(), ['A', 'B', 'C', 'D'])
  check('…landed is uploaded, announced is sending, too short or no length is nothing', r.server, { A: 'uploaded', B: 'sending' })
}
check('a failed read (or a server before the migration) is no video lines', [L.lineVideoRows(null).lines.size, L.lineVideoRows({ message: 'column does not exist' }).lines.size], [0, 0])
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
check('with no answer: the video lines with no clip anywhere this phone knows of',
  L.videoLinesMissing([{ jobItemId: 'A', requires_video: true }, { jobItemId: 'B', requires_video: true }, { jobItemId: 'C', requires_video: false }, { requires_video: true }], { A: 'sending' }).map(i => i.jobItemId),
  ['B'])

// ── The screens ─────────────────────────────────────────────────────────────
const detail = read('src/screens/JobDetailScreen.tsx')
const walk = read('src/screens/WalkthroughScreen.tsx')
const reads = read('src/lib/jobReads.ts')
const card = read('src/lib/checklistCard.ts')
const queue = read('src/lib/videoQueue.ts')
check('the lines that ask for a clip are their own read: id plus landed and announced clips, video lines only',
  /lineVideosRead = \(jobId: string\): CacheRead => \(\{\s*key: `linevids:\$\{jobId\}`,\s*q: \(\) => supabase\.from\('job_checklist_items'\)\s*\.select\('id, job_videos\(id, duration_seconds\), job_videos_on_the_way\(id, duration_seconds\)'\)\s*\.eq\('job_id', jobId\)\.eq\('video_required', true\),/.test(reads))
check('…so the line read the card has always made is untouched (no video_required in it)',
  /checklistRowsRead[\s\S]{0,200}\.select\('id, room, task, sort_order, completed, photo_required, room_id, item_kind, level, result, issue_note'\)/.test(reads))
check('the card reads it with the others, and a failed read is no video lines',
  /readSoon\(lineVideosRead\(job\.id\), wait\)/.test(card) && /lineVids: r\[9\]\.data/.test(card) && /const videos = lineVideoRows\(p\.lineVids\)/.test(card) && /requires_video: videos\.lines\.has\(r\.id\)/.test(card))
check('the day pack saves it for cleans (the record button and Complete with no signal)', /\.\.\.\(!isTask \? \[lineVideosRead\(job\.id\)\] : \[\]\)/.test(reads))
check('a video line can\'t be ticked before its clip', /if \(newVal && item\.requires_video && !lineClips\[item\.jobItemId\]\) \{\s*Alert\.alert\(`🎥 \$\{t\('line_video_required_title'\)\}`, t\('line_video_before_check_msg'\), \[\s*\{ text: t\('line_video_record'\), onPress: \(\) => openLineRecorder\(item\) \}/.test(detail))
check('…before the photo check, so a line asking for both asks for the clip first',
  detail.indexOf('if (newVal && item.requires_video && !lineClips[item.jobItemId])') < detail.indexOf('if (newVal && item.requires_photo && !itemPhotos[item.id])'))
check('the record button on task, Yes / Not right and room-complete lines', (detail.match(/\{item\.requires_video && lineVideoButton\(item\)\}/g) ?? []).length, 3)
check('…and the note under each', (detail.match(/\{item\.requires_video && lineVideoNote\(item\)\}/g) ?? []).length, 3)
check('a saved clip ticks a task line (not a Yes / Not right one), from 3 seconds',
  /if \(seconds < LINE_CLIP_MIN_SECONDS \|\| item\.item_kind === 'verify' \|\| checked\[item\.id\]\) return\s*setChecked\(prev => \(\{ \.\.\.prev, \[item\.id\]: true \}\)\)\s*saveCheckItem\(item, true\)/.test(detail))
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
  'line_video_uploaded', 'line_video_record', 'line_video_required_title', 'line_video_before_check_msg', 'line_videos_missing_msg']
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
  check('the web migration raises missing_required_video', mig.includes("'missing_required_video'"))
  check('…and counts a clip from the same 3 seconds, landed or on its way', (mig.match(/duration_seconds >= 3\b/g) ?? []).length, 2)
  check('…takes video_type \'line\' on both tables', (mig.match(/video_type in \('before', 'after', 'line'\)/g) ?? []).length, 2)
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
  writeFileSync(join(work, 'scenario.ts'), read('src/lib/__tests__/lineVideos.scenario.ts')
    .replace(`from '../videoQueue'`, `from './videoQueue'`))
  execSync('npx --yes esbuild outbox.ts videoQueue.ts outbox.mocks.ts videosRequired.mocks.ts lineVideos.mocks.ts timezone.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  try { execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' }) } catch { scenarioFailed = true }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${pass} checks passed, ${fail} failed`)
if (fail || scenarioFailed) process.exit(1)
