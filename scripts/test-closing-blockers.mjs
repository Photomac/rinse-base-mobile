#!/usr/bin/env node
// Runs the Needs closing badges scenario test
// (src/lib/__tests__/closingBlockers.scenario.ts) against the REAL
// src/lib/closingBlockers.ts: Home asks the completion gate about all its open
// cleans in one request (job_completion_blocker_counts), not one request per
// clean. The module is pure, so this only strips types and runs it; the
// scenario also reads Home's source text from src/.
//
// Same zero-dependency approach as test-carried-lines.mjs: esbuild is fetched
// on demand via npx.
//
// Usage: node scripts/test-closing-blockers.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'closing-blockers-test-'))

try {
  writeFileSync(join(work, 'closingBlockers.ts'), readFileSync(join(repo, 'src/lib/closingBlockers.ts'), 'utf8'))
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/closingBlockers.scenario.ts'), 'utf8')
      .replace(`from '../closingBlockers'`, `from './closingBlockers'`))
  cpSync(join(repo, 'src'), join(work, 'src'), { recursive: true })
  execSync('npx --yes esbuild closingBlockers.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
