#!/usr/bin/env node
// The crew app in Español and Português, not English with a few words swapped.
//
// Filming the training videos in Spanish (2026-10-20) found English on the tab
// bar, in Schedule's headings, in a paused session's reason, in the note on a
// checklist photo and on Mileage. This checks:
//   • every string exists in en, es and pt, with the same {placeholders};
//   • no es/pt string is still the English one, except the listed ones that
//     are the same word in that language;
//   • Spanish questions and exclamations open with ¿ and ¡;
//   • lib/pauseReason.ts shows the English values the office stores (crew
//     reasons, auto-close and end-day notes) in the crew's language, and
//     leaves anything else as written; the company close time's two notes
//     are the ones the web migration writes (when that repo is on this machine);
//   • lib/photoCaption.ts saves a checklist photo under the line's English
//     text when the crew left the note naming the line, in either language;
// and, in the screens, that the tab labels go through t() and that times and
// dates are formatted in the app language rather than en-US.
//
// Runs the REAL modules under Node's type stripping. i18n.ts imports
// AsyncStorage, so it is copied with that one import stubbed out.
//
// Usage: node scripts/test-i18n.mjs
//   From a worktree: RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-i18n.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const work = mkdtempSync(join(tmpdir(), 'i18n-test-'))
let i18n
try {
  const src = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8').replace(
    "import AsyncStorage from '@react-native-async-storage/async-storage'",
    'const AsyncStorage = { getItem: async (_k: string) => null, setItem: async (_k: string, _v: string) => {} }')
  writeFileSync(join(work, 'i18n.ts'), src)
  i18n = await import(join(work, 'i18n.ts'))
} finally {
  rmSync(work, { recursive: true, force: true })
}
const { translations: T, t } = i18n
const en = T.en

// ── every string in all three languages ─────────────────────────────────────
const keys = Object.keys(en)
for (const L of ['es', 'pt']) {
  check(`${L}: no string missing`, keys.filter(k => !(k in T[L])), [])
  check(`${L}: no string only in ${L}`, Object.keys(T[L]).filter(k => !(k in en)), [])
  check(`${L}: no empty string`, keys.filter(k => k in T[L] && !String(T[L][k]).trim()), [])
}

const holes = s => [...String(s).matchAll(/\{\{?(\w+)\}?\}/g)].map(m => m[1]).sort()
for (const L of ['es', 'pt']) {
  check(`${L}: same {placeholders} as English`,
    keys.filter(k => k in T[L] && JSON.stringify(holes(T[L][k])) !== JSON.stringify(holes(en[k]))), [])
}

// The same word in that language (or no words at all), on purpose.
const SAME = {
  es: ['error', 'no', 'ok', 'ok_btn', 'verify_ok', 'role_inspector', 'to_type_personal', 'check_first_ticked_by', 'team_m', 'tab_chat'],
  pt: ['ok', 'ok_btn', 'verify_ok', 'check_first_ticked_by', 'team_m', 'tab_chat'],
}
for (const L of ['es', 'pt']) {
  const same = keys.filter(k => /\p{L}{2,}/u.test(en[k]) && T[L][k] === en[k] && !SAME[L].includes(k))
  check(`${L}: nothing still in English`, same, [])
}

// ── Spanish punctuation ─────────────────────────────────────────────────────
const count = (s, c) => s.split(c).length - 1
check('es: every ? has its ¿', keys.filter(k => count(T.es[k], '?') !== count(T.es[k], '¿')), [])
check('es: every ! has its ¡', keys.filter(k => count(T.es[k], '!') !== count(T.es[k], '¡')), [])
check('es: "Why are you leaving?"', T.es.pause_title, '¿Por qué te vas?')

// ── pause reasons ───────────────────────────────────────────────────────────
const { PAUSE_REASONS, pauseReasonLabel } = await import(join(repo, 'src/lib/pauseReason.ts'))
const es = k => t('es', k), pt = k => t('pt', k), enT = k => t('en', k)
check('every crew reason is stored in English', PAUSE_REASONS.map(r => r.value),
  ['Waiting for laundry', 'Going to another job', 'Supply run', 'Waiting for access', 'Break', 'Other'])
check('a saved Supply run reads in Spanish', pauseReasonLabel('Supply run', es), T.es.supply_run)
check('… and in Portuguese', pauseReasonLabel('Supply run', pt), T.pt.supply_run)
check('… and stays itself in English', pauseReasonLabel('Supply run', enT), 'Supply run')
check('every crew reason has its label', PAUSE_REASONS.map(r => pauseReasonLabel(r.value, es)), PAUSE_REASONS.map(r => T.es[r.key]))
check('the nightly auto-close note', pauseReasonLabel('Auto-closed: forgot to clock out', es), T.es.pr_auto_forgot)
// The company's own close time (rinsebase-app 20261023163649_day_shift_close_time)
const CLOSE_NOTES = ['Auto-closed: ended at the last clean of the day', 'Auto-closed: no clean finished, ended at the closing time']
check('the close-time notes read in Spanish and Portuguese, and stay themselves in English', [
  CLOSE_NOTES.map(n => pauseReasonLabel(n, es)), CLOSE_NOTES.map(n => pauseReasonLabel(n, pt)), CLOSE_NOTES.map(n => pauseReasonLabel(n, enT)),
], [[T.es.pr_auto_last_clean, T.es.pr_auto_closing_time], [T.pt.pr_auto_last_clean, T.pt.pr_auto_closing_time], CLOSE_NOTES])
check('… after a note already there', pauseReasonLabel(`Day started by the office · ${CLOSE_NOTES[0]}`, es), `Día iniciado por la oficina · ${T.es.pr_auto_last_clean}`)
// The web half, when that repo is on this machine: the function writes exactly these.
const WEB = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
const migDir = join(WEB, 'supabase/migrations')
const closeMig = existsSync(migDir) ? readdirSync(migDir).find(f => /_day_shift_close_time\.sql$/.test(f)) : null
if (closeMig) {
  const sql = readFileSync(join(migDir, closeMig), 'utf8')
  const written = [...sql.matchAll(/then '(Auto-closed: [^']+)'|else '(Auto-closed: [^']+)'/g)].map(m => m[1] || m[2])
  check('web: the close function writes exactly the notes translated here', written, CLOSE_NOTES)
} else {
  console.log(`–  web half skipped (no *_day_shift_close_time.sql under ${migDir})`)
}
check('the older Payroll close-out is a fixed note, not a name',
  pauseReasonLabel('Clocked out by owner (left open)', es), T.es.pr_clocked_out_owner_open)
check('the office ended the day (lib/endDay)', pauseReasonLabel('Day ended by Maria Lopez', es), 'Día terminado por Maria Lopez')
check('… with no name: "the office" reads as a phrase ("pelo", not "por o")',
  [pauseReasonLabel('Clocked out by the office', pt), pauseReasonLabel('Day started by the office', es)],
  ['Saída registrada pelo escritório', 'Día iniciado por la oficina'])
check('notes joined by " · " are translated one by one',
  pauseReasonLabel('Supply run · Auto-closed: a new day was started', es), `${T.es.supply_run} · ${T.es.pr_auto_new_day}`)
check('a note the office typed shows as written', pauseReasonLabel('Left early, dentist', es), 'Left early, dentist')
check('empty stays empty', [pauseReasonLabel(null, es), pauseReasonLabel('', es)], ['', ''])

// ── checklist photo caption ─────────────────────────────────────────────────
const { checklistPhotoNote } = await import(join(repo, 'src/lib/photoCaption.ts'))
const line = { title: 'Scrub toilet inside, outside, and base', jobItemId: 'item-1' }
const shown = 'Tallar el inodoro por dentro, por fuera y la base'
check('untouched note: saved as the line\'s English text, linked',
  checklistPhotoNote(null, line, shown), { caption: line.title, checklistItemId: 'item-1' })
check('the crew typed the translation back: still the line',
  checklistPhotoNote(`  ${shown} `, line, shown), { caption: line.title, checklistItemId: 'item-1' })
check('the English text typed: still the line',
  checklistPhotoNote(line.title, line, shown), { caption: line.title, checklistItemId: 'item-1' })
check('translation not loaded yet (shown is the English): the line',
  checklistPhotoNote(null, line, line.title), { caption: line.title, checklistItemId: 'item-1' })
check('a rewritten note is the crew\'s own, unlinked',
  checklistPhotoNote('Inodoro con mancha', line, shown), { caption: 'Inodoro con mancha', checklistItemId: null })
check('a cleared note: no caption, unlinked',
  checklistPhotoNote('', line, shown), { caption: '', checklistItemId: null })
check('no line (plain Photos): the note as typed',
  checklistPhotoNote('Kitchen', null, ''), { caption: 'Kitchen', checklistItemId: null })
check('a line with no job item id names it but links nothing',
  checklistPhotoNote(null, { title: 'Spa' }, 'Spa'), { caption: 'Spa', checklistItemId: null })

// ── screens ─────────────────────────────────────────────────────────────────
const app = readFileSync(join(repo, 'App.tsx'), 'utf8')
check('every tab label goes through t()', [...app.matchAll(/tabBarLabel:\s*(['"`])/g)].length, 0)

const files = [
  ...readdirSync(join(repo, 'src/screens')).map(f => `src/screens/${f}`),
  ...readdirSync(join(repo, 'src/components')).map(f => `src/components/${f}`),
].filter(f => f.endsWith('.tsx'))
const offenders = (re, allow = [], only = () => true) => files.flatMap(f =>
  only(readFileSync(join(repo, f), 'utf8')) ? readFileSync(join(repo, f), 'utf8').split('\n').map((l, i) => [f, i + 1, l])
    .filter(([, , l]) => re.test(l) && !allow.some(a => l.includes(a)))
    .map(([f, n]) => `${f}:${n}`) : [])
// The month's earnings and My week's pay are dollars, written the US way like
// every other amount in the app ($12.50).
check('no screen formats a date or time as en-US', offenders(/'en-US'/, ['monthStats.earnings.toLocaleString', 'const usDollars = (n: number) => n.toLocaleString']), [])
// lib/timezone's formatters default to en-US. (Chat and Messages have local
// helpers of the same names that already pass localeFor(lang).)
const usesTzFormatters = src => /import \{[^}]*\bfmt(Time|Date|DateTime)\b[^}]*\} from '\.\.\/lib\/timezone'/.test(src)
check('every lib/timezone fmtTime / fmtDate / fmtDateTime on a screen passes the app locale',
  offenders(/\bfmt(Time|Date|DateTime)\((?:[^(),]|\([^()]*\))+\)/, [], usesTzFormatters), [])

// The Schedule tab is "Agenda" in Spanish, like Portuguese; "horario" is left
// only where it means working hours ("Tu horario semanal") (2026-10-20).
check('es: the Schedule tab and its heading say agenda', [T.es.schedule, T.es.my_schedule], ['Agenda', 'Mi agenda'])
check('es: "horario" only for working hours',
  Object.entries(T.es).filter(([, v]) => /horario/i.test(String(v)) && !/horario semanal/i.test(String(v))).map(([k]) => k), [])
// A job's property line agrees with its numbers: "1 baño", "3 baños", "🛏 1 cama".
check('property counts: one and many in every language',
  ['en', 'es', 'pt'].map(L => [T[L].baths_short_one, T[L].baths_short, T[L].beds_total_short_one, T[L].beds_total_short]),
  [['bath', 'bath', 'bed', 'beds'], ['baño', 'baños', 'cama', 'camas'], ['banh', 'banh', 'cama', 'camas']])
{
  const job = readFileSync(join(repo, 'src/screens/JobDetailScreen.tsx'), 'utf8')
  check('the job screen picks the _one word when the count is 1',
    [/Number\(propMeta\.bathrooms\) === 1 \? 'baths_short_one' : 'baths_short'/.test(job),
     /Number\(propMeta\.beds\) === 1 \? 'beds_total_short_one' : 'beds_total_short'/.test(job)], [true, true])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
