#!/usr/bin/env node
// An inspection opened while the crew are still cleaning says so up front, and
// asks before the inspector leaves without filing (CKS 2026-11-15, BOCCE;
// src/lib/inspectionLeave.ts).
//
// What we promised: "When an inspection is opened while the crew are still
// cleaning, the app says up front that filing now holds it until they finish,
// and asks before they leave without filing."
//
// Runs the REAL src/lib/inspectionLeave.ts under Node's type stripping:
//   • the banner: only over an inspection not filed or held whose clean is
//     scheduled, on the way or being cleaned; 'hold' for an inspector or the
//     office, 'wait' for anyone else, none when the server says the clean is
//     completed ('file') or can't say;
//   • leaving: asks only when something changed since the form was loaded or
//     saved (a result, the layer, corrections, minutes, notes, or a walkthrough
//     answer), never for a filed or held one; a reload after a save isn't a
//     change (notes and minutes compare trimmed); Stay, Save progress (when it
//     can), Leave;
// and, in JobInspectionScreen: the banner reads the form's own filing answer
// (filingModeNow, so one source) and the clean's status; the header's back and
// Android's hardware back both go through the ask; a walkthrough answer counts;
// a save that worked resets what counts as changed; every sentence exists in
// en, es and pt, naming the buttons as each language labels them.
//
// Usage: node scripts/test-inspection-leave.mjs
import { readFileSync } from 'node:fs'
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

const L = await import(join(repo, 'src/lib/inspectionLeave.ts'))

// ── the banner ──────────────────────────────────────────────────────────────
console.log('\nthe banner')
check('the crew still on it (scheduled, on the way, cleaning): an inspector or the office reads "hold"',
  ['scheduled', 'en_route', 'in_progress'].map(s => L.openCleanBanner({ done: false, cleanStatus: s, mode: 'hold' })), ['hold', 'hold', 'hold'])
check('…anyone else reads "wait"', L.openCleanBanner({ done: false, cleanStatus: 'in_progress', mode: 'wait' }), 'wait')
check('the server says the clean is completed (file), or can\'t say: no banner',
  [L.openCleanBanner({ done: false, cleanStatus: 'in_progress', mode: 'file' }), L.openCleanBanner({ done: false, cleanStatus: 'in_progress', mode: null }),
   L.openCleanBanner({ done: false, cleanStatus: 'in_progress', mode: undefined })], [null, null, null])
check('a clean completed, cancelled, a no-show, awaiting approval, or unread: no banner (nobody is cleaning)',
  ['completed', 'cancelled', 'no_show', 'pending_approval', 'draft', null, undefined, 42].map(s => L.openCleanBanner({ done: false, cleanStatus: s, mode: 'hold' })),
  [null, null, null, null, null, null, null, null])
check('filed or held already: no banner', [L.openCleanBanner({ done: true, cleanStatus: 'in_progress', mode: 'hold' }), L.openCleanBanner({ done: true, cleanStatus: 'scheduled', mode: 'wait' })], [null, null])

// ── leaving ─────────────────────────────────────────────────────────────────
console.log('\nleaving')
const blank = { layer: 'supervisor', result: '', corrections: false, minutes: '', notes: '' }
const base = L.formKey(blank)
check('nothing changed: back leaves at once', L.leaveDecision({ done: false, formChanged: L.formChanged(base, blank), walkTouched: false }), 'leave')
check('a result picked: asks', L.leaveDecision({ done: false, formChanged: L.formChanged(base, { ...blank, result: 'pass' }), walkTouched: false }), 'ask')
check('notes, the layer, corrections or minutes changed: asks',
  [{ notes: 'Mirror streaky' }, { layer: 'self' }, { corrections: true }, { minutes: '10' }].map(d =>
    L.leaveDecision({ done: false, formChanged: L.formChanged(base, { ...blank, ...d }), walkTouched: false })), ['ask', 'ask', 'ask', 'ask'])
check('only a walkthrough line answered (it saved itself, the inspection still isn\'t filed): asks',
  L.leaveDecision({ done: false, formChanged: false, walkTouched: true }), 'ask')
check('filed or held: leaves, whatever changed', L.leaveDecision({ done: true, formChanged: true, walkTouched: true }), 'leave')
check('a reload after a save isn\'t a change: notes and minutes compare trimmed',
  [L.formChanged(L.formKey({ ...blank, notes: 'ok ', minutes: ' 5' }), { ...blank, notes: 'ok', minutes: '5' })], [false])
check('no form loaded (no record): nothing to lose', [L.formChanged(null, { ...blank, result: 'pass' }), L.formChanged(undefined, blank)], [false, false])
check('the ask: Stay, Save progress, Leave; without Save progress while a save is under way',
  [L.leaveChoices({ canSave: true }), L.leaveChoices({ canSave: false })], [['stay', 'save', 'leave'], ['stay', 'leave']])
check('the open statuses are exactly the crew\'s', [...L.OPEN_CLEAN_STATUSES], ['scheduled', 'en_route', 'in_progress'])

// ── the screen ──────────────────────────────────────────────────────────────
console.log('\nthe screen')
const screen = read('src/screens/JobInspectionScreen.tsx')
const leave = between(screen, 'function requestLeave() {', '\n  }\n')
const save = between(screen, 'async function saveProgress(): Promise<boolean> {', '\n  }\n')
check('the screen uses the rule', screen.includes("import { formChanged, formKey, leaveChoices, leaveDecision, openCleanBanner } from '../lib/inspectionLeave'"))
check('the banner reads the form\'s own filing answer (filingModeNow: inspection_filing_mode, one source) once a record not filed or held has a clean',
  /if \(!rec\?\.parent_job_id \|\| rec\.completed_at \|\| isHeld\(rec\)\) \{ setBannerMode\(null\); return \}/.test(screen) &&
  /filingModeNow\(\)\.then\(m => \{ if \(live\) setBannerMode\(m\) \}\)/.test(screen))
check('…and the clean\'s status from the read the form already makes of it',
  screen.includes("supabase.from('jobs').select('completed_at, scheduled_start, status').eq('id', data.parent_job_id).maybeSingle()") &&
  screen.includes('setCleanStatus((parent as any)?.status ?? null)'))
check('…shown at the top of the form, worded hold or wait',
  screen.includes('const banner = openCleanBanner({ done, cleanStatus, mode: bannerMode })') &&
  screen.indexOf('{banner && (') < screen.indexOf('styles.whyCard') && screen.indexOf('{banner && (') > screen.indexOf('<ScrollView contentContainerStyle') &&
  screen.includes("{banner === 'hold' ? t('insp_open_clean_hold') : t('insp_open_clean_wait')}"))
check('the header\'s back asks (the form); loading and "no inspection" go straight back',
  screen.includes('<Header onBack={requestLeave} title={t(\'inspection\')} />') &&
  (screen.match(/<Header onBack=\{onBack\} title=\{t\('inspection'\)\} \/>/g) ?? []).length === 2)
check('Android\'s hardware back goes through the same ask, with this render\'s state, and is consumed',
  /BackHandler\.addEventListener\('hardwareBackPress', \(\) => \{ leaveRef\.current\(\); return true \}\)/.test(screen) &&
  screen.includes('leaveRef.current = requestLeave') && /return \(\) => sub\.remove\(\)/.test(screen))
check('…the hooks sit above every early return (Rules of Hooks)',
  screen.indexOf("BackHandler.addEventListener") < screen.indexOf('if (loading) {') && screen.indexOf('setBannerMode(m)') < screen.indexOf('if (loading) {'))
check('the ask: decided by the rule; Stay / Save progress / Leave in the crew\'s language; Save progress leaves only once it saved',
  leave.includes('leaveDecision({ done, formChanged: changed, walkTouched: walkTouched.current })') &&
  leave.includes("Alert.alert(`📝 ${t('insp_leave_title')}`, bannerMode === 'wait' ? t('insp_leave_msg_wait') : t('insp_leave_msg'),") &&
  leave.includes("{ text: t('insp_leave_stay'), style: 'cancel' as const }") &&
  leave.includes("{ text: t('insp_save'), onPress: () => { saveProgress().then(ok => { if (ok) onBack() }) } }") &&
  leave.includes("{ text: t('insp_leave_go'), style: 'destructive' as const, onPress: () => onBack() }"))
check('…filed or held (or no record) never asks', leave.includes('const done = !rec || !!rec.completed_at || isHeld(rec)'))
check('a walkthrough answer counts as a change', screen.includes('onChanged={() => { walkTouched.current = true }}'))
check('a save that worked is what counts as unchanged now (no ask after it); a failed one changes nothing',
  /if \(error\) \{ Alert\.alert\(t\('could_not_save'\), error\.message\); return false \}\s*\n\s*savedForm\.current = formKey\(\{ layer, result, corrections, minutes, notes \}\)\s*\n\s*walkTouched\.current = false/.test(save))
check('…and so is the form as loaded', /savedForm\.current = formKey\(\{\s*\n\s*layer: data\.layer \?\? 'supervisor', result: data\.result \?\? '', corrections: !!data\.corrections_made,/.test(screen))
const detail = read('src/screens/JobDetailScreen.tsx')
check('filing or holding closes the form (the job screen), so nothing asks after it',
  /function finishFiledInspection\(held\?: boolean\) \{[\s\S]*?setShowInspection\(false\)\s*\n\s*onBack\(\)/.test(detail) && detail.includes('onFiled={finishFiledInspection}'))

// ── the words ───────────────────────────────────────────────────────────────
console.log('\nthe words')
const i18n = read('src/lib/i18n.ts')
const langs = ['en', 'es', 'pt'].map(l => between(i18n, `\n  ${l}: {`, '\n  },'))
const KEYS = ['insp_open_clean_hold', 'insp_open_clean_wait', 'insp_leave_title', 'insp_leave_msg', 'insp_leave_msg_wait', 'insp_leave_stay', 'insp_leave_go']
check('every sentence in en, es and pt', langs.map(b => KEYS.every(k => b.includes(`${k}:`))), [true, true, true])
check('the English, as promised',
  [i18n.includes(`insp_open_clean_hold: "The crew are still cleaning. When you're done, tap Complete inspection: it's held and goes out as guest ready the moment they complete the clean."`),
   i18n.includes("insp_open_clean_wait: 'The crew are still cleaning. An inspector has to file this inspection. Tap Save progress so your notes are kept.'"),
   i18n.includes("insp_leave_title: 'Leave without filing?'")], [true, true, true])
const label = (b, k) => (new RegExp(`${k}: '([^']*)'`).exec(b) ?? [])[1]
check('…each language names the buttons as it labels them (Complete inspection, Save progress)',
  langs.map(b => b.split(label(b, 'insp_complete')).length >= 3 && b.split(label(b, 'insp_save')).length >= 5), [true, true, true])
check('Spanish opens its question with ¿', /insp_leave_title: '¿Salir sin registrar\?'/.test(langs[1]), true)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
