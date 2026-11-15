#!/usr/bin/env node
// Runs the sign-in refusal scenarios (src/lib/__tests__/signInRefusal.scenario.ts):
// a deactivated crew member who signs in is told why and signed out, instead of
// landing back on the login screen with no message.
//
// The REAL src/lib/signInRefusal.ts, myUsersRow.ts, supabase.ts and netFetch.ts
// are bundled with the app's own supabase-js 2.99.2 from node_modules; the
// network is a mock Supabase server inside the scenario, and native modules are
// the offline-auth stubs (offlineAuth.mocks.ts, via esbuild --alias). The
// `wiring` scenario checks App.tsx, LoginScreen and i18n make the same calls.
//
// Each scenario runs in its own process: the auth client and its state are
// per process, like an app launch.
//
// Needs node_modules installed (it bundles @supabase/supabase-js). No
// package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-sign-in-refusal.mjs [scenario ...]
//   From a worktree: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-sign-in-refusal.mjs
import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'sign-in-refusal-test-'))
const tests = join(repo, 'src/lib/__tests__')
const mocks = join(tests, 'offlineAuth.mocks.ts')
const MOCKED = ['react-native', '@react-native-async-storage/async-storage']
const alias = MOCKED.map(p => `--alias:${p}=${mocks}`).join(' ')
const esbuild = (entry, out) => execSync(
  `npx --yes esbuild ${JSON.stringify(entry)} --bundle --platform=node --format=cjs --log-level=error ${alias} --outfile=${JSON.stringify(out)}`,
  { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_PATH: join(repo, 'node_modules') } },
)

const SCENARIOS = [
  'deactivated',
  'removed',
  'activeCrew',
  'wrongPassword',
  'activeButReadEmpty',
  'statusUnknown',
  'logoutFailsThenNextLaunch',
  'mapping',
  'wiring',
]

let failed = 0
try {
  esbuild(join(tests, 'signInRefusal.entry.ts'), join(work, 'client.js'))
  esbuild(join(tests, 'signInRefusal.scenario.ts'), join(work, 'scenario.js'))
  const only = process.argv.slice(2)
  for (const name of only.length ? only : SCENARIOS) {
    const r = spawnSync(process.execPath, [join(work, 'scenario.js'), name], {
      stdio: 'inherit', env: { ...process.env, CLIENT_BUNDLE: join(work, 'client.js'), REPO: repo }, timeout: 60_000,
    })
    if (r.status !== 0) failed++
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed) { console.error(`\n${failed} scenario(s) failed`); process.exit(1) }
console.log('\nAll sign-in refusal scenarios pass.')
