#!/usr/bin/env node
// Runs the offline cache pruning scenarios (src/lib/__tests__/cachePrune.scenario.ts)
// against the REAL src/lib/cachePrune.ts, jobReads.ts, dataCache.ts, outbox.ts,
// photoQueue.ts, videoQueue.ts, crewNote.ts and timezone.ts, bundled with the
// app's own supabase-js from node_modules. Native modules are stubs
// (offlineAuth.mocks.ts and stubs/expo-file-system, via esbuild --alias). Each
// scenario runs in its own process, like an app launch.
//
// First, a source check: the stop's screen records every stop it opens, and
// the day pack records its stops and prunes after a saved run.
//
// Needs node_modules installed (it bundles @supabase/supabase-js). No
// package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-cache-prune.mjs [scenario ...]
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
console.log('\n── source: who records stops, who prunes')
const detail = read('src/screens/JobDetailScreen.tsx')
check('the stop\'s screen records the stop it opens', /noteCachedJobs\(\[job\]\)/.test(detail))
const prefetch = read('src/lib/offlinePrefetch.ts')
check('the day pack records the stops it saves', /noteCachedJobs\(mine\)/.test(prefetch))
const prunedAt = prefetch.indexOf('pruneJobCache(user, mine)')
const savedAt = prefetch.indexOf("return { status: 'saved'")
const offlineAt = prefetch.indexOf("if (done.offline) return { status: 'offline'")
check('...and prunes only after a run that got through, keeping those stops',
  prunedAt > offlineAt && offlineAt > 0 && prunedAt < savedAt)

// ── Scenarios ───────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'cache-prune-test-'))
const tests = join(repo, 'src/lib/__tests__')
const mocks = join(tests, 'offlineAuth.mocks.ts')
const MOCKED = ['react-native', '@react-native-async-storage/async-storage', 'expo-location',
  'expo-task-manager', 'expo-notifications', 'expo-image-picker']
const alias = [...MOCKED.map(p => `--alias:${p}=${mocks}`), `--alias:expo-file-system=${join(tests, 'stubs/expo-file-system')}`].join(' ')
const esbuild = (entry, out) => execSync(
  `npx --yes esbuild ${JSON.stringify(entry)} --bundle --platform=node --format=cjs --log-level=error ${alias} --outfile=${JSON.stringify(out)}`,
  { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_PATH: join(repo, 'node_modules') } },
)

const SCENARIOS = [
  'everyKeyHasItsOwner',
  'dropsStopsAWeekGone',
  'keepsWhatMayStillBeNeeded',
  'outboxHoldsEverything',
  'noNeedsClosingListNoPrune',
  'keysFromBeforeTheIndexGetAWeek',
  'unknownPropertyKeepsProperties',
  'openedDuringAPrune',
  'notesDoNotLoseEachOther',
  'signOutDuringAPrune',
  'growthStaysBounded',
]

try {
  esbuild(join(tests, 'cachePrune.entry.ts'), join(work, 'client.js'))
  esbuild(join(tests, 'cachePrune.scenario.ts'), join(work, 'scenario.js'))
  const only = process.argv.slice(2).filter(a => !a.startsWith('--'))
  for (const name of only.length ? only : SCENARIOS) {
    const r = spawnSync(process.execPath, [join(work, 'scenario.js'), name], {
      stdio: 'inherit', timeout: 300_000,
      // The phone and the company both in Sedona (no DST), like CKS.
      env: { ...process.env, CLIENT_BUNDLE: join(work, 'client.js'), TZ: 'America/Phoenix' },
    })
    if (r.status !== 0) failed++
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed) { console.error(`\n${failed} check(s)/scenario(s) failed`); process.exit(1) }
console.log('\nAll cache-prune checks pass.')
