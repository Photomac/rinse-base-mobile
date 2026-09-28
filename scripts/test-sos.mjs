#!/usr/bin/env node
// Runs the SOS scenarios against the REAL shipped code:
//   src/lib/__tests__/sos.scenario.ts        src/lib/sosQueue.ts (delivery queue)
//   src/lib/__tests__/sosTracker.scenario.ts src/lib/sosTracker.ts (location trail)
// with the REAL @supabase/supabase-js from node_modules and only fetch replaced
// (src/lib/__tests__/sos.mocks.ts). The trail's platform modules (expo-location,
// expo-task-manager, permissions, i18n) are faked by sosTracker.mocks.ts.
//
// Same zero-dependency approach as test-outbox.mjs (esbuild via npx, no test
// runner), except each scenario is bundled so the real supabase-js is compiled
// in. The one change to shipped code is shorter request timeouts, so the
// stalled-request cases take milliseconds instead of 15-20 seconds.
//
// Needs node_modules. Usage: node scripts/test-sos.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'sos-test-'))
const read = p => readFileSync(join(repo, p), 'utf8')

// Every rewrite must match, or the test would silently run against something
// other than the shipped code.
function rewrite(text, pairs, file) {
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`test-sos: ${file} no longer contains: ${from}`)
    text = text.split(from).join(to)
  }
  return text
}

const libMocks = [
  [`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from './sos.mocks'`],
  [`from './supabase'`, `from './sos.supabase'`],
]

try {
  writeFileSync(join(work, 'sosQueue.ts'), rewrite(read('src/lib/sosQueue.ts'), [
    ...libMocks,
    [`from './errorReporter'`, `from './sos.mocks'`],
    ['const REQUEST_TIMEOUT_MS = 20_000', 'const REQUEST_TIMEOUT_MS = 150'],
  ], 'sosQueue.ts'))
  writeFileSync(join(work, 'outbox.ts'), rewrite(read('src/lib/outbox.ts'), [
    ...libMocks,
    [`from './errorReporter'`, `from './sos.mocks'`],
  ], 'outbox.ts'))
  writeFileSync(join(work, 'sosTracker.ts'), rewrite(read('src/lib/sosTracker.ts'), [
    ...libMocks,
    [`import * as Location from 'expo-location'`, `import * as Location from './sosTracker.mocks'`],
    [`import * as TaskManager from 'expo-task-manager'`, `import * as TaskManager from './sosTracker.mocks'`],
    [`from './permissions'`, `from './sosTracker.mocks'`],
    [`from './i18n'`, `from './sosTracker.mocks'`],
    ['const REQUEST_TIMEOUT_MS = 15_000', 'const REQUEST_TIMEOUT_MS = 150'],
  ], 'sosTracker.ts'))
  for (const f of ['sos.mocks.ts', 'sos.supabase.ts', 'sosTracker.mocks.ts']) {
    writeFileSync(join(work, f), read(`src/lib/__tests__/${f}`))
  }
  writeFileSync(join(work, 'queue.scenario.ts'), rewrite(read('src/lib/__tests__/sos.scenario.ts'), [
    [`from '../sosQueue'`, `from './sosQueue'`],
  ], 'sos.scenario.ts'))
  writeFileSync(join(work, 'tracker.scenario.ts'), rewrite(read('src/lib/__tests__/sosTracker.scenario.ts'), [
    [`from '../sosTracker'`, `from './sosTracker'`],
    [`from '../sosQueue'`, `from './sosQueue'`],
  ], 'sosTracker.scenario.ts'))

  // Each scenario is its own process: module state (the queue's chain, the
  // trail's timer) never leaks from one into the other.
  for (const scenario of ['queue', 'tracker']) {
    execSync(`npx --yes esbuild ${scenario}.scenario.ts --bundle --format=cjs --platform=node --outfile=out/${scenario}.js --log-level=warning`, {
      cwd: work, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NODE_PATH: join(repo, 'node_modules') },
    })
    console.log(`\n── ${scenario} ──`)
    execSync(`node out/${scenario}.js`, { cwd: work, stdio: 'inherit' })
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
