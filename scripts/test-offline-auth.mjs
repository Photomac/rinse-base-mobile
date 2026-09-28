#!/usr/bin/env node
// Runs the offline sign-in scenarios (src/lib/__tests__/offlineAuth.scenario.ts)
// against the REAL src/lib/supabase.ts, netFetch.ts, dataCache.ts, outbox.ts
// and locationTracker.ts, bundled with the app's own supabase-js 2.99.2 from
// node_modules. The network is a mock Supabase server inside the scenario;
// native modules are stubs (offlineAuth.mocks.ts, via esbuild --alias).
//
// Each scenario runs in its own process: the auth client, its timers and the
// module state are per-process, exactly like an app launch.
//
// Needs node_modules installed (it bundles @supabase/supabase-js). No
// package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-offline-auth.mjs [--baseline] [scenario ...]
//   --baseline  also run the pre-fix client (origin/main's supabase.ts) under
//               the same conditions, for the before/after numbers (~2 min).
//   scenario    run only these (names from SCENARIOS below).
import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'offline-auth-test-'))
const tests = join(repo, 'src/lib/__tests__')
const mocks = join(tests, 'offlineAuth.mocks.ts')
const MOCKED = ['react-native', '@react-native-async-storage/async-storage', 'expo-location',
  'expo-task-manager', 'expo-notifications', 'expo-image-picker']
const alias = MOCKED.map(p => `--alias:${p}=${mocks}`).join(' ')
const esbuild = (entry, out) => execSync(
  `npx --yes esbuild ${JSON.stringify(entry)} --bundle --platform=node --format=cjs --log-level=error ${alias} --outfile=${JSON.stringify(out)}`,
  { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_PATH: join(repo, 'node_modules') } },
)

const SCENARIOS = [
  'expiredColdStartThenReconnect',
  'revokedSignInIsDropped',
  'hungNetworkHitsDeadlines',
  'authOutageNeverSendsLapsedToken',
  'fastPhoneClockStillWorks',
  'validTokenOffline',
  'trackerKeepsWorkingOffline',
]

let failed = 0
try {
  esbuild(join(tests, 'offlineAuth.entry.ts'), join(work, 'client.js'))
  esbuild(join(tests, 'offlineAuth.scenario.ts'), join(work, 'scenario.js'))
  const run = (name, client) => {
    const r = spawnSync(process.execPath, [join(work, 'scenario.js'), name], {
      stdio: 'inherit', env: { ...process.env, CLIENT_BUNDLE: client }, timeout: 180_000,
    })
    if (r.status !== 0) failed++
  }
  const only = process.argv.slice(2).filter(a => !a.startsWith('--'))
  for (const name of only.length ? only : SCENARIOS) run(name, join(work, 'client.js'))

  if (process.argv.includes('--baseline')) {
    const before = execSync('git show origin/main:src/lib/supabase.ts', { cwd: repo }).toString()
    writeFileSync(join(work, 'supabase.baseline.ts'), before)
    writeFileSync(join(work, 'baseline.entry.ts'), `export { supabase } from './supabase.baseline'\n`)
    esbuild(join(work, 'baseline.entry.ts'), join(work, 'baseline.js'))
    run('baseline', join(work, 'baseline.js'))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed) { console.error(`\n${failed} scenario(s) failed`); process.exit(1) }
console.log('\nAll offline sign-in scenarios pass.')
