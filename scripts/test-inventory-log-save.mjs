#!/usr/bin/env node
// Runs the Supplies-save scenario test (src/lib/__tests__/inventoryLogSave.scenario.ts):
// the REAL src/lib/inventoryLogSave.ts plan, turned into writes by the REAL
// src/lib/inventoryLogOutbox.ts and sent through the REAL src/lib/outbox.ts,
// whose three imports (AsyncStorage, supabase, errorReporter) are rewritten to
// the test mocks, as scripts/test-outbox.mjs does.
//
// Usage: node scripts/test-inventory-log-save.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'inventory-save-test-'))

try {
  const outbox = readFileSync(join(repo, 'src/lib/outbox.ts'), 'utf8')
    .replace(`from '@react-native-async-storage/async-storage'`, `from './outbox.mocks'`)
    .replace(`import AsyncStorage`, `import { AsyncStorage }`)
    .replace(`from './supabase'`, `from './outbox.mocks'`)
    .replace(`from './errorReporter'`, `from './outbox.mocks'`)
    .replace(`from './photoQueue'`, `from './outbox.mocks'`)
  writeFileSync(join(work, 'outbox.ts'), outbox)
  cpSync(join(repo, 'src/lib/__tests__/outbox.mocks.ts'), join(work, 'outbox.mocks.ts'))
  cpSync(join(repo, 'src/lib/inventoryLogSave.ts'), join(work, 'inventoryLogSave.ts'))
  cpSync(join(repo, 'src/lib/inventoryLogOutbox.ts'), join(work, 'inventoryLogOutbox.ts'))
  const scenario = readFileSync(join(repo, 'src/lib/__tests__/inventoryLogSave.scenario.ts'), 'utf8')
    .replace(`from '../outbox'`, `from './outbox'`)
    .replace(`from '../inventoryLogSave'`, `from './inventoryLogSave'`)
    .replace(`from '../inventoryLogOutbox'`, `from './inventoryLogOutbox'`)
  writeFileSync(join(work, 'scenario.ts'), scenario)

  execSync('npx --yes esbuild outbox.ts outbox.mocks.ts inventoryLogSave.ts inventoryLogOutbox.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
