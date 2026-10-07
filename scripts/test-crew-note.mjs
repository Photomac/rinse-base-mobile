#!/usr/bin/env node
// "Show at clock-in" crew note (rinse-base-app migration 20261007160000).
//
// Runs the REAL src/lib/crewNote.ts under Node's type stripping, with
// AsyncStorage and ./supabase redirected to in-memory stand-ins, and checks:
//   • which note is asked at clock-in, and the "Got it" row's shape;
//   • "Got it" with signal is sent at once, as INSERT … ON CONFLICT DO NOTHING;
//   • with no signal it is remembered on the device AND parked, survives
//     another offline flush, and is sent by the first flush with signal;
//   • a refused row is dropped, never retried forever;
// and, in JobDetailScreen.tsx, that both starts (clock-in, daily start) wait for
// "Got it", that the acknowledgment never goes through the pay outbox, and that
// a clean already under way asks with no way to skip.
//
// Usage: node scripts/test-crew-note.mjs
import { registerHooks } from 'node:module'
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

// ── stand-ins ────────────────────────────────────────────────────────────────
const store = new Map()
globalThis.__asyncStorage = {
  getItem: async (k) => (store.has(k) ? store.get(k) : null),
  setItem: async (k, v) => { store.set(k, v) },
}
const calls = []
let answer = { error: null, status: 201 }
globalThis.__supabase = {
  from: (table) => ({ upsert: async (row, opts) => { calls.push({ table, row, opts }); return answer } }),
}
const mod = (src) => ({ url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true })
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@react-native-async-storage/async-storage') return mod('export default globalThis.__asyncStorage')
    if (spec === './supabase') return mod('export const supabase = globalThis.__supabase')
    return next(spec, ctx)
  },
})
const lib = await import(join(repo, 'src/lib/crewNote.ts'))

// ── rules ────────────────────────────────────────────────────────────────────
const NOTE = 'Jessi - please launder Katie’s new green bedding and put on their bed. They arrive the 19th.'
check('clock-in note only with the switch on, trimmed',
  [lib.clockInNote({ crew_note: ` ${NOTE} `, crew_note_at_clock_in: true }), lib.clockInNote({ crew_note: NOTE, crew_note_at_clock_in: false }), lib.clockInNote({ crew_note: '  ', crew_note_at_clock_in: true }), lib.clockInNote(null)],
  [NOTE, null, null, null])
check('the note shown on the clean does not need the switch', lib.crewNoteText({ crew_note: NOTE }), NOTE)
const row = lib.ackRow({ tenantId: 't', jobId: 'job-190', userId: 'jessi', note: NOTE, at: new Date('2026-10-17T13:02:00Z') })
check('the "Got it" row: exactly the columns crew may insert', row,
  { tenant_id: 't', job_id: 'job-190', user_id: 'jessi', note: NOTE, acknowledged_at: '2026-10-17T13:02:00.000Z' })

// ── with signal ──────────────────────────────────────────────────────────────
answer = { error: null, status: 201 }
await lib.recordAck(row)
check('with signal: sent at once, insert-only and idempotent',
  calls.map((c) => [c.table, c.opts]), [['job_crew_note_acks', { onConflict: 'job_id,user_id,note_md5', ignoreDuplicates: true }]])
check('with signal: remembered on the device, nothing parked',
  [await lib.localAcks('job-190', 'jessi'), store.get('dataCache:crewNoteAckPending') ?? null], [[NOTE], null])

// ── no signal ────────────────────────────────────────────────────────────────
calls.length = 0
const row2 = lib.ackRow({ tenantId: 't', jobId: 'job-191', userId: 'jessi', note: 'Towels too', at: new Date('2026-10-17T15:00:00Z') })
answer = { error: { message: 'TypeError: Network request failed' }, status: 0 }
await lib.recordAck(row2)
check('no signal: remembered on the device at once (the window won\'t come back)', await lib.localAcks('job-191', 'jessi'), ['Towels too'])
check('no signal: parked in its own list', JSON.parse(store.get('dataCache:crewNoteAckPending')), [row2])
await lib.flushAcks()
check('still no signal: kept for later', JSON.parse(store.get('dataCache:crewNoteAckPending')), [row2])
answer = { error: null, status: 201 }
await lib.flushAcks()
check('signal back: sent, and the list is empty', [calls.length, calls.at(-1).row, JSON.parse(store.get('dataCache:crewNoteAckPending'))], [3, row2, []])

// ── refused ──────────────────────────────────────────────────────────────────
calls.length = 0
answer = { error: { message: 'new row violates row-level security policy' }, status: 403 }
const warn = console.warn; console.warn = () => {}
await lib.recordAck(lib.ackRow({ tenantId: 't', jobId: 'job-192', userId: 'jessi', note: 'x' }))
check('refused: not parked (no retry loop)', JSON.parse(store.get('dataCache:crewNoteAckPending')), [])
store.set('dataCache:crewNoteAckPending', JSON.stringify([row2]))
await lib.flushAcks()
console.warn = warn
check('refused on a later flush: dropped', JSON.parse(store.get('dataCache:crewNoteAckPending')), [])
check('the device memory is under the prefix sign-out clears', [...store.keys()].every((k) => k.startsWith('dataCache:')), true)

// ── JobDetailScreen ──────────────────────────────────────────────────────────
const screen = readFileSync(join(repo, 'src/screens/JobDetailScreen.tsx'), 'utf8')
const fn = (name) => { const i = screen.indexOf(`function ${name}(`); return i < 0 ? '' : screen.slice(i, screen.indexOf('\n  }\n', i)) }
const clockIn = fn('handleClockIn')
check('clock-in: the punch waits for "Got it"',
  clockIn.indexOf('crewNoteNeedsAck') > 0 && clockIn.indexOf('setNotePrompt({ then: () => clockInAs(null) })') > 0
    && clockIn.indexOf('crewNoteNeedsAck') < clockIn.lastIndexOf('clockInAs(null)'), true)
check('daily start: same window, and the button uses it',
  [/setNotePrompt\(\{ then: startJobDaily \}\)/.test(fn('handleStartDaily')), /onPress=\{handleStartDaily\}/.test(screen), /onPress=\{startJobDaily\}/.test(screen)], [true, true, false])
check('a clean already under way asks with no "Not yet"', /if \(crewNoteNeedsAck && isStarted && !recordsForOthers[^)]*\)\s*\{\s*setNotePrompt\(p => p \?\? \{ then: null \}\)/.test(screen), true)
check('"Not yet" only when a start is waiting', /onNotYet=\{notePrompt\?\.then \? \(\) => setNotePrompt\(null\) : null\}/.test(screen), true)
check('the acknowledgment never goes through the pay outbox', /writeThrough\(\{\s*table: 'job_crew_note_acks'/.test(screen), false)
check('the note is read on its own, failing soft', /cachedQuery\(`crewnote:\$\{job\.id\}`, supabase\.from\('jobs'\)\s*\.select\('crew_note, crew_note_at_clock_in'\)/.test(screen), true)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
