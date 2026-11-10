#!/usr/bin/env node
// An inspection is filed on a finished clean, and an early tap doesn't clock
// the inspector out (CKS, 2026-11-09; src/lib/inspectionCleanGate.ts, for
// rinse-base-app 20261110140000_inspection_stays_with_clean).
//
// Runs the REAL src/lib/inspectionCleanGate.ts under Node's type stripping:
//   • no clean on the record: files as before;
//   • a clean that is completed: files; any other status, or no row: waits
//     (the database's guard refuses exactly those);
//   • a read that fails or throws (no signal): files as before, and the
//     server's refusal is what the inspector sees;
// and, in JobInspectionScreen: the clean is asked before the confirm and again
// before the clock-out, read in this company, a 'wait' writes nothing and
// leaves the form open; the sentence exists in en, es and pt. When the web
// repo is here, the guard it applies is the rule tested.
//
// Usage: node scripts/test-inspection-waits.mjs
//   From a worktree: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-inspection-waits.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(repo, p), 'utf8')
let pass = 0, fail = 0
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const between = (text, from, to) => {
  const i = text.indexOf(from)
  return i < 0 ? '' : text.slice(i, text.indexOf(to, i + from.length))
}

const G = await import(join(repo, 'src/lib/inspectionCleanGate.ts'))
const CLEAN = '3f1c2a9e-8b4d-4e2f-9a61-0c7d5e8b2f14'
const row = status => ({ data: { status }, error: null })

// ── the rule ────────────────────────────────────────────────────────────────
check('no clean on the record (null, missing, blank, not a string): files as before',
  [null, undefined, '', '   ', 42].map(p => G.cleanGate(p, row('in_progress'))), ['file', 'file', 'file', 'file', 'file'])
check('its clean is completed: files', G.cleanGate(CLEAN, row('completed')), 'file')
check('its clean is anything else: waits (TQ 11/9: filed PASS while the cleaner was still working)',
  ['scheduled', 'en_route', 'in_progress', 'pending_approval', 'draft', 'cancelled', 'no_show', null].map(s => G.cleanGate(CLEAN, row(s))),
  ['wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait'])
check('no row for its clean: waits (the guard reads a missing status as not completed)', G.cleanGate(CLEAN, { data: null, error: null }), 'wait')
check('the read failed (no signal, a server error): files as before, the server decides',
  [G.cleanGate(CLEAN, { data: null, error: { message: 'Network request failed' } }), G.cleanGate(CLEAN, { data: null, error: { message: 'timeout', code: '57014' } }), G.cleanGate(CLEAN, null)],
  ['file', 'file', 'file'])

// ── reading it ──────────────────────────────────────────────────────────────
{
  const asked = []
  const reader = answer => id => { asked.push(id); return typeof answer === 'function' ? answer() : Promise.resolve(answer) }
  check('no clean: nothing is read', [await G.checkCleanGate(null, reader(row('in_progress'))), asked.length], ['file', 0])
  check('a clean: that clean is read, once', [await G.checkCleanGate(CLEAN, reader(row('in_progress'))), asked], ['wait', [CLEAN]])
  check('completed when read: files', await G.checkCleanGate(CLEAN, reader(row('completed'))), 'file')
  check('a read that throws is the network failing: files as before',
    await G.checkCleanGate(CLEAN, reader(() => { throw new Error('fetch failed') })), 'file')
  check('…and one that rejects', await G.checkCleanGate(CLEAN, reader(() => Promise.reject(new Error('offline')))), 'file')
}

// ── the screen ──────────────────────────────────────────────────────────────
const screen = read('src/screens/JobInspectionScreen.tsx')
const fileFn = between(screen, 'async function file() {', '\n  async function cleanNotFinished')
const gateFn = between(screen, 'async function cleanNotFinished(): Promise<boolean> {', '\n  async function doFile')
const doFile = between(screen, 'async function doFile() {', '\n  if (loading) {')
check('the screen uses the rule', /import \{ checkCleanGate \} from '\.\.\/lib\/inspectionCleanGate'/.test(screen))
check('the record\'s clean, read in this company (as the guard reads it)',
  /checkCleanGate\(rec\?\.parent_job_id, \(cleanId\) =>\s*\n\s*supabase\.from\('jobs'\)\.select\('status'\)\.eq\('id', cleanId\)\.eq\('tenant_id', tenantId\)\.maybeSingle\(\)\)/.test(gateFn))
check('not completed: the sentence, in the crew\'s language, and nothing else',
  gateFn.includes("Alert.alert(`⏳ ${t('insp_clean_not_done_title')}`, t('insp_clean_not_done_msg'))") &&
  !/\.update\(|\.insert\(|clockOut/.test(gateFn))
check('before the confirm: asked after the form\'s own checks, the button busy meanwhile, a wait returns',
  fileFn.indexOf('validate()') < fileFn.indexOf('cleanNotFinished()') &&
  fileFn.indexOf('cleanNotFinished()') < fileFn.indexOf("Alert.alert(t('insp_confirm_title')") &&
  /setSaving\(true\)\s*\n\s*const waits = await cleanNotFinished\(\)\s*\n\s*setSaving\(false\)\s*\n\s*if \(waits\) return/.test(fileFn))
check('before the clock-out: asked again, and a wait stops with the inspector still clocked in and nothing filed',
  doFile.includes('if (await cleanNotFinished()) { setSaving(false); return }') &&
  doFile.indexOf('cleanNotFinished()') < doFile.indexOf('clockOut()') &&
  doFile.indexOf('cleanNotFinished()') < doFile.indexOf('completed_at'))
check('the clock-out still goes before the filing (the payroll order)',
  doFile.indexOf('clockOut()') > 0 && doFile.indexOf('clockOut()') < doFile.indexOf('patch.completed_at'))
check('a refusal still shows the server\'s message (offline fall-through)',
  /if \(error\) \{ Alert\.alert\(t\('could_not_save'\), error\.message\); return \}\s*\n\s*onFiled\(\)/.test(doFile))

// ── the words ───────────────────────────────────────────────────────────────
const i18n = read('src/lib/i18n.ts')
const langs = ['en', 'es', 'pt'].map(l => between(i18n, `\n  ${l}: {`, '\n  },'))
check('title and sentence in en, es and pt',
  langs.map(b => [b.includes('insp_clean_not_done_title:'), b.includes('insp_clean_not_done_msg:')]),
  [[true, true], [true, true], [true, true]])
check('the English is the one asked for',
  [i18n.includes(`insp_clean_not_done_title: "The clean isn't finished yet"`), i18n.includes("insp_clean_not_done_msg: 'File the inspection once the crew has completed the clean. Ask them to tap Complete, then file again.'")],
  [true, true])
check('…naming the Complete button as each language labels it',
  [langs[1].includes('toquen Completar'), langs[2].includes('toquem em Concluir'), /complete_job: 'Completar'/.test(langs[1]), /complete_job: 'Concluir'/.test(langs[2])],
  [true, true, true, true])

// ── the guard this mirrors (when the web repo is on this machine) ───────────
const web = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
const mig = join(web, 'supabase/migrations/20261110140000_inspection_stays_with_clean.sql')
if (existsSync(mig)) {
  const sql = readFileSync(mig, 'utf8')
  check('web guard: only a filing (completed_at set, on a record with a clean) is checked',
    /if new\.completed_at is null or new\.parent_job_id is null then\s*\n\s*return new;/.test(sql))
  check('web guard: the clean read in the record\'s company, anything but completed refused (23514)',
    /where j\.id = new\.parent_job_id and j\.tenant_id = new\.tenant_id;/.test(sql) &&
    /if v_status is distinct from 'completed' then/.test(sql) && /errcode = '23514'/.test(sql))
} else {
  console.log(`–  web guard not on this machine (${mig}); set RINSEBASE_WEB_REPO to compare`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
