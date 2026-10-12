#!/usr/bin/env node
// Runs the photo-taken-at scenario test (src/lib/__tests__/photoTakenAt.scenario.ts)
// against the REAL src/lib/photoTakenAt.ts. Nothing to mock: the module is pure.
// The process TZ is pinned to America/Chicago so the "no offset" case reads the
// camera's clock in a known zone.
//
// Same zero-dependency approach as test-timezone.mjs: esbuild via npx.
//
// Usage: node scripts/test-photo-taken-at.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'photo-taken-at-test-'))

try {
  writeFileSync(join(work, 'photoTakenAt.ts'), readFileSync(join(repo, 'src/lib/photoTakenAt.ts'), 'utf8'))
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/photoTakenAt.scenario.ts'), 'utf8')
      .replace(`from '../photoTakenAt'`, `from './photoTakenAt'`))

  execSync('npx --yes esbuild photoTakenAt.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit', env: { ...process.env, TZ: 'America/Chicago' } })
} finally {
  rmSync(work, { recursive: true, force: true })
}
