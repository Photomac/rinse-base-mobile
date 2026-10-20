#!/usr/bin/env node
// Runs the carried-lines scenario test (src/lib/__tests__/carriedLines.scenario.ts)
// against the REAL src/lib/carriedLines.ts: walkthrough lines an inspector
// marked Not right at a home, shown on the crew's next cleans there and at the
// top of the next inspection until one marks them OK. The module is pure, so
// this only strips types and runs it; the scenario also reads the screens'
// source text from src/.
//
// Same zero-dependency approach as test-walkthrough.mjs: esbuild is fetched on
// demand via npx.
//
// Usage: node scripts/test-carried-lines.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'carried-lines-test-'))

try {
  writeFileSync(join(work, 'carriedLines.ts'), readFileSync(join(repo, 'src/lib/carriedLines.ts'), 'utf8'))
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/carriedLines.scenario.ts'), 'utf8')
      .replace(`from '../carriedLines'`, `from './carriedLines'`))
  cpSync(join(repo, 'src'), join(work, 'src'), { recursive: true })
  cpSync(join(repo, 'App.tsx'), join(work, 'App.tsx'))  // sign-out deletes the saved photos
  execSync('npx --yes esbuild carriedLines.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
