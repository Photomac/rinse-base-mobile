#!/usr/bin/env node
// A company can require the crew's walkthrough videos before a clean can be
// completed (CKS Perfections, 2026-10-29; rinse-base-app migration
// 20261030180000_walkthrough_videos_required).
//
// Runs the REAL src/lib/videosOwed.ts under Node's type stripping, then the
// REAL videoQueue.ts beside the REAL outbox.ts (scenario:
// src/lib/__tests__/videosRequired.scenario.ts): the record goes ahead of the file
// and ahead of a Complete queued with no signal. And, in the screens: Complete
// names the videos and opens the recorder on the missing one, a clip on this phone
// isn't asked for again, Start asks for the arrival video without holding Start,
// the day pack saves what's owed.
//
// Usage: node scripts/test-videos-required.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
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

const V = await import(join(repo, 'src/lib/videosOwed.ts'))
check('the gate\'s codes, arrival first', V.videosInBlockers([{ code: 'no_finished_video' }, { code: 'no_after_photo' }, { code: 'no_arrival_video' }]), ['before', 'after'])
check('…no video among them', V.videosInBlockers([{ code: 'no_after_photo' }]), [])
check('…no answer', V.videosInBlockers(null), [])
check('a refusal names them', V.videosInRefusal('RB_BLOCKED: [{"code": "no_arrival_video", "room": null}]'), ['before'])
check('…a refusal for something else', V.videosInRefusal('RB_BLOCKED: [{"code": "no_after_photo"}]'), [])
check('…another error', V.videosInRefusal('new row violates row-level security'), [])
check('…broken JSON', V.videosInRefusal('RB_BLOCKED: [{"code":'), [])
check('…nothing', V.videosInRefusal(null), [])
check('the server\'s rows', V.videosFromOwedRows([{ video_type: 'after' }, { video_type: 'before' }]), ['before', 'after'])
check('…no answer owes nothing here (the server still decides)', V.videosFromOwedRows(null), [])
const clip = (video_type, duration_seconds) => ({ video_type, duration_seconds })
check('a clip on this phone answers its type', V.videosStillOwed(['before', 'after'], [clip('before', 40)]), ['after'])
check('…10 seconds counts', V.videosStillOwed(['after'], [clip('after', 10)]), [])
check('arrival: landed counts', V.arrivalOnClean([[clip('before', 40)], [], []]), true)
check('arrival: announced from a teammate\'s phone counts', V.arrivalOnClean([[], [clip('before', 40)], []]), true)
check('arrival: still on this phone counts', V.arrivalOnClean([[], [], [clip('before', 10)]]), true)
check('arrival: a stray tap under 10 seconds doesn\'t', V.arrivalOnClean([[clip('before', 9)], [], []]), false)
check('arrival: a finished video isn\'t one', V.arrivalOnClean([[clip('after', 40)], [], []]), false)
check('arrival: none anywhere', V.arrivalOnClean([[], [], []]), false)
check('arrival: a failed read with none found is unknown', [V.arrivalOnClean([null, [], []]), V.arrivalOnClean([[], null, []])], [null, null])
check('arrival: a failed read still hears the list that has it', V.arrivalOnClean([null, [], [clip('before', 40)]]), true)
check('arrival: no duration doesn\'t count', V.arrivalOnClean([[{ video_type: 'before', duration_seconds: null }], [], []]), false)
check('…9 doesn\'t', V.videosStillOwed(['after'], [clip('after', 9)]), ['after'])
check('…the other type doesn\'t', V.videosStillOwed(['after'], [clip('before', 40)]), ['after'])

const detail = read('src/screens/JobDetailScreen.tsx')
const walk = read('src/screens/WalkthroughScreen.tsx')
const reads = read('src/lib/jobReads.ts')
check('Complete tells the server about clips before it asks the gate', /Promise\.all\(\[flushQueue\(\), flushOutbox\(\), announceVideos\(\)\]\)[\s\S]{0,1200}rpc\('job_completion_blockers'/.test(detail))
check('Complete reads the gate\'s videos, and with no answer what\'s owed', /const videosLeft = !gateErr \? videosInBlockers\(blockers\)/.test(detail))
const videosAt = detail.indexOf('const videosLeft = ')
check('…before the photo alerts, and after the hold is decided',
  videosAt > detail.indexOf("askToHold(false, new Date().toISOString())") && videosAt < detail.indexOf("blockers.some((b: any) => b.code === 'no_after_photo')"))
check('…a clip on this phone isn\'t asked for again', /videosStillOwed\(videosLeft, await queuedJobVideos\(job\.id\)/.test(detail))
check('…no signal goes on to queue (behind the record)', /if \(!gateErr\) \{\s*Alert\.alert\(`🎥 \$\{t\('walkthrough_sending_title'\)\}`/.test(detail))
check('…the alert opens the recorder on the missing video', /onPress: \(\) => openWalkthrough\(types\[0\]\)/.test(detail))
check('…the recorder starts there', /defaultType=\{walkthroughFor \?\? defaultType\}/.test(detail))
check('a refused Complete names the video instead of the raw error', /const refusedVideos = videosInRefusal\(doneErr\.message\)[\s\S]{0,120}alertVideosNeeded\(refusedVideos\)/.test(detail))
check('Start asks for the arrival video, once, for whoever is working it', /arrivalAsked\.current \|\| recordsForOthers \|\| !videosOwed\.includes\('before'\)/.test(detail))
check('…after Start has gone through (both starts announce)', (detail.match(/announceRequiredPhotos\(\)\n  \}/g) ?? []).length, 2)
check('…and never instead of the required-photos notice', /\[\{ text: t\('ok'\), onPress: \(\) => \{ askArrivalVideo\(\) \} \}\]/.test(detail))
check('only companies with videos on ask the server', /if \(videoEnabled && !isTask\) loadVideosOwed\(\)/.test(detail))
check('back from the recorder, it asks again', /setShowWalkthrough\(false\); if \(videoEnabled && !isTask\) loadVideosOwed\(\)/.test(detail))
check('the chip counts what\'s owed', /t\('walkthrough_chip'\)\}\{videosOwed\.length > 0/.test(detail))
check('the recorder warns when a clip is too short to count', /owed\.includes\(videoType\) && recorded\.duration < WALKTHROUGH_MIN_SECONDS/.test(walk))
check('the day pack saves what\'s owed, only for a company with videos on', /then: row => \(!isTask && row\?\.video_walkthroughs_enabled === true \? \[videosOwedRead\(job\.id\)\] : \[\]\)/.test(reads))
check('…and the prune knows whose it is', /'crewNoteAck', 'videosowed'\]/.test(reads))
const web = process.env.RINSEBASE_WEB_REPO
if (web) {
  const mig = readFileSync(join(web, 'supabase/migrations/20261030133710_walkthrough_videos_required.sql'), 'utf8')
  check('the web migration raises these codes', mig.includes("'no_arrival_video'") && mig.includes("'no_finished_video'"))
  check('…and counts from the same 10 seconds', (mig.match(/duration_seconds >= 10/g) ?? []).length, 2)
}

const work = mkdtempSync(join(tmpdir(), 'videos-required-test-'))
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
  const queue = read('src/lib/videoQueue.ts')
    .replace(`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from './videosRequired.mocks'`)
    .replace(`import * as FileSystem from 'expo-file-system/legacy'`, `import { FileSystem } from './videosRequired.mocks'`)
    .replace(`from './supabase'`, `from './videosRequired.mocks'`)
    .replace(`from './errorReporter'`, `from './videosRequired.mocks'`)
  writeFileSync(join(work, 'videoQueue.ts'), queue)
  cpSync(join(repo, 'src/lib/__tests__/outbox.mocks.ts'), join(work, 'outbox.mocks.ts'))
  cpSync(join(repo, 'src/lib/__tests__/videosRequired.mocks.ts'), join(work, 'videosRequired.mocks.ts'))
  cpSync(join(repo, 'src/lib/timezone.ts'), join(work, 'timezone.ts'))
  writeFileSync(join(work, 'scenario.ts'), read('src/lib/__tests__/videosRequired.scenario.ts')
    .replace(`from '../outbox'`, `from './outbox'`)
    .replace(`from '../videoQueue'`, `from './videoQueue'`))
  execSync('npx --yes esbuild outbox.ts videoQueue.ts outbox.mocks.ts videosRequired.mocks.ts timezone.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  try { execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' }) } catch { scenarioFailed = true }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${pass} checks passed, ${fail} failed`)
if (fail || scenarioFailed) process.exit(1)
