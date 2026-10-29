#!/usr/bin/env node
// Chat's Direct message tab: the newest conversation on top (src/lib/chatList.ts).
//
// True Shine Cleaning (2026-10-29): teammates sat A–Z with their DM hung off
// their row, so a new message never moved up; group chats were not listed.
//
// Runs the REAL src/lib/chatList.ts under Node's type stripping (it is pure)
// and checks:
//   • DMs and groups with a message come first, newest on top; team channels,
//     groups the viewer is not in, and DMs with someone off the crew list don't;
//   • everyone else follows A–Z as loaded, each person once, under a label
//     shown only when both sections have rows;
//   • a DM with no message yet leaves the person in the bottom section;
//   • a pair's two DMs show once, as the one openDM opens;
// and, in the screen, that the tab renders these rows, a group opens itself and
// a person opens through openDM, and the label goes through t().
//
// Usage: node scripts/test-chat-list.mjs
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
const { dmListRows } = await import(join(repo, 'src/lib/chatList.ts'))

const ME = 'me'
const person = (id, full_name) => ({ id, full_name, nickname: null, role: 'cleaner', avatar_url: null })
// Active crew, A–Z by full_name as ChatListScreen loads them.
const crew = [person('ana', 'Ana Ruiz'), person('beto', 'Beto Diaz'), person('carla', 'Carla Fox'), person('dee', 'Dee Hill'), person('eli', 'Eli Moss')]
const at = h => `2026-10-29T${String(h).padStart(2, '0')}:00:00.000+00:00`
const dm = (id, other, h) => ({ id, channel_type: 'dm', name: null, participant_ids: [ME, other], last_message: h == null ? null : `hi from ${other}`, last_message_at: h == null ? null : at(h) })
const group = (id, name, members, h) => ({ id, channel_type: 'group', name, participant_ids: members, last_message: h == null ? null : 'see you there', last_message_at: h == null ? null : at(h) })
// Server order: last_message_at desc, nulls last.
const byServer = list => [...list].sort((a, b) => (b.last_message_at ? Date.parse(b.last_message_at) : 0) - (a.last_message_at ? Date.parse(a.last_message_at) : 0))
const show = rows => rows.map(r => r.type === 'label' ? 'label' : r.type === 'person' ? `person:${r.person.id}` : `${r.type}:${r.channel.id}`)

const channels = byServer([
  { id: 'team', channel_type: 'team', name: 'general', participant_ids: [], last_message: 'morning', last_message_at: at(17) },
  dm('dm-gone', 'left-the-company', 16),                       // not on the active crew list
  group('g-other', 'Office only', ['beto', 'carla', 'dee'], 15), // the viewer is not in it
  dm('dm-eli', 'eli', 14),
  group('g-weekend', 'Weekend crew', [ME, 'ana', 'dee'], 12),
  dm('dm-beto', 'beto', 9),
  dm('dm-beto-old', 'beto', 8),                                // a pair's second DM
  dm('dm-carla', 'carla', null),                               // opened, never written in
  group('g-empty', 'Not yet', [ME, 'eli', 'dee'], null),
])

const rows = dmListRows(channels, crew, ME)
check('newest conversation on top, then a label, then everyone else A–Z', show(rows),
  ['dm:dm-eli', 'group:g-weekend', 'dm:dm-beto', 'label', 'person:ana', 'person:carla', 'person:dee'])
check('every teammate appears exactly once', crew.map(p => rows.filter(r => r.person?.id === p.id).length), [1, 1, 1, 1, 1])
check('team channels stay on their own tab', show(rows).includes('dm:team') || show(rows).includes('group:team'), false)
check('a group the viewer is not in is not listed', show(rows).includes('group:g-other'), false)
check('a DM with someone off the crew list is not listed (as before)', show(rows).includes('dm:dm-gone'), false)
check('a DM never written in leaves the person below the label', show(rows).indexOf('person:carla') > show(rows).indexOf('label'), true)
{
  // openDM: channels.find(dm with both) in load order.
  const opens = channels.find(c => c.channel_type === 'dm' && c.participant_ids.includes(ME) && c.participant_ids.includes('beto'))
  check("a pair's two DMs show once, as the one openDM opens", rows.filter(r => r.person?.id === 'beto').map(r => r.channel?.id), [opens.id])
}
check('row keys are unique', new Set(rows.map(r => r.id)).size, rows.length)

// Dee writes: her chat jumps to the top, out of the bottom section.
const afterDee = byServer([...channels, dm('dm-dee', 'dee', 18)])
check('a new message moves that chat to the top', show(dmListRows(afterDee, crew, ME)),
  ['dm:dm-dee', 'dm:dm-eli', 'group:g-weekend', 'dm:dm-beto', 'label', 'person:ana', 'person:carla'])
// Order comes from the times, not from the order the rows arrived in.
check('sorted by last_message_at even if loaded out of order', show(dmListRows([...channels].reverse(), crew, ME)).slice(0, 3),
  ['dm:dm-eli', 'group:g-weekend', 'dm:dm-beto'])

check('no conversations yet: everyone A–Z, no label', show(dmListRows([], crew, ME)),
  ['person:ana', 'person:beto', 'person:carla', 'person:dee', 'person:eli'])
const everyone = byServer(crew.map((p, i) => dm(`dm-${p.id}`, p.id, i + 1)))
check('a conversation with everyone: no label', show(dmListRows(everyone, crew, ME)),
  ['dm:dm-eli', 'dm:dm-dee', 'dm:dm-carla', 'dm:dm-beto', 'dm:dm-ana'])
check('only a group, no other crew: the group, no label', show(dmListRows([group('g', 'Two of us', [ME, 'x'], 3)], [], ME)), ['group:g'])
check('nothing at all: empty (the screen shows "No other crew members")', dmListRows([], [], ME), [])

// ── the screen ──────────────────────────────────────────────────────────────
const screen = readFileSync(join(repo, 'src/screens/ChatScreens.tsx'), 'utf8')
check('the Direct message tab renders dmListRows', [/const dmRows = dmListRows\(channels, crew, user\.id\)/.test(screen), /data=\{dmRows\}/.test(screen), /data=\{crew\}/.test(screen)], [true, true, false])
check('a group row opens the group under its name', /onOpenChannel\(\{ \.\.\.item\.channel, displayName: getDMName\(item\.channel\) \}\)/.test(screen), true)
check('a person row opens through openDM', /onPress=\{\(\) => openDM\(person\)\}/.test(screen), true)
check('the label goes through t()', /t\('chat_start_a_conversation'\)/.test(screen), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
