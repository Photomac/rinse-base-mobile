#!/usr/bin/env node
// Runs the SHA-256 scenario test (src/lib/__tests__/sha256.scenario.ts)
// against the REAL src/lib/sha256.ts, comparing it with node:crypto. Nothing to
// mock: the module is pure.
//
// Same zero-dependency approach as test-photo-taken-at.mjs: esbuild via npx.
// Pass --jitless to run it with V8's JIT off, a rough stand-in for Hermes
// (which has none) when judging how long a photo takes to hash on a phone.
//
// Usage: node scripts/test-sha256.mjs [--jitless]
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'sha256-test-'))

try {
  writeFileSync(join(work, 'sha256.ts'), readFileSync(join(repo, 'src/lib/sha256.ts'), 'utf8'))
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/sha256.scenario.ts'), 'utf8')
      .replace(`from '../sha256'`, `from './sha256'`))

  execSync('npx --yes esbuild sha256.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  const flags = process.argv.includes('--jitless') ? '--jitless ' : ''
  execSync(`node ${flags}out/scenario.js`, { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
