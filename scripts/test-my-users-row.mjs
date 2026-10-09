#!/usr/bin/env node
// Runs the users-row scenario test (src/lib/__tests__/myUsersRow.scenario.ts)
// against the REAL src/lib/myUsersRow.ts, and checks the app's three lookups
// use it. Nothing to mock — the module is pure — so this only strips types.
//
// Same zero-dependency approach as test-timezone.mjs: the repo has no test
// runner, and esbuild is fetched on demand via npx.
//
// Usage: node scripts/test-my-users-row.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'my-users-row-test-'))

try {
  writeFileSync(join(work, 'myUsersRow.ts'), readFileSync(join(repo, 'src/lib/myUsersRow.ts'), 'utf8'))
  writeFileSync(join(work, 'scenario.ts'), readFileSync(join(repo, 'src/lib/__tests__/myUsersRow.scenario.ts'), 'utf8')
    .replace(`from '../myUsersRow'`, `from './myUsersRow'`))

  execSync('npx --yes esbuild myUsersRow.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit', env: { ...process.env, REPO: repo } })
} finally {
  rmSync(work, { recursive: true, force: true })
}
