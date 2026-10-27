#!/usr/bin/env node
// Runs the camera-recovery scenario (src/lib/__tests__/cameraRecovery.scenario.ts)
// against the REAL src/lib/cameraRecovery.ts and src/lib/roomShots.ts, with
// their imports (AsyncStorage, react-native, expo-image-picker, photoQueue)
// rewritten to cameraRecovery.mocks.ts. Each file is built on its own (no
// bundle), so the scenario can re-require cameraRecovery for an app start
// while the mocks (the phone's storage and camera) carry over.
//
// Then it builds mutants of the shipped code and requires the scenario to FAIL
// on each one: a green run proves only as much as a broken build would fail.
//
// Usage: node scripts/test-camera-recovery.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(repo, p), 'utf8')

// Every rewrite must match, or the test would run against something other
// than the shipped code.
function rewrite(text, pairs, file) {
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`test-camera-recovery: ${file} no longer contains: ${from}`)
    text = text.split(from).join(to)
  }
  return text
}

const MOCKS = './cameraRecovery.mocks'
const sources = {
  'cameraRecovery.ts': rewrite(read('src/lib/cameraRecovery.ts'), [
    [`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from '${MOCKS}'`],
    [`import { Platform } from 'react-native'`, `import { Platform } from '${MOCKS}'`],
    [`import * as ImagePicker from 'expo-image-picker'`, `import { ImagePicker } from '${MOCKS}'`],
    [`from './photoQueue'`, `from '${MOCKS}'`],
  ], 'cameraRecovery.ts'),
  'roomShots.ts': rewrite(read('src/lib/roomShots.ts'), [
    [`from './photoQueue'`, `from '${MOCKS}'`],
  ], 'roomShots.ts'),
}

// Each must make at least one assertion fail.
const MUTANTS = [
  ['another person\'s photo is queued under them', 'cameraRecovery.ts',
    ` || note.photo.user_id !== userId`, ``],
  ['the note is never written', 'cameraRecovery.ts',
    `try { await AsyncStorage.setItem(KEY, JSON.stringify(note)); return true }`, `try { return true }`],
  ['a late answer is queued a second time', 'cameraRecovery.ts',
    `  if (!mine && !result.canceled) return { canceled: true, assets: null }\n`, ``],
  ['a return check forgets the note while the camera is open', 'cameraRecovery.ts',
    `if (note && (atStart || !fresh)) await forgetNote()`, `if (note) await forgetNote()`],
  ['iPhones write a note too', 'cameraRecovery.ts',
    `  if (Platform.OS !== 'android') return ImagePicker.launchCameraAsync(options)\n`, ``],
  ['a note past its age is honoured', 'cameraRecovery.ts',
    `if (!note || !fresh || note.photo.user_id`, `if (!note || note.photo.user_id`],
  ['the camera\'s error leaves its note behind', 'cameraRecovery.ts',
    `    if (written) await takeBack(note.id)\n    throw e`, `    throw e`],
  ['an unreadable note drops the photo', 'cameraRecovery.ts',
    `if (note === undefined) return true`, `if (note === undefined) return false`],
  ['a start keeps the last camera\'s note', 'cameraRecovery.ts',
    `const atStart = !checkedThisLaunch`, `const atStart = false`],
  ['a recovered photo waits for the next drain to upload', 'cameraRecovery.ts',
    `    void flushQueue().catch(() => {})\n    return { jobId`, `    return { jobId`],
  ['a recovered photo forgets what it was for', 'cameraRecovery.ts',
    `await enqueuePhoto({ ...note.photo, uri: asset.uri, taken_at: Date.now() })`, `await enqueuePhoto({ ...note.photo, photo_requirement_id: null, uri: asset.uri, taken_at: Date.now() })`],
  // Each shot's mark (roomShots).
  ['waiting for signal reads as uploading', 'roomShots.ts',
    `q.refused ? 'failed' : q.waiting ? 'waiting' : 'uploading'`, `q.refused ? 'failed' : 'uploading'`],
  ['refused reads as uploading', 'roomShots.ts',
    `q.refused ? 'failed' : q.waiting`, `q.waiting`],
  ['a shot reads saved before anything landed', 'roomShots.ts',
    `if (landed && r.photo_url &&`, `if (r.photo_url &&`],
  ['a refused shot with nothing on screen shows as taken', 'roomShots.ts',
    `      if (q.refused && !r.photo_url) return r\n`, ``],
  ['an unchanged row is a new object (every queue change redraws)', 'roomShots.ts',
    `      if (next.photo_url === r.photo_url && next.photo_fallback === r.photo_fallback && next.photo_state === r.photo_state) return r\n`, ``],
  ['a server shot reads as uploading', 'roomShots.ts',
    `{ uri: s.photo_url, fallback: null, state: 'saved' }`, `{ uri: s.photo_url, fallback: null, state: 'uploading' }`],
]

function run(files, { quiet }) {
  const work = mkdtempSync(join(tmpdir(), 'camera-recovery-test-'))
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text)
    cpSync(join(repo, 'src/lib/__tests__/cameraRecovery.mocks.ts'), join(work, 'cameraRecovery.mocks.ts'))
    writeFileSync(join(work, 'scenario.ts'), rewrite(read('src/lib/__tests__/cameraRecovery.scenario.ts'), [
      [`'../roomShots'`, `'./roomShots'`],
    ], 'cameraRecovery.scenario.ts'))
    execSync('npx --yes esbuild cameraRecovery.ts roomShots.ts cameraRecovery.mocks.ts scenario.ts --format=cjs --platform=node --outdir=out --log-level=warning', {
      cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
    })
    execSync('node out/scenario.js', { cwd: work, stdio: quiet ? 'pipe' : 'inherit' })
    return { passed: true }
  } catch (e) {
    return { passed: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const real = run(sources, { quiet: false })
if (!real.passed) {
  console.error('\nThe scenario FAILED against the shipped code.')
  process.exit(1)
}

console.log('\n── mutants (each must fail the scenario)')
let survived = 0
for (const [name, file, from, to] of MUTANTS) {
  if (!sources[file].includes(from)) {
    console.log(`MISSING  ${name}: ${file} no longer contains the mutated text`)
    survived++
    continue
  }
  const mutated = { ...sources, [file]: sources[file].split(from).join(to) }
  const r = run(mutated, { quiet: true })
  console.log(`${r.passed ? 'SURVIVED' : 'caught  '}  ${name}`)
  if (r.passed) survived++
}
if (survived) {
  console.error(`\n${survived} mutant(s) survived: the scenario doesn't test what it claims`)
  process.exit(1)
}
console.log(`\nall ${MUTANTS.length} mutants caught`)
