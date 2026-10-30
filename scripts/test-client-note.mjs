#!/usr/bin/env node
// The crew's note for the client (jobs.guest_ready_note), CKS 2026-10-29.
//
// Runs the REAL src/lib/clientNote.ts under Node's type stripping and checks:
//   • the box is on cleans not finished yet, not on tasks or inspections;
//   • an empty box adds nothing to the write, so it can't wipe a note the
//     office wrote; a note is saved trimmed; a phone's own earlier save can be
//     taken back;
// and, in the job screen, that:
//   • the note rides the ONE write that completes the clean, because
//     fn_auto_guest_ready reads it from that write and only then;
//   • a held clean saves it BEFORE the hold, because the server completes the
//     clean on its last photo, maybe while the hold is still being asked for;
//   • the card says who reads it, and the office's notes card says it's the
//     office's; English, Spanish and Portuguese have the wording.
//
// Usage: node scripts/test-client-note.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const { takesClientNote, clientNoteValues } = await import(join(repo, 'src/lib/clientNote.ts'))

console.log('\nwhere the box shows')
check('a clean under way', takesClientNote({ job_type: 'clean', status: 'in_progress' }), true)
check('a clean read without job_type (older rows)', takesClientNote({ status: 'in_progress' }), true)
check('a finished clean: Complete is gone, nothing would save it', takesClientNote({ job_type: 'clean', status: 'completed' }), false)
check('a task, an inspection, a laundry run', ['task', 'inspection', 'laundry_run'].map(t => takesClientNote({ job_type: t, status: 'in_progress' })), [false, false, false])
check('no job', takesClientNote(null), false)

console.log('\nwhat the write adds')
check('a note, trimmed', clientNoteValues('  Left extra towels \n'), { guest_ready_note: 'Left extra towels' })
check('an empty box: nothing, the stored note stands', clientNoteValues(''), {})
check('only spaces: nothing', clientNoteValues('  \n '), {})
check('cleared after this phone saved one: taken back', clientNoteValues(' ', true), { guest_ready_note: null })
check('typed again after that save: the new text', clientNoteValues('Late checkout', true), { guest_ready_note: 'Late checkout' })

console.log('\nthe job screen')
const screen = read('src/screens/JobDetailScreen.tsx')
const send = screen.slice(screen.indexOf('async function sendComplete'), screen.indexOf('const completedCount ='))
check('Complete: the note rides the one writeThrough that completes the clean',
  /writeThrough\(\{\s*table: 'jobs', op: 'update', match: \{ id: job\.id \},\s*values: \{\s*status: 'completed',[\s\S]*?\.\.\.clientNoteValues\(clientNote, clientNoteSavedRef\.current\),[\s\S]*?\}\s*,?\s*\}\)/.test(send), true)
const held = screen.slice(screen.indexOf('async function completeHeldJob'), screen.indexOf('function alertCheckFirst'))
const at = (needle) => held.indexOf(needle)
check('a held clean: the note is written before the hold is asked for',
  at('clientNoteValues(clientNote') > -1 && at('clientNoteValues(clientNote') < at('await askToHold(true'), true)
check('…and a refused note stops there, before the clock-out',
  at("values: noteFirst })") < at('await clockOutActive()') && /values: noteFirst \}\)\s*if \(error\) \{ setSaving\(false\); Alert\.alert\(t\('error'\), error\.message\); return \}/.test(held), true)
check('no other write names the column', (screen.match(/guest_ready_note\s*:/g) || []).length, 0)
check('the box: started, editable, and a clean takesClientNote says yes',
  screen.includes("{isStarted && !readOnly && takesClientNote(job) && ("), true)
const card = screen.slice(screen.indexOf("t('client_note_title')") - 80, screen.indexOf("t('client_note_title')") + 500)
check('the card says who reads it, above the box',
  card.indexOf("t('client_note_hint')") > -1 && card.indexOf("t('client_note_hint')") < card.indexOf('<TextInput'), true)
check('the office card is named for the office', screen.includes("{t('notes_for_office')}"), true)

const i18n = read('src/lib/i18n.ts')
check('English, Spanish and Portuguese', ['notes_for_office:', 'client_note_title:', 'client_note_hint:', 'client_note_ph:'].map(k => (i18n.match(new RegExp(`\\b${k} '`, 'g')) || []).length), [3, 3, 3, 3])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
