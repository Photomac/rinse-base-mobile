#!/usr/bin/env node
// Runs the paged-read scenario test (src/lib/__tests__/fetchAll.scenario.ts)
// against the REAL src/lib/fetchAll.ts and src/lib/dataCache.ts, with
// dataCache's AsyncStorage import rewritten to the in-memory test double.
//
// Same zero-dependency approach as test-outbox.mjs: the repo has no test
// runner, and esbuild is fetched on demand via npx.
//
// Usage: node scripts/test-fetchall.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'fetchall-test-'))

try {
  writeFileSync(join(work, 'fetchAll.ts'), readFileSync(join(repo, 'src/lib/fetchAll.ts'), 'utf8'))
  const dataCache = readFileSync(join(repo, 'src/lib/dataCache.ts'), 'utf8')
    .replace(`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from './fetchAll.mocks'`)
  // A silent miss here would test against the real module and fail confusingly.
  if (dataCache.includes('@react-native-async-storage')) throw new Error('dataCache.ts AsyncStorage import changed; update this runner')
  writeFileSync(join(work, 'dataCache.ts'), dataCache)
  cpSync(join(repo, 'src/lib/__tests__/fetchAll.mocks.ts'), join(work, 'fetchAll.mocks.ts'))
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/fetchAll.scenario.ts'), 'utf8')
      .replace(`from '../fetchAll'`, `from './fetchAll'`)
      .replace(`from '../dataCache'`, `from './dataCache'`))

  execSync('npx --yes esbuild fetchAll.ts dataCache.ts fetchAll.mocks.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
