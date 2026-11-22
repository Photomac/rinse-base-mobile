#!/usr/bin/env node
// Runs the clock-in stamp scenario test (src/lib/__tests__/punchStamp.scenario.ts)
// against the REAL src/lib/punchStamp.ts: a crew member's own Clock in, after
// the "you've arrived" prompt too, is stamped with a fix the phone takes at the
// tap, never the arrival fence's centre (= the property's pin; Celebrity Clean,
// 2026-11-22). The module is pure, so this bundles it with esbuild (fetched on
// demand via npx) and runs it; the scenario also checks the screen and the
// arrival handler on their source text.
//
// No package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-punch-stamp.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'punch-stamp-test-'))

try {
  const out = join(work, 'scenario.js')
  execSync(`npx --yes esbuild ${JSON.stringify(join(repo, 'src/lib/__tests__/punchStamp.scenario.ts'))} --bundle --platform=node --format=cjs --log-level=error --outfile=${JSON.stringify(out)}`, {
    cwd: repo, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync(`node ${JSON.stringify(out)}`, { cwd: repo, stdio: 'inherit', env: { ...process.env, RINSEBASE_MOBILE_REPO: repo } })
} finally {
  rmSync(work, { recursive: true, force: true })
}
