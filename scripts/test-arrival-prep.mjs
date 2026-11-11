#!/usr/bin/env node
// Runs the arrival-prep scenario test (src/lib/__tests__/arrivalPrep.scenario.ts)
// against the REAL src/lib/arrivalPrep.ts: what a turnover's crew see of the
// arrival prep the office linked to their clean (CKS, 2026-11-11). The module
// is pure, so this bundles it with esbuild (fetched on demand via npx) and
// runs it; the scenario also checks the read, the card and the screen on their
// source text. Timing on a weak signal is in test-offline-day-pack.mjs.
//
// No package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-arrival-prep.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'arrival-prep-test-'))

try {
  const out = join(work, 'scenario.js')
  execSync(`npx --yes esbuild ${JSON.stringify(join(repo, 'src/lib/__tests__/arrivalPrep.scenario.ts'))} --bundle --platform=node --format=cjs --log-level=error --outfile=${JSON.stringify(out)}`, {
    cwd: repo, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync(`node ${JSON.stringify(out)}`, { cwd: repo, stdio: 'inherit', env: { ...process.env, RINSEBASE_MOBILE_REPO: repo } })
} finally {
  rmSync(work, { recursive: true, force: true })
}
