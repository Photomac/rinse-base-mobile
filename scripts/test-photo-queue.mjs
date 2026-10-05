#!/usr/bin/env node
// Runs the photo-queue scenario test (src/lib/__tests__/photoQueue.scenario.ts)
// against the REAL src/lib/photoQueue.ts with its imports (AsyncStorage,
// expo-file-system, supabase, errorReporter) rewritten to the test mocks.
// Same zero-dependency approach as scripts/test-outbox.mjs. The 240 s upload
// timeout is shortened to 50 ms so the timeout case runs in real time.
//
// Usage: node scripts/test-photo-queue.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'photo-queue-test-'))

function rewrite(src, from, to) {
  if (!src.includes(from)) throw new Error(`test-photo-queue: expected to find ${JSON.stringify(from)} in photoQueue.ts`)
  return src.replace(from, to)
}

try {
  let queue = readFileSync(join(repo, 'src/lib/photoQueue.ts'), 'utf8')
  queue = rewrite(queue, `import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from './photoQueue.mocks'`)
  queue = rewrite(queue, `import * as FileSystem from 'expo-file-system/legacy'`, `import { FileSystem } from './photoQueue.mocks'`)
  queue = rewrite(queue, `from './supabase'`, `from './photoQueue.mocks'`)
  queue = rewrite(queue, `from './errorReporter'`, `from './photoQueue.mocks'`)
  queue = rewrite(queue, `const UPLOAD_TIMEOUT_MS = 240_000`, `const UPLOAD_TIMEOUT_MS = 50`)
  writeFileSync(join(work, 'photoQueue.ts'), queue)
  cpSync(join(repo, 'src/lib/__tests__/photoQueue.mocks.ts'), join(work, 'photoQueue.mocks.ts'))
  const scenario = readFileSync(join(repo, 'src/lib/__tests__/photoQueue.scenario.ts'), 'utf8')
    .replace(`from '../photoQueue'`, `from './photoQueue'`)
  writeFileSync(join(work, 'scenario.ts'), scenario)

  execSync('npx --yes esbuild photoQueue.ts photoQueue.mocks.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
