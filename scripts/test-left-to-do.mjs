#!/usr/bin/env node
// "Left to do" on a paused clean (CKS Perfections, Catherine 2026-11-18: "When
// someone taps Continue the next day, will they see what is left to do
// first?"; web repo 20261119140000_clean_unfinished_handover).
//
// Runs the REAL src/lib/leftToDo.ts under Node's type stripping (pure), and
// checks:
//   • rooms group as the checklist card always grouped them: walking order,
//     Extra tasks first, items with no room under Other last, a room with
//     only photos to take still shows;
//   • a room is done by the card's own rule (every line ticked or answered,
//     or signed off as a whole with its questions answered, and its required
//     photos taken; a photo it doesn't owe doesn't count);
//   • the list names each unfinished room with what's left, and skips done
//     rooms and rooms with nothing countable;
// and, in the screen, that the checklist card and the paused card read the
// same helpers, that the paused card asks unfinished_clean_handover for why
// and the note, and that every new string is in English, Spanish and
// Portuguese.
//
// Usage: node scripts/test-left-to-do.mjs
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
const L = await import(join(repo, 'src/lib/leftToDo.ts'))
const { translations } = await import(join(repo, 'src/lib/i18n.ts'))
const read = p => readFileSync(join(repo, p), 'utf8')

const EXTRA = 'Extra tasks'
const rooms = [
  { id: 'k', name: 'Kitchen', room_type: 'kitchen', instance_no: 1 },
  { id: 'b1', name: '', room_type: 'bedroom', instance_no: 1 },
  { id: 'b2', name: null, room_type: 'bedroom', instance_no: 2 },
  { id: 'ba2', name: '', room_type: 'bathroom', instance_no: 2, execution_mode: 'room_complete' },
  { id: 'lr', name: '', room_type: 'laundry_room', instance_no: 1 },
  { id: 'patio', name: 'Patio', room_type: 'outdoor', instance_no: 1 },
]
const items = [
  { id: 'k1', room_uid: 'k', item_kind: 'task' },
  { id: 'k2', room_uid: 'k', item_kind: 'task' },
  { id: 'k3', room_uid: 'k', item_kind: 'verify', result: null },
  { id: 'b1a', room_uid: 'b1', item_kind: 'task' },
  { id: 'b2a', room_uid: 'b2', item_kind: 'task' },
  { id: 'ba2a', room_uid: 'ba2', item_kind: 'task' },
  { id: 'ba2q', room_uid: 'ba2', item_kind: 'task', question: 'number', answer: null },
  { id: 'lr1', room_uid: 'lr', item_kind: 'verify', result: 'issue' },
  { id: 'x1', room: EXTRA, item_kind: 'task' },
  { id: 'o1', room: 'Garage', item_kind: 'task' },
]
const evidence = [
  { id: 'e1', room_id: 'patio', required: true, photo_url: null },
  { id: 'e2', room_id: 'b1', required: true, photo_url: null },
  { id: 'e3', room_id: 'b1', required: true, photo_url: 'x.jpg' },
  { id: 'e4', room_id: 'k', required: true, photo_url: null }, // not owed below
  { id: 'e5', room_id: 'k', required: false, photo_url: null },
]
const deps = (over = {}) => ({
  checked: {},
  evidence,
  signoffs: {},
  notOwed: (id, required) => required && id === 'e4',
  questionType: i => i.question ?? null,
  ...over,
})

// ── Grouping ────────────────────────────────────────────────────────────────
const shown = L.groupRooms(rooms, items, evidence, 'detailed', EXTRA)
check('walking order, Extra tasks first, Other last; a room with only photos (Patio) shows, an empty one would not',
  shown.map(g => g.name), [EXTRA, 'Kitchen', 'Primary Bedroom', 'Bedroom 2', 'Bathroom 2', 'Laundry Room', 'Patio', 'Other'])
check('…a room\'s own mode, else the company default', shown.map(g => g.mode),
  ['detailed', 'detailed', 'detailed', 'detailed', 'room_complete', 'detailed', 'detailed', 'detailed'])
check('names the owner left blank, as the card always wrote them',
  [L.roomName({ name: '  ', room_type: 'bedroom', instance_no: 1 }), L.roomName({ room_type: 'bathroom', instance_no: 3 }),
   L.roomName({ room_type: 'final', instance_no: 1 }), L.roomName({ room_type: 'living', instance_no: 1 }),
   L.roomName({ room_type: 'mud_room', instance_no: 2 }), L.roomName({ name: 'Casita', room_type: 'bedroom', instance_no: 1 })],
  ['Primary Bedroom', 'Bathroom 3', 'Final Guest-Ready Check', 'Living Room', 'Mud Room 2', 'Casita'])
check('no rooms on the property: every item under Other (extra tasks still first)',
  L.groupRooms([], items.slice(0, 2).concat([{ id: 'x', room: EXTRA }]), [], 'detailed', EXTRA).map(g => `${g.name}:${g.items.length}`),
  [`${EXTRA}:1`, 'Other:2'])

// ── The done rule ───────────────────────────────────────────────────────────
const kitchen = shown.find(g => g.key === 'k')
check('a line-by-line room is done when every task is ticked and every check answered',
  [L.roomState(kitchen, deps()).complete, L.roomState(kitchen, deps({ checked: { k1: true, k2: true } })).complete,
   L.roomState({ ...kitchen, items: kitchen.items.map(i => i.id === 'k3' ? { ...i, result: 'ok' } : i) }, deps({ checked: { k1: true, k2: true } })).complete],
  [false, false, true])
check('…a required photo it doesn\'t owe (added after clock-in) and an optional one don\'t hold it',
  L.roomState(kitchen, deps({ checked: { k1: true, k2: true, k3: true } })).req, { total: 0, done: 0 })
const bath = shown.find(g => g.key === 'ba2')
check('a room signed off as a whole: the sign-off AND its questions',
  [L.roomState(bath, deps()).complete, L.roomState(bath, deps({ signoffs: { ba2: 'x' } })).complete,
   L.roomState({ ...bath, items: bath.items.map(i => i.id === 'ba2q' ? { ...i, answer: '2' } : i) }, deps({ signoffs: { ba2: 'x' } })).complete],
  [false, false, true])
const b1 = shown.find(g => g.key === 'b1')
check('…required photos not taken hold a ticked room', [L.roomState(b1, deps({ checked: { b1a: true } })).complete,
  L.roomState(b1, deps({ checked: { b1a: true }, evidence: evidence.map(e => e.id === 'e2' ? { ...e, photo_url: 'y.jpg' } : e) })).complete], [false, true])
check('…a room with photos only is never green (as the card has it), and is listed only while it owes a photo',
  [L.roomState(shown.find(g => g.key === 'patio'), deps({ evidence: [{ id: 'e1', room_id: 'patio', required: true, photo_url: 'z.jpg' }] })).complete,
   L.leftToDo(L.groupRooms(rooms, [], [{ id: 'e1', room_id: 'patio', required: true, photo_url: 'z.jpg' }], 'detailed', EXTRA),
     deps({ evidence: [{ id: 'e1', room_id: 'patio', required: true, photo_url: 'z.jpg' }] })).rooms.length],
  [false, 0])

// ── The list ────────────────────────────────────────────────────────────────
const someDone = deps({ checked: { x1: true, k1: true, k2: true, k3: true, b2a: true, o1: true }, signoffs: {} })
const left = L.leftToDo(shown, someDone)
check('what\'s left, room by room, in walking order (done rooms skipped)',
  left.rooms.map(r => [r.name, r.itemsLeft, r.photosLeft, r.needsSignoff, r.questionsLeft]),
  [['Primary Bedroom', 1, 1, false, 0], ['Bathroom 2', 0, 0, true, 1], ['Laundry Room', 0, 0, false, 0], ['Patio', 0, 1, false, 0]]
    .filter(r => r[0] !== 'Laundry Room'))
check('…a check answered "issue" counts as answered (the room is done); the counts add up',
  [left.roomsDone, left.roomsTotal, left.photosLeft], [5, 8, 2])
check('nothing ticked yet: every room is listed but Laundry Room (its one check was already answered "issue")',
  L.leftToDo(shown, deps()).rooms.map(r => r.name), [EXTRA, 'Kitchen', 'Primary Bedroom', 'Bedroom 2', 'Bathroom 2', 'Patio', 'Other'])
check('every line ticked, signed off, photos taken: only the unanswered question is left', L.leftToDo(shown, deps({
  checked: Object.fromEntries(items.map(i => [i.id, true])), signoffs: { ba2: 'x' },
  evidence: evidence.map(e => ({ ...e, photo_url: 'p.jpg' })),
})).rooms.length, 1) // Bathroom 2's question is still unanswered: a sign-off doesn't answer it
check('…and with the question answered too: nothing left', L.leftToDo(L.groupRooms(rooms, items.map(i => i.id === 'ba2q' ? { ...i, answer: '1' } : i), evidence, 'detailed', EXTRA), deps({
  checked: Object.fromEntries(items.map(i => [i.id, true])), signoffs: { ba2: 'x' },
  evidence: evidence.map(e => ({ ...e, photo_url: 'p.jpg' })),
})).rooms, [])

// ── The screen ──────────────────────────────────────────────────────────────
const screen = read('src/screens/JobDetailScreen.tsx')
check('the checklist card and the paused card read the same helpers (no second copy of the rule)',
  [screen.includes("const shown = groupRooms(roomsMeta, roomChecklist, evidence, defaultMode, EXTRA_TASKS_ROOM)"),
   screen.includes("const stateOf = (g: any) => roomState(g, { checked, evidence, signoffs, notOwed, questionType })"),
   screen.includes('groupRooms(roomsMeta, roomChecklist, evidence, defaultMode, EXTRA_TASKS_ROOM),\n                    { checked, evidence, signoffs, notOwed, questionType })'),
   /const doneTasks = tasks\.filter/.test(screen)],
  [true, true, true, false])
check('the paused card asks the server why, with its parameter name, only while paused',
  [screen.includes("supabase.rpc('unfinished_clean_handover', { p_job_id: job.id })"),
   screen.includes("if (job.status !== 'in_progress' || !unfinishedAt) { setHandover(null); return }")], [true, true])
check('…an error (no signal, a server without the function yet) leaves the box without it, not broken',
  screen.includes('.then(({ data, error }: any) => { if (live && !error) setHandover((data as any)?.mark ?? null) })'), true)
check('…the note is translated for whoever reads it, like the office notes', screen.includes('    handover?.note,\n    ...(checkFirst?.lines ?? []).map(l => l.body),\n  ])'), true)
check('…the reason uses the six reasons\' own labels', screen.includes('UNFINISHED_REASONS.find(r => r.value === handover.reason)?.key'), true)

const KEYS = ['left_why', 'left_to_do', 'left_rooms_done', 'left_to_do_none', 'left_items', 'left_signoff', 'left_questions', 'left_photos']
check('every new string in English, Spanish and Portuguese',
  ['en', 'es', 'pt'].map(l => KEYS.filter(k => !(translations[l] ?? {})[k])), [[], [], []])
check('…the counts keep their placeholders in each language',
  ['en', 'es', 'pt'].map(l => [translations[l].left_rooms_done.includes('{{done}}') && translations[l].left_rooms_done.includes('{{total}}'),
    ['left_items', 'left_questions', 'left_photos'].every(k => translations[l][k].includes('{{n}}'))]), [[true, true], [true, true], [true, true]])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
