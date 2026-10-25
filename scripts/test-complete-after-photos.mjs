#!/usr/bin/env node
// Runs the complete-after-photos scenario
// (src/lib/__tests__/completeAfterPhotos.scenario.ts) against the REAL
// src/lib/outbox.ts and src/lib/photoQueue.ts together, the outbox importing the
// real photo queue, with their other imports (AsyncStorage, expo-file-system,
// supabase, errorReporter) rewritten to completeAfterPhotos.mocks.ts, which
// reuses photoQueue.mocks.ts. Same zero-dependency approach as
// scripts/test-photo-queue.mjs; the 240 s upload timeout is shortened to 50 ms.
//
// Then it builds mutants of the shipped code and requires the scenario to FAIL
// on each one: a green run proves only as much as a broken build would fail.
//
// Usage: node scripts/test-complete-after-photos.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(repo, p), 'utf8')

// Every rewrite must match, or the test would run against something other
// than the shipped code. An `optional` one is for an import outbox.ts may not
// have yet (netFetch, rinse-base-mobile #181).
function rewrite(text, pairs, file) {
  for (const [from, to, opts] of pairs) {
    if (!text.includes(from)) {
      if (opts?.optional) continue
      throw new Error(`test-complete-after-photos: ${file} no longer contains: ${from}`)
    }
    text = text.split(from).join(to)
  }
  return text
}

const MOCKS = './completeAfterPhotos.mocks'
const sources = {
  'outbox.ts': rewrite(read('src/lib/outbox.ts'), [
    [`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from '${MOCKS}'`],
    [`from './supabase'`, `from '${MOCKS}'`],
    [`from './errorReporter'`, `from '${MOCKS}'`],
    [`from './netFetch'`, `from '${MOCKS}'`, { optional: true }],
  ], 'outbox.ts'),
  'photoQueue.ts': rewrite(read('src/lib/photoQueue.ts'), [
    [`import AsyncStorage from '@react-native-async-storage/async-storage'`, `import { AsyncStorage } from '${MOCKS}'`],
    [`import * as FileSystem from 'expo-file-system/legacy'`, `import { FileSystem } from '${MOCKS}'`],
    [`from './supabase'`, `from '${MOCKS}'`],
    [`from './errorReporter'`, `from '${MOCKS}'`],
    [`const UPLOAD_TIMEOUT_MS = 240_000`, `const UPLOAD_TIMEOUT_MS = 50`],
  ], 'photoQueue.ts'),
  // No imports: as is.
  'photoBlockers.ts': read('src/lib/photoBlockers.ts'),
  'photosOnTheWay.ts': read('src/lib/photosOnTheWay.ts'),
}

// Each must make at least one assertion fail (or the scenario stall).
const MUTANTS = [
  ['a queued Complete never waits for its photos', 'outbox.ts',
    `if (photos.waiting > 0) { waitingOnPhotos.add(completes); continue }`, `if (false) { waitingOnPhotos.add(completes); continue }`],
  ['a refused photo holds the Complete forever', 'photoQueue.ts',
    `refusalsOf(p) >= REFUSALS_BEFORE_COMPLETE_GOES`, `false`],
  ['an incident-form photo holds the Complete', 'photoQueue.ts',
    `.filter(p => p.job_id === jobId && (!p.incident_report_id || p.also_job_photo) && !p.row_saved)`, `.filter(p => p.job_id === jobId)`],
  ['a photo landing doesn\'t send the waiting Complete', 'outbox.ts',
    `if (!e.uploadedJobId || !waitingOnPhotos.has(e.uploadedJobId)) return`, `return`],
  ['a photo landing mid-flush is missed', 'outbox.ts',
    `if (flushing) photoLandedMidFlush = true`, `if (flushing) return`],
  ['a live Complete refused for its photos is shown as an error', 'outbox.ts',
    `  if (await refusedForPhotosOnPhone(w, res.error)) {\n    await enqueue(w)`, `  if (false) {\n    await enqueue(w)`],
  // Complete at the tap while photos upload (lib/photoBlockers, photosOnPhone).
  ['Complete goes with a blocker no photo here answers', 'photoBlockers.ts',
    `if (left.length === 0) return { kind: 'go' }`, `if (left.length < blockers.length) return { kind: 'go' }`],
  ['any queued shot answers any required shot', 'photoBlockers.ts',
    `photos.some(p => p.photo_requirement_id === b.requirement_id)`, `photos.some(p => !!p.photo_requirement_id)`],
  ['a Check first photo counts as the after photo', 'photoBlockers.ts',
    `(p.photo_type === 'after' || p.photo_type === 'general') && !p.check_first_line_id`, `(p.photo_type === 'after' || p.photo_type === 'general')`],
  ['a photo linked to one line answers another by caption', 'photoBlockers.ts',
    `(!p.checklist_item_id && b.task != null && p.caption === b.task)`, `(b.task != null && p.caption === b.task)`],
  ['a shot the server keeps refusing answers its blocker', 'photoQueue.ts',
    `    .filter(p => !(p.lastErrorKind === 'server' && refusalsOf(p) >= REFUSALS_BEFORE_COMPLETE_GOES))\n`, ``],
  ['another clean\'s photos answer this one\'s blockers', 'photoQueue.ts',
    `export async function photosOnPhone(jobId: string): Promise<PhotoOnPhone[]> {\n  return (await readQueue())\n    .filter(p => p.job_id === jobId && `,
    `export async function photosOnPhone(jobId: string): Promise<PhotoOnPhone[]> {\n  return (await readQueue())\n    .filter(p => `],
  // A teammate's photos on their way (lib/photosOnTheWay, photoQueue.announcePhotos).
  ['a photo isn\'t recorded until a pass', 'photoQueue.ts',
    `  announcePhotos().catch(() => {})\n  return id\n`, `  return id\n`],
  ['a pass never records what capture couldn\'t', 'photoQueue.ts',
    `  // the first upload rather than behind it.\n  announcePhotos().catch(() => {})\n`, `  // the first upload rather than behind it.\n`],
  ['a record is sent again on every pass', 'photoQueue.ts',
    `  if (done.size) await mutateQueue(cur => cur.map(e => done.has(e.id) ? { ...e, announced: true } : e))\n`, ``],
  ['a server without the table is asked on every photo', 'photoQueue.ts',
    `if (first.answer === 'unknown') { onTheWayUnknown = true; return }`, `if (first.answer === 'unknown') { return }`],
  ['one refused record sinks the batch', 'photoQueue.ts',
    `const one = due.length > 1 ? await sendRecords([row(p)]) : first`, `const one = first`],
  ['a photo for a clean you\'re not on is reported as an error', 'photoQueue.ts',
    `if (one.answer === 'refused' && one.code !== '42501') refused.push`, `if (one.answer === 'refused') refused.push`],
  ['an incident-form photo is recorded', 'photoQueue.ts',
    `.filter(p => (!p.incident_report_id || p.also_job_photo) && !p.row_saved && !p.announced)`, `.filter(p => !p.row_saved && !p.announced)`],
  ['a photo that will never land keeps its record', 'photoQueue.ts',
    `      if (entry.announced) forgetRecord(entry.fileName)\n`, ``],
  ['another clean\'s photos go with the Complete', 'photoQueue.ts',
    `export async function photosOnTheWay(jobId: string): Promise<OnTheWayRow[]> {\n  return (await readQueue())\n    .filter(p => p.job_id === jobId && `,
    `export async function photosOnTheWay(jobId: string): Promise<OnTheWayRow[]> {\n  return (await readQueue())\n    .filter(p => `],
  ['the record drops the required shot', 'photosOnTheWay.ts',
    `photo_requirement_id: p.photo_requirement_id ?? null,`, `photo_requirement_id: null,`],
  ['the record forgets where the file will land', 'photosOnTheWay.ts',
    `object_name: p.fileName,`, `object_name: p.fileName.replace('.jpg', ''),`],
  ['no answer reads as clear (the Complete goes past the gate\'s blockers)', 'photosOnTheWay.ts',
    `if (error || !data || typeof data !== 'object') return { kind: 'unavailable' }`, `if (error || !data || typeof data !== 'object') return { kind: 'clear' }`],
  ['an empty blocked list holds nothing back', 'photosOnTheWay.ts',
    `case 'blocked': return Array.isArray(data.blockers) && data.blockers.length > 0`, `case 'blocked': return true`],
  ['the crew is told their own phone is a teammate\'s', 'photosOnTheWay.ts',
    `.filter(w => w.user_id !== me)`, `.filter(w => !!w)`],
]

function run(files, { quiet }) {
  const work = mkdtempSync(join(tmpdir(), 'complete-after-photos-test-'))
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text)
    cpSync(join(repo, 'src/lib/sha256.ts'), join(work, 'sha256.ts'))
    // outbox.ts imports ./timezone (dayKey) as-is: it has no imports of its own.
    cpSync(join(repo, 'src/lib/timezone.ts'), join(work, 'timezone.ts'))
    cpSync(join(repo, 'src/lib/__tests__/photoQueue.mocks.ts'), join(work, 'photoQueue.mocks.ts'))
    cpSync(join(repo, 'src/lib/__tests__/completeAfterPhotos.mocks.ts'), join(work, 'completeAfterPhotos.mocks.ts'))
    writeFileSync(join(work, 'scenario.ts'), rewrite(read('src/lib/__tests__/completeAfterPhotos.scenario.ts'), [
      [`'../outbox'`, `'./outbox'`],
      [`'../photoQueue'`, `'./photoQueue'`],
      [`'../photoBlockers'`, `'./photoBlockers'`],
      [`'../photosOnTheWay'`, `'./photosOnTheWay'`],
    ], 'completeAfterPhotos.scenario.ts'))
    execSync('npx --yes esbuild outbox.ts photoQueue.ts photoBlockers.ts photosOnTheWay.ts sha256.ts timezone.ts photoQueue.mocks.ts completeAfterPhotos.mocks.ts scenario.ts --format=cjs --platform=node --outdir=out --log-level=warning', {
      cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
    })
    execSync('node out/scenario.js', { cwd: work, stdio: quiet ? 'pipe' : 'inherit' })
    return { passed: true }
  } catch (e) {
    return { passed: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (!run(sources, { quiet: false }).passed) process.exit(1)

console.log('\nMutants (each must fail):')
let survived = 0
for (const [what, file, from, to] of MUTANTS) {
  const res = run({ ...sources, [file]: rewrite(sources[file], [[from, to]], `${file} (mutant)`) }, { quiet: true })
  const caughtBy = (res.output ?? '').split('\n').find(l => l.startsWith('FAIL') || l.includes('stalled') || l.includes('timed out'))
  console.log(`${res.passed ? 'SURVIVED' : 'caught  '}  ${what}${caughtBy ? `  ← ${caughtBy.trim()}` : ''}`)
  if (res.passed) survived++
}
if (survived) { console.error(`\n${survived} mutant(s) survived: the scenario doesn't test what it claims`); process.exit(1) }
console.log('\nEvery mutant caught.')
