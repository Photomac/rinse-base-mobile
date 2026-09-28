#!/usr/bin/env node
// Runs the SOS delivery scenario (src/lib/__tests__/sos.scenario.ts) against
// the REAL src/lib/sosQueue.ts and the REAL @supabase/supabase-js from
// node_modules, with only fetch replaced (src/lib/__tests__/sos.mocks.ts).
//
// Same zero-dependency approach as test-outbox.mjs (esbuild via npx, no test
// runner), except the scenario is bundled so the real supabase-js is compiled
// in. The one change to shipped code is a shorter request timeout, so the
// stalled-request case takes milliseconds instead of 20 seconds.
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
  [`from './errorReporter'`, `from './sos.mocks'`],
]

try {
  writeFileSync(join(work, 'sosQueue.ts'), rewrite(read('src/lib/sosQueue.ts'), [
    ...libMocks,
    ['const REQUEST_TIMEOUT_MS = 20_000', 'const REQUEST_TIMEOUT_MS = 150'],
  ], 'sosQueue.ts'))
  writeFileSync(join(work, 'outbox.ts'), rewrite(read('src/lib/outbox.ts'), libMocks, 'outbox.ts'))
  writeFileSync(join(work, 'sos.mocks.ts'), read('src/lib/__tests__/sos.mocks.ts'))
  writeFileSync(join(work, 'sos.supabase.ts'), read('src/lib/__tests__/sos.supabase.ts'))
  writeFileSync(join(work, 'scenario.ts'), rewrite(read('src/lib/__tests__/sos.scenario.ts'), [
    [`from '../sosQueue'`, `from './sosQueue'`],
    [`from '../supabase'`, `from './sos.supabase'`],
  ], 'sos.scenario.ts'))

  execSync('npx --yes esbuild scenario.ts --bundle --format=cjs --platform=node --outfile=out/scenario.js --log-level=warning', {
    cwd: work, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NODE_PATH: join(repo, 'node_modules') },
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
