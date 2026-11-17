#!/usr/bin/env node
// "Can't finish today" on a started clean (CKS Perfections, 2026-11-16; web
// repo 20261117140100_clean_unfinished).
//
// Runs the REAL src/lib/unfinishedReason.ts and src/lib/pauseReason.ts under
// Node's type stripping (both pure), and checks:
//   • the six reasons are the server's keys (job_unfinished_marks.reason) in
//     the order the crew see them, each with a label in English, Spanish and
//     Portuguese;
//   • the button shows on a started clean only, and not once it's paused;
//   • the paused line: "Paused" until the office sets the day, "Paused ·
//     finishing Tue 9:30 AM" once the clean sits on a later day (in the
//     clean's own zone, in the crew's language);
//   • the note a per-clean punch gets ("Can't finish today") is translated on
//     the time list, like every pause note;
// and, in the screens, that the clean screen calls the two server functions
// with their parameter names, stops this person's own clock first on a
// per-clean clock, asks with all six reasons and a note, and that Home asks
// before End my day with a started clean still open.
//
// Usage: node scripts/test-unfinished.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const U = await import(join(repo, 'src/lib/unfinishedReason.ts'))
const { pauseReasonLabel } = await import(join(repo, 'src/lib/pauseReason.ts'))
const { translations } = await import(join(repo, 'src/lib/i18n.ts'))
const read = p => readFileSync(join(repo, p), 'utf8')

// ── The reasons ─────────────────────────────────────────────────────────────
check('the six reasons, the server\'s keys, in order',
  U.UNFINISHED_REASONS.map(r => r.value), ['out_of_time', 'waiting_access', 'supplies', 'maintenance', 'guest_still_there', 'other'])
for (const lang of ['en', 'es', 'pt']) {
  const missing = U.UNFINISHED_REASONS.filter(r => !translations[lang][r.key]).map(r => r.key)
  check(`every reason has a ${lang} label`, missing, [])
  const keys = ['cant_finish', 'cant_finish_title', 'cant_finish_hint', 'cant_finish_pick', 'cant_finish_note_ph', 'cant_finish_send',
    'cant_finish_sent', 'cant_finish_offline', 'paused_finishing', 'continue_clean', 'paused_clean_banner', 'end_day_open_clean', 'pr_cant_finish']
  check(`…and every other word of it in ${lang}`, keys.filter(k => !translations[lang][k]), [])
}
check('End my day names the place ({place})', ['en', 'es', 'pt'].every(l => translations[l].end_day_open_clean.includes('{place}')), true)

// ── When it's offered, and the paused line ──────────────────────────────────
const TZ = 'America/Phoenix'
const NOW = new Date('2026-11-16T21:56:00Z')   // 2:56 PM in Phoenix, Krystal's end of day
const clean = { status: 'in_progress', job_type: 'clean', scheduled_start: '2026-11-16T18:30:00Z' }
check('offered on a started clean', U.canMarkUnfinished(clean, null), true)
check('…not once it is paused', U.canMarkUnfinished(clean, '2026-11-16T21:40:00Z'), false)
check('…not before it starts, nor once it is done', [U.canMarkUnfinished({ ...clean, status: 'scheduled' }, null), U.canMarkUnfinished({ ...clean, status: 'completed' }, null)], [false, false])
check('…not on a task, an inspection or a laundry run', ['task', 'inspection', 'laundry_run'].map(k => U.canMarkUnfinished({ ...clean, job_type: k }, null)), [false, false, false])
check('a row with no job_type is a clean', U.canMarkUnfinished({ status: 'in_progress' }, null), true)

const words = { paused: 'Paused', finishing: 'finishing' }
check('paused and not moved yet: "Paused"', U.pausedText(clean, '2026-11-16T21:40:00Z', TZ, words, 'en-US', NOW), 'Paused')
const moved = { ...clean, scheduled_start: '2026-11-17T16:30:00Z' }   // Tue 9:30 AM Phoenix
check('moved to tomorrow: "Paused · finishing Tue 9:30 AM"', U.pausedText(moved, '2026-11-16T21:40:00Z', TZ, words, 'en-US', NOW), 'Paused · finishing Tue 9:30 AM')
check('…in Spanish', U.pausedText(moved, '2026-11-16T21:40:00Z', TZ, { paused: 'En pausa', finishing: 'se termina' }, 'es-MX', NOW).startsWith('En pausa · se termina mar'), true)
check('not paused: no line', U.pausedText(moved, null, TZ, words, 'en-US', NOW), null)
check('finished: no line, whatever the column says', U.pausedText({ ...moved, status: 'completed' }, '2026-11-16T21:40:00Z', TZ, words, 'en-US', NOW), null)
// 6:30 PM Phoenix on 11/16 is 01:30Z on 11/17: the clean's own zone decides the day
const lateSameDay = { ...clean, scheduled_start: '2026-11-17T01:30:00Z' }
check("a later time the same day (in the clean's zone) is not \"finishing\"", U.finishingAt(lateSameDay, TZ, NOW), null)

// ── The pause note on the time list ─────────────────────────────────────────
const tEn = k => translations.en[k], tEs = k => translations.es[k], tPt = k => translations.pt[k]
check('the punch note is translated', [pauseReasonLabel(U.CANT_FINISH_PAUSE_NOTE, tEn), pauseReasonLabel(U.CANT_FINISH_PAUSE_NOTE, tEs), pauseReasonLabel(U.CANT_FINISH_PAUSE_NOTE, tPt)],
  ["Can't finish today", 'No se pudo terminar hoy', 'Não deu para terminar hoje'])
check('…the same words the web crew view writes', read('src/lib/unfinishedReason.ts').includes(`CANT_FINISH_PAUSE_NOTE = "Can't finish today"`), true)

// ── The screens ─────────────────────────────────────────────────────────────
const job = read('src/screens/JobDetailScreen.tsx')
check('the clean screen marks it through the server, with its parameter names',
  /supabase\.rpc\('mark_clean_unfinished', \{\s*p_job_id: job\.id, p_reason: cantReason, p_note:/.test(job), true)
check('…and picks it back up there (Continue on a day shift, Resume on a per-clean clock)',
  (job.match(/supabase\.rpc\('resume_unfinished_clean', \{ p_job_id: job\.id \}\)/g) ?? []).length, 2)
const confirm = job.slice(job.indexOf('async function confirmCantFinish'), job.indexOf('async function handleContinueDaily'))
check("on a per-clean clock it stops this person's own running clock first, noted Can't finish today",
  [confirm.includes("!dailyMode && activeEntry && activeEntry.user_id === user.id"), confirm.includes('pause_reason: CANT_FINISH_PAUSE_NOTE'),
   confirm.indexOf('writeThrough(') < confirm.indexOf("rpc('mark_clean_unfinished'")], [true, true, true])
check('the ask lists all six reasons and takes a note', [job.includes('{UNFINISHED_REASONS.map(({ value, key }) =>'), job.includes("placeholder={t('cant_finish_note_ph')}")], [true, true])
check('the paused state is read on its own (never in another read of the clean)',
  job.includes("supabase.from('jobs').select('unfinished_at').eq('id', job.id).maybeSingle()"), true)
const home = read('src/screens/DashboardScreen.tsx')
check('Home asks before End my day when a started clean of mine is still open',
  [home.includes("ti(t('end_day_open_clean'), { place })"), home.includes('onPress: () => onJobPress(openClean)'), home.includes('function confirmEndDay()')], [true, true, true])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
