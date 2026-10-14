#!/usr/bin/env node
// Runs the offline day-pack scenarios (src/lib/__tests__/offlineDayPack.scenario.ts)
// against the REAL src/lib/offlinePrefetch.ts, jobReads.ts, dataCache.ts,
// timezone.ts, outbox.ts and supabase.ts, bundled with the app's own
// supabase-js from node_modules. The network is a mock Supabase server inside
// the scenario; native modules are stubs (offlineAuth.mocks.ts, via esbuild
// --alias). Each scenario runs in its own process, like an app launch.
//
// First, a source check: the screens the pack serves must read through the
// shared builders in src/lib/jobReads.ts, and every builder they read must be
// one the pack saves. A screen that builds its own cachedQuery() key, or reads
// something jobPackReads() doesn't warm, fails here before any scenario runs.
//
// Needs node_modules installed (it bundles @supabase/supabase-js). No
// package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-offline-day-pack.mjs [scenario ...]
import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(repo, p), 'utf8')
let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!cond) failed++
}

// ── Source check ────────────────────────────────────────────────────────────
console.log('\n── source: screens read what the pack saves')
const jobReads = read('src/lib/jobReads.ts')
const prefetch = read('src/lib/offlinePrefetch.ts')
const body = (src, fn) => {
  const start = src.indexOf(`export function ${fn}(`)
  if (start < 0) return ''
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end)
}
const called = text => new Set([...text.matchAll(/\b(\w+Reads?)\(/g)].map(m => m[1]))
const packed = new Set([...called(body(jobReads, 'jobPackReads')), ...called(prefetch)])
const SCREENS = {
  'src/screens/JobDetailScreen.tsx': 'the stop\'s screen',
  'src/screens/JobInventoryScreen.tsx': 'Supplies',
  'src/components/WalkthroughChecklist.tsx': 'the walkthrough',
  'src/components/PrepCard.tsx': 'the prep card',
}
for (const [file, what] of Object.entries(SCREENS)) {
  const src = read(file)
  check(`${what}: no cachedQuery() with its own key`, !/\bcachedQuery\(/.test(src))
  const used = [...src.matchAll(/\bcachedRead\(\s*(\w+)\(/g)].map(m => m[1])
  const viaBundle = [...src.matchAll(/=\s*(\w+Reads)\(/g)].map(m => m[1])  // nextArrivalReads(...), prepReads(...)
  const all = [...new Set([...used, ...viaBundle])]
  const unpacked = all.filter(n => !packed.has(n))
  check(`${what}: every read is one the pack saves`, all.length > 0 && unpacked.length === 0,
    unpacked.length ? `not saved: ${unpacked.join(', ')}` : `${all.length} builders`)
}
const dash = read('src/screens/DashboardScreen.tsx')
check('Home: the day read comes from dashTodayRead()', /cachedRead\(dashTodayRead\(/.test(dash) && !/dash:today/.test(dash))
check('Home: rows go through homeDayRows() (today only)', /homeDayRows\(todayRes\.data/.test(dash))

// ── Scenarios ───────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'day-pack-test-'))
const tests = join(repo, 'src/lib/__tests__')
const mocks = join(tests, 'offlineAuth.mocks.ts')
const MOCKED = ['react-native', '@react-native-async-storage/async-storage', 'expo-location',
  'expo-task-manager', 'expo-notifications', 'expo-image-picker']
// The pack's prune asks the photo and video queues which jobs they hold; their
// file system is a stub folder.
const alias = [...MOCKED.map(p => `--alias:${p}=${mocks}`), `--alias:expo-file-system=${join(tests, 'stubs/expo-file-system')}`].join(' ')
const esbuild = (entry, out) => execSync(
  `npx --yes esbuild ${JSON.stringify(entry)} --bundle --platform=node --format=cjs --log-level=error ${alias} --outfile=${JSON.stringify(out)}`,
  { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_PATH: join(repo, 'node_modules') } },
)

const SCENARIOS = [
  'tomorrowFromTheNightBefore',
  'homeShowsOnlyToday',
  'officeGetsOwnStopsOnly',
  'stopsAtFirstNetworkFailure',
  'joinsAndThrottles',
  'signOutMidRunWritesNothing',
  'outboxDrainedSignal',
  'packPrunesStopsNobodyNeeds',
]

try {
  esbuild(join(tests, 'offlineDayPack.entry.ts'), join(work, 'client.js'))
  esbuild(join(tests, 'offlineDayPack.scenario.ts'), join(work, 'scenario.js'))
  const only = process.argv.slice(2).filter(a => !a.startsWith('--'))
  for (const name of only.length ? only : SCENARIOS) {
    const r = spawnSync(process.execPath, [join(work, 'scenario.js'), name], {
      stdio: 'inherit', timeout: 120_000,
      // The phone and the company both in Sedona (no DST), like CKS.
      env: { ...process.env, CLIENT_BUNDLE: join(work, 'client.js'), TZ: 'America/Phoenix' },
    })
    if (r.status !== 0) failed++
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed) { console.error(`\n${failed} check(s)/scenario(s) failed`); process.exit(1) }
console.log('\nAll offline day-pack checks pass.')
