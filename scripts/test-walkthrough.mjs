#!/usr/bin/env node
// Runs the inspection walkthrough scenario test
// (src/lib/__tests__/walkthrough.scenario.ts) against the REAL
// src/lib/walkthrough.ts. The module is pure, so this only strips types and
// runs it; the scenario also reads the screens' source text from src/.
//
// Same zero-dependency approach as test-timezone.mjs: the repo has no test
// runner, and esbuild is fetched on demand via npx.
//
// Usage: node scripts/test-walkthrough.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'walkthrough-test-'))

try {
  writeFileSync(join(work, 'walkthrough.ts'), readFileSync(join(repo, 'src/lib/walkthrough.ts'), 'utf8'))
  writeFileSync(join(work, 'scenario.ts'), readFileSync(join(repo, 'src/lib/__tests__/walkthrough.scenario.ts'), 'utf8'))
  cpSync(join(repo, 'src'), join(work, 'src'), { recursive: true })
  execSync('npx --yes esbuild walkthrough.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
