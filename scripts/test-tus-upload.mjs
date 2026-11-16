#!/usr/bin/env node
// Runs the resumable clip upload scenarios (CKS 2026-11-16):
//   1. src/lib/__tests__/tusUpload.scenario.ts: the REAL src/lib/tusUpload.ts
//      against a fake Supabase TUS server on a virtual clock (pieces, resume,
//      lost answers, report no-overwrite, giving way to clock-out/Complete).
//   2. src/lib/__tests__/tusQueue.scenario.ts: the REAL videoQueue.ts and
//      outbox.ts with a big clip, end to end: announced, sent in pieces, the
//      signal drops, it resumes where the server left off, its row lands, and
//      it is only reported as stuck when it stops getting anywhere.
//
// No package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-tus-upload.mjs [scenario ...]   (scenarios of part 1)
import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
const work = mkdtempSync(join(tmpdir(), 'tus-upload-test-'))

const SCENARIOS = [
  'fresh', 'metadata', 'dropAndResume', 'lostFinalAnswer', 'oldAddress', 'goneAddress', 'reportNoOverwrite',
  'refusedAndUnsupported', 'stall', 'suspendedIsNotAStall', 'giveWayBeforePiece', 'stuckOutboxDoesntFreeze',
  'giveWayMidPiece', 'giveWayIsCapped', 'photosDontCancelSosDoes', 'conflicts',
  'finishedButAnswerLost', 'stalledButAllThere', 'uploaderTrouble',
]

let failed = 0
try {
  // ── 1. The upload on its own ──
  const core = join(work, 'core.js')
  execSync(`npx --yes esbuild ${JSON.stringify(join(repo, 'src/lib/__tests__/tusUpload.scenario.ts'))} --bundle --platform=node --format=cjs --log-level=error --outfile=${JSON.stringify(core)}`, {
    cwd: repo, stdio: ['ignore', 'ignore', 'inherit'],
  })
  const only = process.argv.slice(2)
  for (const name of only.length ? only : SCENARIOS) {
    const r = spawnSync(process.execPath, [core, name], { stdio: 'inherit', timeout: 60_000 })
    if (r.status !== 0) failed++
  }

  // ── 2. Through the queue ──
  if (!only.length) {
    const q = join(work, 'queue')
    const outbox = read('src/lib/outbox.ts')
      .replace(`from '@react-native-async-storage/async-storage'`, `from './outbox.mocks'`)
      .replace(`import AsyncStorage`, `import { AsyncStorage }`)
      .replace(`from './supabase'`, `from './outbox.mocks'`)
      .replace(`from './errorReporter'`, `from './outbox.mocks'`)
      .replace(`from './photoQueue'`, `from './outbox.mocks'`)
      .replace(`from './netFetch'`, `from './outbox.mocks'`)
    const queue = read('src/lib/videoQueue.ts')
      .replace(`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from './tusQueue.mocks'`)
      .replace(`import * as FileSystem from 'expo-file-system/legacy'`, `import { FileSystem } from './tusQueue.mocks'`)
      .replace(`from './supabase'`, `from './tusQueue.mocks'`)
      .replace(`from './errorReporter'`, `from './tusQueue.mocks'`)
      .replace(`from './videoBusy'`, `from './tusQueue.mocks'`)
    execSync(`mkdir -p ${JSON.stringify(q)}`)
    writeFileSync(join(q, 'outbox.ts'), outbox)
    writeFileSync(join(q, 'videoQueue.ts'), queue)
    for (const f of ['outbox.mocks.ts', 'videosRequired.mocks.ts', 'tusQueue.mocks.ts']) cpSync(join(repo, 'src/lib/__tests__', f), join(q, f))
    cpSync(join(repo, 'src/lib/timezone.ts'), join(q, 'timezone.ts'))
    cpSync(join(repo, 'src/lib/tusUpload.ts'), join(q, 'tusUpload.ts'))
    writeFileSync(join(q, 'scenario.ts'), read('src/lib/__tests__/tusQueue.scenario.ts').replace(`from '../videoQueue'`, `from './videoQueue'`))
    execSync('npx --yes esbuild outbox.ts videoQueue.ts outbox.mocks.ts videosRequired.mocks.ts tusQueue.mocks.ts timezone.ts tusUpload.ts scenario.ts --format=cjs --platform=node --log-level=error --outdir=out', {
      cwd: q, stdio: ['ignore', 'ignore', 'inherit'],
    })
    const r = spawnSync(process.execPath, ['out/scenario.js'], { cwd: q, stdio: 'inherit', timeout: 120_000 })
    if (r.status !== 0) failed++
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
if (failed) { console.log(`\n${failed} scenario group(s) failed`); process.exit(1) }
console.log('\nall resumable upload scenarios passed')
