#!/usr/bin/env node
// Videos on incident reports (CKS Perfections 2026-11-12; rinse-base-app
// migration 20261112180000_incident_report_videos).
//
// Checks, in the screens: the report form records a video in the app (muted,
// 720p, the walkthrough bitrate, H.264 on iPhone, at most a minute), keeps it
// on the phone until Save, then queues it with the report as video_type
// 'report'; the heads-up (which at a company that sends reports automatically
// is what sends the report to the client) waits for the report's videos as it
// waits for its photos, and names the report; the app's drain lets it go once
// the videos are up. Then the REAL videoQueue.ts beside the REAL outbox.ts
// (scenario: src/lib/__tests__/reportVideos.scenario.ts).
//
// Usage: node scripts/test-report-videos.mjs
//   With the web repo: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-report-videos.mjs
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

// ── The screens ─────────────────────────────────────────────────────────────
const card = read('src/components/IncidentReportCard.tsx')
const rec = read('src/components/ReportClipRecorder.tsx')
const notify = read('src/lib/incidentNotify.ts')
const queue = read('src/lib/videoQueue.ts')
const app = read('App.tsx')
const save = card.slice(card.indexOf('  async function save() {'), card.indexOf('  if (!open) {'))
check('the form records in the app (never the camera roll) and lists the clips, each with a ✕ that deletes its file',
  [/<ReportClipRecorder visible=\{recOpen\}/.test(card), /setRecOpen\(true\)/.test(card), /function dropClip\(uri: string\) \{\s*FileSystem\.deleteAsync\(uri/.test(card),
   /ImagePicker\.launch[A-Za-z]*\(\{[^}]*videos/.test(card)],
  [true, true, true, false])
check('Save queues each clip as a report clip with the report\'s id, after the report is written and before its heads-up is queued',
  [/video_type: 'report',[\s\S]{0,160}incident_report_id: reportId/.test(save),
   save.indexOf("writeThrough({ table: 'job_damage_reports'") < save.indexOf('enqueueVideo('),
   save.indexOf('enqueueVideo(') < save.indexOf('queueIncidentNotify(')], [true, true, true])
check('Cancel deletes the clips\' files; a saved form starts with none',
  [/clips\.forEach\(c => \{ FileSystem\.deleteAsync\(c\.uri/.test(card), /setClips\(\[\]\); setRecOpen\(false\)/.test(card)], [true, true])
check('the recorder: muted, 720p, the walkthrough bitrate, H.264 on iPhone, at most a minute, keep-awake, never the photo library',
  [/\bmute\b/.test(rec), /videoQuality="720p"/.test(rec), /videoBitrate=\{WALKTHROUGH_BITRATE\}/.test(rec), /codec: 'avc1'/.test(rec),
   /maxDuration: REPORT_CLIP_MAX_SECONDS/.test(rec), /activateKeepAwakeAsync\(KEEP_AWAKE_TAG\)/.test(rec), /ImagePicker|MediaLibrary/.test(rec)],
  [true, true, true, true, true, true, false])
check('a report clip runs at most a minute', /export const REPORT_CLIP_MAX_SECONDS = 60/.test(queue), true)
check('the heads-up waits for the report\'s videos as for its photos, and names its report',
  [notify.indexOf('pendingIncidentPhotos(n.report_id)') < notify.indexOf('pendingReportVideos(n.report_id)'),
   /if \(await pendingReportVideos\(n\.report_id\) > 0\) \{ keep\.push\(n\); continue \}/.test(notify), /report_id: n\.report_id,/.test(notify)],
  [true, true, true])
check('the app\'s drain sends a waiting heads-up once the videos are up', /flushVideoQueue\(\)\.catch\(\(\) => \{\}\)\.then\(\(\) => flushIncidentNotifies\(\)\)/.test(app), true)
check('the queue never announces a report clip, lists it as a walkthrough, or writes it to job_videos',
  [/v\.video_type !== 'report'\)/.test(queue.slice(queue.indexOf('async function announceOnce'), queue.indexOf('function lineOf'))),
   /\.filter\(v => v\.job_id === jobId && v\.video_type !== 'report'\)/.test(queue),
   /if \(entry\.video_type === 'report'\) \{[\s\S]*?from\('incident_report_videos'\)\.insert\([\s\S]*?return \{ ok: true \}\s*\}/.test(queue)],
  [true, true, true])

// ── The web half, when that repo is on this machine ─────────────────────────
const web = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
const migDir = join(web, 'supabase/migrations')
const mig = existsSync(migDir) ? readdirSync(migDir).find(f => f.endsWith('_incident_report_videos.sql')) : null
if (mig) {
  const m = readFileSync(join(migDir, mig), 'utf8')
  const cols = ['id', 'tenant_id', 'report_id', 'job_id', 'user_id', 'storage_path', 'video_url', 'mime_type', 'duration_seconds', 'size_bytes', 'recorded_at']
  check('every column the phone writes is on the web table', cols.filter(c => !new RegExp(`\\n  ${c} `).test(m)), [])
  check('…its file is the phone\'s path under <company>/<clean>/ in job-videos', /starts_with\(storage_path, tenant_id::text \|\| '\/' \|\| job_id::text \|\| '\/'\)/.test(m) && /job-videos\/' \|\| storage_path/.test(m), true)
  check('…a report not there yet is 23503 (the clip waits), as the queue expects', /using errcode = '23503'/.test(m) && /references public\.job_damage_reports \(id, tenant_id\)/.test(m), true)
} else {
  console.log(`–  web half skipped (no *_incident_report_videos.sql under ${migDir}; set RINSEBASE_WEB_REPO)`)
}

// ── The queue, for real ─────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'report-videos-test-'))
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
    .replace(`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from './reportVideos.mocks'`)
    .replace(`import * as FileSystem from 'expo-file-system/legacy'`, `import { FileSystem } from './reportVideos.mocks'`)
    .replace(`from './supabase'`, `from './reportVideos.mocks'`)
    .replace(`from './errorReporter'`, `from './reportVideos.mocks'`)
  writeFileSync(join(work, 'videoQueue.ts'), videoQueue)
  for (const f of ['outbox.mocks.ts', 'videosRequired.mocks.ts', 'reportVideos.mocks.ts']) cpSync(join(repo, 'src/lib/__tests__', f), join(work, f))
  cpSync(join(repo, 'src/lib/timezone.ts'), join(work, 'timezone.ts'))
  writeFileSync(join(work, 'scenario.ts'), read('src/lib/__tests__/reportVideos.scenario.ts')
    .replace(`from '../videoQueue'`, `from './videoQueue'`))
  execSync('npx --yes esbuild outbox.ts videoQueue.ts outbox.mocks.ts videosRequired.mocks.ts reportVideos.mocks.ts timezone.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  try { execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' }) } catch { scenarioFailed = true }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${pass} checks passed, ${fail} failed`)
if (fail || scenarioFailed) process.exit(1)
