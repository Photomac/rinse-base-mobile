#!/usr/bin/env node
// Runs the tenant-timezone scenario test (src/lib/__tests__/timezone.scenario.ts)
// against the REAL src/lib/timezone.ts. Nothing to mock — the module is pure —
// so this only strips types and runs it.
//
// The process TZ is forced to Europe/Lisbon on purpose: the bug under test only
// exists when the phone and the business are in different zones, so a run in
// the tenant's own zone would pass regardless of what the code does.
//
// Same zero-dependency approach as test-outbox.mjs: the repo has no test
// runner, and esbuild is fetched on demand via npx.
//
// Usage: node scripts/test-timezone.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'timezone-test-'))

try {
  writeFileSync(join(work, 'timezone.ts'), readFileSync(join(repo, 'src/lib/timezone.ts'), 'utf8'))
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/timezone.scenario.ts'), 'utf8')
      .replace(`from '../timezone'`, `from './timezone'`))

  execSync('npx --yes esbuild timezone.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit', env: { ...process.env, TZ: 'Europe/Lisbon' } })
} finally {
  rmSync(work, { recursive: true, force: true })
}
