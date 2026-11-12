#!/usr/bin/env node
// Runs the maps-link scenario test (src/lib/__tests__/mapsLink.scenario.ts)
// against the REAL src/lib/mapsLink.ts. Nothing to mock: the module is pure.
//
// Same zero-dependency approach as test-timezone.mjs: esbuild via npx.
//
// Usage: node scripts/test-maps-link.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'maps-link-test-'))

try {
  writeFileSync(join(work, 'mapsLink.ts'), readFileSync(join(repo, 'src/lib/mapsLink.ts'), 'utf8'))
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/mapsLink.scenario.ts'), 'utf8')
      .replace(`from '../mapsLink'`, `from './mapsLink'`))

  execSync('npx --yes esbuild mapsLink.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit', env: { ...process.env, TZ: 'America/Chicago' } })
} finally {
  rmSync(work, { recursive: true, force: true })
}
