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
// held until the clean is done (CKS 2026-11-10): the server's answer
// (inspection_filing_mode: file / hold / wait) wins; with none (no function
// yet, no signal) the status read decides and never says hold; a record with
// held_at and no completed_at is held;
// and, in JobInspectionScreen: what filing does is asked before the confirm
// and again before the clock-out, in this company; a 'wait' writes nothing
// and leaves the form open; a 'hold' has its own confirm, clocks out first,
// writes held_at (never completed_at), and the job screen says held; a held
// record shows locked with its banner; every sentence exists in en, es and
// pt. When the web repo is here, the guard and the hold migration it applies
// are the rules compared.
//
// Usage: node scripts/test-inspection-waits.mjs
//   From a worktree: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-inspection-waits.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs'
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

// ── holding it until the clean is done (CKS 2026-11-10) ────────────────────
check('the server\'s answer, as it gives it', ['file', 'hold', 'wait'].map(m => G.modeFromRpc({ data: m, error: null })), ['file', 'hold', 'wait'])
check('no answer it can use (an error: no function yet, no signal; or an unknown word): null, fall back',
  [G.modeFromRpc({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }), G.modeFromRpc({ data: 'maybe', error: null }),
   G.modeFromRpc({ data: null, error: null }), G.modeFromRpc(null)], [null, null, null, null])
{
  const TEN = '9a2b7c11-1111-4d2e-8f00-5a6b7c8d9e0f'
  const calls = []
  const ask = answer => (id, tid) => { calls.push(['rpc', id, tid]); return typeof answer === 'function' ? answer() : Promise.resolve(answer) }
  const status = answer => id => { calls.push(['status', id]); return Promise.resolve(answer) }
  check('no clean: files, nothing asked', [await G.checkFilingMode(null, TEN, ask({ data: 'wait', error: null }), status(row('in_progress'))), calls.length], ['file', 0])
  check('the server says hold: hold (only it says who may), and the status isn\'t read',
    [await G.checkFilingMode(CLEAN, TEN, ask({ data: 'hold', error: null }), status(row('in_progress'))), calls], ['hold', [['rpc', CLEAN, TEN]]])
  calls.length = 0
  check('the server says wait (Mia at TQ: not an inspector): wait', await G.checkFilingMode(CLEAN, TEN, ask({ data: 'wait', error: null }), status(row('in_progress'))), 'wait')
  check('the server says file: file', await G.checkFilingMode(CLEAN, TEN, ask({ data: 'file', error: null }), status(row('in_progress'))), 'file')
  calls.length = 0
  check('no function yet (before the migration): the status read decides, never hold',
    [await G.checkFilingMode(CLEAN, TEN, ask({ data: null, error: { code: 'PGRST202' } }), status(row('in_progress'))), calls.map(c => c[0])], ['wait', ['rpc', 'status']])
  check('…a completed clean still files', await G.checkFilingMode(CLEAN, TEN, ask({ data: null, error: { code: 'PGRST202' } }), status(row('completed'))), 'file')
  check('the rpc throws (no signal), and so does the read: files as before, the server decides',
    await G.checkFilingMode(CLEAN, TEN, ask(() => { throw new Error('fetch failed') }), () => Promise.reject(new Error('offline'))), 'file')
  calls.length = 0
  check('no company to ask with: straight to the status read', [await G.checkFilingMode(CLEAN, '', ask({ data: 'hold', error: null }), status(row('in_progress'))), calls.map(c => c[0])], ['wait', ['status']])
}
check('held = held_at set and not filed; a filed one, an empty one or a row from before the column is not',
  [G.isHeld({ held_at: '2026-11-11T01:00:00Z', completed_at: null }), G.isHeld({ held_at: '2026-11-11T01:00:00Z', completed_at: '2026-11-11T02:00:00Z' }),
   G.isHeld({ held_at: null, completed_at: null }), G.isHeld({ completed_at: null }), G.isHeld(null)], [true, false, false, false, false])

// ── the screen ──────────────────────────────────────────────────────────────
const screen = read('src/screens/JobInspectionScreen.tsx')
const fileFn = between(screen, 'async function file() {', '\n  function filingModeNow')
const modeFn = between(screen, 'function filingModeNow(): Promise<FilingMode> {', '\n  function sayWait')
const waitFn = between(screen, 'function sayWait() {', '\n  async function doFile')
const doFile = between(screen, 'async function doFile() {', '\n  if (loading) {')
check('the screen uses the rule', /import \{ checkFilingMode, isHeld, type FilingMode \} from '\.\.\/lib\/inspectionCleanGate'/.test(screen))
check('the server is asked about the record\'s clean in this company, and the fallback reads it in this company (as the guard reads it)',
  modeFn.includes("checkFilingMode(rec?.parent_job_id, tenantId,") &&
  modeFn.includes("supabase.rpc('inspection_filing_mode', { p_parent_job_id: cleanId, p_tenant_id: tid })") &&
  modeFn.includes("supabase.from('jobs').select('status').eq('id', cleanId).eq('tenant_id', tenantId).maybeSingle()"))
check('wait: the sentence, in the crew\'s language, and nothing else',
  waitFn.includes("Alert.alert(`⏳ ${t('insp_clean_not_done_title')}`, t('insp_clean_not_done_msg'))") &&
  !/\.update\(|\.insert\(|clockOut/.test(waitFn))
check('before the confirm: asked after the form\'s own checks, the button busy meanwhile, a wait returns',
  fileFn.indexOf('validate()') < fileFn.indexOf('filingModeNow()') &&
  fileFn.indexOf('filingModeNow()') < fileFn.indexOf("Alert.alert(t('insp_confirm_title')") &&
  /setSaving\(true\)\s*\n\s*const mode = await filingModeNow\(\)\s*\n\s*setSaving\(false\)\s*\n\s*if \(mode === 'wait'\) \{ sayWait\(\); return \}/.test(fileFn))
check('hold: its own confirm (title, message, Hold until it\'s done) before anything is written, then the same doFile',
  fileFn.indexOf("if (mode === 'hold') {") < fileFn.indexOf("Alert.alert(t('insp_confirm_title')") &&
  fileFn.includes("Alert.alert(`⏳ ${t('insp_hold_title')}`, `${t('insp_hold_msg')}${unpaid}`") &&
  fileFn.includes("{ text: t('insp_hold_confirm'), onPress: () => { doFile() } }") && !/\.update\(|clockOut/.test(fileFn))
check('before the clock-out: asked again, and a wait stops with the inspector still clocked in and nothing written',
  doFile.includes("const mode = await filingModeNow()\n    if (mode === 'wait') { sayWait(); setSaving(false); return }") &&
  doFile.indexOf('filingModeNow()') < doFile.indexOf('clockOut()') &&
  doFile.indexOf('filingModeNow()') < doFile.indexOf('completed_at'))
check('the clock-out still goes before the write, filed or held (the payroll order)',
  doFile.indexOf('clockOut()') > 0 && doFile.indexOf('clockOut()') < doFile.indexOf('patch.held_at') && doFile.indexOf('clockOut()') < doFile.indexOf('patch.completed_at'))
check('held writes held_at and never completed_at; anything else files',
  doFile.includes("if (mode === 'hold') patch.held_at = new Date().toISOString()\n    else patch.completed_at = new Date().toISOString()"))
check('a refusal still shows the server\'s message; done tells the job screen whether it was held',
  /if \(error\) \{ Alert\.alert\(t\('could_not_save'\), error\.message\); return \}\s*\n\s*onFiled\(mode === 'hold'\)/.test(doFile))
check('a held record reads as held: locked like a filed one, with the banner and its time',
  screen.includes('const held = isHeld(rec)\n  const done = !!rec.completed_at || held') &&
  screen.includes("{held ? t('insp_held_locked') : done ? t('insp_locked') : t('insp_not_completed')}") &&
  screen.includes("ti(t('insp_held_banner'), { time: fmtDateTime(rec.held_at, localeFor(lang)) })"))
const detail = read('src/screens/JobDetailScreen.tsx')
const finish = between(detail, 'function finishFiledInspection(held?: boolean) {', '\n  }')
check('the job screen says held in one alert (with "saved on your phone" folded in), otherwise as before',
  finish.includes("if (held) Alert.alert(`⏳ ${t('insp_held_title')}`, clockOutQueuedRef.current ? `${t('insp_held_msg')}\\n\\n${t('queued_offline')}` : t('insp_held_msg'))") &&
  finish.includes("else if (clockOutQueuedRef.current) Alert.alert('📡', t('queued_offline'))") && detail.includes('onFiled={finishFiledInspection}'))

// ── the words ───────────────────────────────────────────────────────────────
const i18n = read('src/lib/i18n.ts')
const langs = ['en', 'es', 'pt'].map(l => between(i18n, `\n  ${l}: {`, '\n  },'))
const KEYS = ['insp_clean_not_done_title', 'insp_clean_not_done_msg', 'insp_hold_title', 'insp_hold_msg', 'insp_hold_confirm', 'insp_held_title', 'insp_held_msg', 'insp_held_banner', 'insp_held_locked']
check('every sentence in en, es and pt', langs.map(b => KEYS.every(k => b.includes(`${k}:`))), [true, true, true])
check('the English',
  [i18n.includes(`insp_clean_not_done_title: "The clean isn't finished yet"`),
   i18n.includes("insp_clean_not_done_msg: 'Only an inspector can file before the crew completes the clean. Ask them to tap Complete, then file again.'"),
   i18n.includes(`insp_hold_confirm: "Hold until it's done"`)],
  [true, true, true])
check('…naming the Complete button as each language labels it',
  [langs[1].includes('toquen Completar'), langs[2].includes('toquem em Concluir'), /complete_job: 'Completar'/.test(langs[1]), /complete_job: 'Concluir'/.test(langs[2])],
  [true, true, true, true])
check('the banner\'s time goes in each language', langs.map(b => /insp_held_banner: '[^']*\{\{time\}\}/.test(b)), [true, true, true])

// ── the guard this mirrors (when the web repo is on this machine) ───────────
const web = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
const migDir = join(web, 'supabase/migrations')
const migs = existsSync(migDir) ? readdirSync(migDir) : []
const waitsMig = migs.find(f => /_inspection_stays_with_clean\.sql$/.test(f))
if (waitsMig) {
  const sql = readFileSync(join(migDir, waitsMig), 'utf8')
  check('web guard: only a filing (completed_at set, on a record with a clean) is checked',
    /if new\.completed_at is null or new\.parent_job_id is null then\s*\n\s*return new;/.test(sql))
  check('web guard: the clean read in the record\'s company, anything but completed refused (23514)',
    /where j\.id = new\.parent_job_id and j\.tenant_id = new\.tenant_id;/.test(sql) &&
    /if v_status is distinct from 'completed' then/.test(sql) && /errcode = '23514'/.test(sql))
} else {
  console.log(`–  web guard not on this machine (${migDir}); set RINSEBASE_WEB_REPO to compare`)
}
const holdMig = migs.map(f => [f, readFileSync(join(migDir, f), 'utf8')]).find(([, sql]) => /function public\.inspection_filing_mode\(/.test(sql))
if (holdMig) {
  const sql = holdMig[1]
  check(`web hold migration (${holdMig[0]}): the RPC takes the two arguments the app sends, and answers file / hold / wait`,
    /inspection_filing_mode\(\s*p_parent_job_id uuid,\s*p_tenant_id uuid\)/.test(sql) && ["'file'", "'hold'", "'wait'"].every(w => sql.includes(w)))
  check('web hold migration: signed-in users may call it, and job_inspections gets held_at',
    /grant execute on function public\.inspection_filing_mode\(uuid, uuid\) to authenticated/.test(sql) && /add column (if not exists )?held_at timestamptz/.test(sql))
} else {
  console.log('–  web hold migration not on this machine yet (looked for inspection_filing_mode); set RINSEBASE_WEB_REPO to compare')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
