#!/usr/bin/env node
// Runs the room-shot scenario test (src/lib/__tests__/roomShots.scenario.ts)
// against the REAL src/lib/roomShots.ts. Its one import, lib/photoQueue (the
// phone's queue, AsyncStorage and Supabase), is stubbed: the functions under
// test are pure, and the queue reads are given to them as lists.
//
// Same zero-dependency approach as test-photo-taken-at.mjs: esbuild via npx.
//
// Usage: node scripts/test-room-shots.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'room-shots-test-'))

const stub = `
export async function queuedShots() { return new Map() }
export async function queuedShotList() { return [] }
`

try {
  const src = readFileSync(join(repo, 'src/lib/roomShots.ts'), 'utf8')
  if (!src.includes(`from './photoQueue'`)) throw new Error('roomShots.ts no longer imports ./photoQueue: update this runner')
  writeFileSync(join(work, 'roomShots.ts'), src.replace(`from './photoQueue'`, `from './photoQueue.stub'`))
  writeFileSync(join(work, 'photoQueue.stub.ts'), stub)
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/roomShots.scenario.ts'), 'utf8')
      .replace(`from '../roomShots'`, `from './roomShots'`))

  execSync('npx --yes esbuild roomShots.ts photoQueue.stub.ts scenario.ts --format=cjs --platform=node --outdir=out', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
