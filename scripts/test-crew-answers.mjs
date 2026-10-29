#!/usr/bin/env node
// Accept / decline a clean you were given (src/lib/crewAnswers.ts).
//
// Runs the REAL src/lib/crewAnswers.ts under Node's type stripping (it is
// pure) and checks:
//   • only someone on the clean, while it is pending or scheduled, is asked;
//   • an accepted clean stops asking, an unanswered one keeps asking;
//   • a decline needs a reason, and words when the reason is Other; the words
//     are squeezed and capped at 500 like the server's;
//   • every server word maps to a message key that exists in en, es and pt;
// and, in the app, that the clean's screen mounts the card, the card answers
// only through the answer_assigned_clean RPC, and Home and Schedule read
// through useAwaitingAnswers().
//
// Usage: node scripts/test-crew-answers.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(repo, p), 'utf8')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const { canAnswer, needsAnswer, cleanNote, declineReady, resultKey, DECLINE_REASONS } = await import(join(repo, 'src/lib/crewAnswers.ts'))

const ME = 'me-0000', OTHER = 'other-0000'
const job = (id, status, crew) => ({ id, status, job_assignments: crew.map(user_id => ({ user_id })) })

// ── who is asked ─────────────────────────────────────────────────────────────
check('on a scheduled clean: asked', canAnswer(job('a', 'scheduled', [ME, OTHER]), ME), true)
check('on a clean waiting on the office: asked', canAnswer(job('b', 'pending_approval', [ME]), ME), true)
for (const s of ['en_route', 'in_progress', 'completed', 'cancelled', 'no_show']) {
  check(`a clean ${s}: not asked`, canAnswer(job('c', s, [ME]), ME), false)
}
check('not on the clean: not asked', canAnswer(job('d', 'scheduled', [OTHER]), ME), false)
check('nobody on it: not asked', canAnswer(job('e', 'scheduled', []), ME), false)
check('no crew list on the row: not asked', canAnswer({ id: 'f', status: 'scheduled' }, ME), false)
check('accepted: no longer waiting', needsAnswer(job('a', 'scheduled', [ME]), ME, new Set(['a'])), false)
check('unanswered: waiting', needsAnswer(job('a', 'scheduled', [ME]), ME, new Set(['z'])), true)

// ── a decline ───────────────────────────────────────────────────────────────
check('the reasons, in the sheet\'s order', [...DECLINE_REASONS], ['sick', 'unavailable', 'no_ride', 'other'])
check('no reason: not ready', declineReady(null, 'words'), false)
check('an unknown reason: not ready', declineReady('bored', 'words'), false)
check('sick, no words: ready', declineReady('sick', ''), true)
check('other, no words: not ready', declineReady('other', ''), false)
check('other, only spaces: not ready', declineReady('other', '   \n '), false)
check('other, with words: ready', declineReady('other', 'Dentist'), true)
check('words squeezed', cleanNote('  feeling \n\n  bad  '), 'feeling bad')
check('words capped at 500', cleanNote('x'.repeat(600)).length, 500)
check('no words: null', cleanNote('   '), null)

// ── the server's words → messages ───────────────────────────────────────────
const i18n = read('src/lib/i18n.ts')
const keyIn = (lang, key) => {
  const start = i18n.indexOf(`\n  ${lang}: {`)
  const end = i18n.indexOf('\n  },', start)
  return start >= 0 && new RegExp(`\\b${key}:`).test(i18n.slice(start, end))
}
for (const code of ['status_not_eligible', 'not_yours', 'not_asked', 'error', 'job_not_found', 'not_crew', 'reason_required', 'something_new']) {
  const key = resultKey(code)
  check(`"${code}" says ${key}, in en, es and pt`, ['en', 'es', 'pt'].every(l => keyIn(l, key)), true)
}

// ── in the app ──────────────────────────────────────────────────────────────
const detail = read('src/screens/JobDetailScreen.tsx')
const card = read('src/components/CrewAnswerCard.tsx')
const hook = read('src/lib/useCrewAnswers.ts')
check('the clean\'s screen mounts the card, going back after a decline',
  /<CrewAnswerCard job=\{job\} user=\{user\} onDeclined=\{onBack\} \/>/.test(detail), true)
check('the card answers only through answer_assigned_clean',
  /rpc\('answer_assigned_clean'/.test(hook) && !/\.from\('job_crew_answers'\)\.(insert|update|upsert|delete)/.test(card + hook), true)
check('nothing about an answer goes into the outbox', /outbox|enqueue/.test(card + hook), false)
check('Home and Schedule read the waiting cleans through useAwaitingAnswers()',
  /useAwaitingAnswers\(user, loads\)/.test(read('src/screens/DashboardScreen.tsx'))
  && /useAwaitingAnswers\(user, loads\)/.test(read('src/screens/ScheduleScreen.tsx')), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
