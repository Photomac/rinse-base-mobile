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
  'src/components/PrepCard.tsx': 'the prep card',
  'src/lib/checklistCard.ts': 'the stop\'s checklist card',
  'src/lib/stopDetails.ts': 'the stop\'s details (job, crew, property)',
  'src/lib/checkFirstCard.ts': 'the stop\'s Check first card',
  'src/lib/timeTracker.ts': 'the stop\'s time tracker',
  'src/lib/stopInfo.ts': 'the stop\'s note, next arrival, route stop and video switch',
  'src/lib/requiredPhotoCount.ts': 'the stop\'s required-shot counter',
  'src/lib/suppliesCard.ts': 'Supplies',
  'src/lib/walkthroughCard.ts': 'the walkthrough',
  'src/lib/carriedLinesCard.ts': 'the stop\'s "Missed at the last inspection" card',
}
for (const [file, what] of Object.entries(SCREENS)) {
  const src = read(file)
  check(`${what}: no cachedQuery() with its own key`, !/\bcachedQuery\(/.test(src))
  const used = [...src.matchAll(/\b(?:cachedRead|readSoon)\(\s*(\w+)\(/g)].map(m => m[1])
  const viaBundle = [...src.matchAll(/=\s*(\w+Reads)\(/g)].map(m => m[1])  // nextArrivalReads(...), prepReads(...)
  const all = [...new Set([...used, ...viaBundle])]
  const unpacked = all.filter(n => !packed.has(n))
  check(`${what}: every read is one the pack saves`, all.length > 0 && unpacked.length === 0,
    unpacked.length ? `not saved: ${unpacked.join(', ')}` : `${all.length} builders`)
}
// The stop's details (lib/stopDetails): a flag the crew changes on the
// screen is handed back before it shows, so an earlier load's answer can't
// undo it (the loads themselves are timed in the stopDetails scenarios).
const detail = read('src/screens/JobDetailScreen.tsx')
const fnBody = (src, sig) => { const i = src.indexOf(sig); return i < 0 ? '' : src.slice(i, src.indexOf('\n  }\n', i)) }
const flagged = f => f.indexOf('details.flagEdited()') > 0 && f.indexOf('details.flagEdited()') < Math.max(f.indexOf('setLaundryDoneOnsite(next)'), f.indexOf('setPetFeeApplied(next)'))
check('the stop\'s screen: laundry-on-site and pet-fee taps mark the flags changed first',
  flagged(fnBody(detail, 'async function toggleLaundryDoneOnsite(')) && flagged(fnBody(detail, 'async function togglePetFee(')) &&
  /details\.flagEdited\(\)\s*setPetFeeApplied\(true\)/.test(detail))
check('the stop\'s screen: flags go on screen only when the load says so', /if \(flags\) \{\s*setLaundryDoneOnsite\(/.test(fnBody(detail, 'function showJobMeta(')))

// The rest of the stop's screen reads through lib/timeTracker, stopInfo and
// requiredPhotoCount (timed in their scenarios). Every punch made on the
// screen goes to the tracker: shown at once, written into the saved copy, and
// kept from older answers. Nothing else sets the running entry.
const punchFns = ['async function clockInAs(', 'async function confirmPause(', 'async function handleResume(', 'async function clockOutActive(']
check('the stop\'s screen: every punch goes to the tracker',
  punchFns.every(sig => /tracker\.punched\(/.test(fnBody(detail, sig))) &&
  (detail.match(/setActiveEntry\(/g) || []).length === 2 && /setActiveEntry\(active\)[\s\S]*setActiveEntry\(null\)/.test(fnBody(detail, 'function showTimeEntries(')),
  punchFns.filter(sig => !/tracker\.punched\(/.test(fnBody(detail, sig))).join(', '))
check('the stop\'s screen: the tracker, the counter and the info open with `soon`',
  /loadTimeEntries\(\{ soon: true \}\)/.test(detail) && /loadPhotoRequirements\(\{ soon: true \}\)/.test(detail) && /info\.load\(job, user\)/.test(detail) &&
  /tracker\.load\(job, user, recordsForOthers, opts\)/.test(fnBody(detail, 'function loadTimeEntries(')) &&
  /photoCount\.load\(job, user, opts\)/.test(fnBody(detail, 'function loadPhotoRequirements(')))
check('the stop\'s screen: "Got it" goes to the info, which never drops one', /info\.acknowledged\(note\)/.test(fnBody(detail, 'function acknowledgeCrewNote(')) && !/setAckedNotes\(prev/.test(detail))
const arrival = read('src/lib/arrivalGeofence.ts')
check('the arrival auto clock-in writes its entry into the saved copy, once it landed',
  /if \(!insErr && entry\) \{[\s\S]{0,400}await savePunch\(auto, user\.id\)/.test(arrival) && /\.upsert\(auto, \{ onConflict: 'id' \}\)/.test(arrival))
// Supplies and the walkthrough read only through their modules.
const supplies = read('src/screens/JobInventoryScreen.tsx')
const walk = read('src/components/WalkthroughChecklist.tsx')
const carriedCard = read('src/components/CarriedLinesCard.tsx')
const ownReads = src => /\b(?:cachedRead|cachedQuery|readSoon)\(|supabase\.from\(/.test(src)
check('the "Missed at the last inspection" card makes no reads of its own',
  !ownReads(carriedCard) && /loadCarried\(job, /.test(carriedCard))
check('Supplies and the walkthrough make no reads of their own',
  !ownReads(supplies) && /suppliesCard\(\{ show, setLoading \}\)/.test(supplies) && !ownReads(walk) && /walkthroughCard\(\{ show, setLoading \}\)/.test(walk))
const setters = ['function setQty(', 'function setRemaining(', 'function toggleLow(', 'function setNotes(']
check('Supplies: the live answer after the saved copy keeps her changed lines, and becomes the save\'s baseline',
  /savedRef\.current = v\.saved\s*if \(late\) \{\s*setLog\(prev => rebaseLines\(v\.lines, prev, editedRef\.current\)\)\s*return\s*\}/.test(fnBody(supplies, 'function show(')))
check('Supplies: every change marks its line before it shows; a save tells the card before it writes',
  setters.every(sig => { const f = fnBody(supplies, sig); return f.indexOf('editedRef.current.add(id)') > 0 && f.indexOf('editedRef.current.add(id)') < f.indexOf('setLog(') }) &&
  (() => { const f = fnBody(supplies, 'async function save('); return f.indexOf('card.saving()') > 0 && f.indexOf('card.saving()') < f.indexOf('writeThrough(') })())
check('the walkthrough: every answer tells the card before it shows; only the first load is `soon`',
  ['async function looksGood(', 'async function answer(', 'async function saveNote('].every(sig => {
    const f = fnBody(walk, sig); return f.indexOf('card.edited()') > 0 && f.indexOf('card.edited()') < f.indexOf('patch(')
  }) && /card\.load\(job, \{ soon: !loaded\.current \}\)/.test(walk))

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
  'checklistOnAHangingLink',
  'checklistNothingSavedWaitsOnce',
  'checklistOnATrickle',
  'checklistSpinnerAlwaysClears',
  'checklistReloadKeepsLiveTick',
  'stopDetailsOnAHangingLink',
  'stopDetailsOnATrickle',
  'stopDetailsSavedRosterKeepsClockIn',
  'checkFirstOnAHangingLink',
  'checkFirstOnATrickle',
  'timerOnAHangingLink',
  'timerLiveAnswerReplacesSaved',
  'timerLateAnswerNeverUndoesAPunch',
  'timerPunchSurvivesTheSavedCopy',
  'timerPauseNeverRunsAgain',
  'timerQueuedPunchesOffline',
  'timerOlderAnswerKeepsAClockOut',
  'timerWholeJobForTheOffice',
  'stopInfoOnAHangingLink',
  'stopInfoTrickleKeepsGotIt',
  'photoCountOnAHangingLink',
  'photoCountOwedListNarrows',
  'photoCountTrickle',
  'photoCountNotEnforcedAsksNothingMore',
  'suppliesOnAHangingLink',
  'suppliesLiveAnswerKeepsHerLines',
  'spinnersAlwaysClear',
  'walkthroughOnAHangingLink',
  'walkthroughTrickle',
  'carriedLinesRideAlong',
  'carriedPhotoFailureNeverFailsThePack',
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
