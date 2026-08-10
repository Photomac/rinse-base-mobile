#!/usr/bin/env node
// Runs the outbox scenario test (src/lib/__tests__/outbox.scenario.ts)
// against the REAL src/lib/outbox.ts with its three imports (AsyncStorage,
// supabase, errorReporter) rewritten to the test mocks.
//
// Zero project dependencies: the repo has no test runner, and adding one for
// a single pure-logic module wasn't worth the install weight. esbuild is
// fetched on demand via npx (CLI alias can't remap relative imports, hence
// the copy-and-rewrite step instead of a plugin).
//
// Usage: node scripts/test-outbox.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'outbox-test-'))

try {
  // outbox.ts with imports pointed at the mocks (kept in the same flat dir).
  const outbox = readFileSync(join(repo, 'src/lib/outbox.ts'), 'utf8')
    .replace(`from '@react-native-async-storage/async-storage'`, `from './outbox.mocks'`)
    .replace(`import AsyncStorage`, `import { AsyncStorage }`)
    .replace(`from './supabase'`, `from './outbox.mocks'`)
    .replace(`from './errorReporter'`, `from './outbox.mocks'`)
  writeFileSync(join(work, 'outbox.ts'), outbox)
  cpSync(join(repo, 'src/lib/__tests__/outbox.mocks.ts'), join(work, 'outbox.mocks.ts'))
  const scenario = readFileSync(join(repo, 'src/lib/__tests__/outbox.scenario.ts'), 'utf8')
    .replace(`from '../outbox'`, `from './outbox'`)
    .replace(`from './outbox.mocks'`, `from './outbox.mocks'`)
  writeFileSync(join(work, 'scenario.ts'), scenario)

  execSync('npx --yes esbuild outbox.ts outbox.mocks.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
