#!/usr/bin/env node
// The office's "Edit time & crew" on a clean (Z & K Cleaning, 2026-10-27: the
// owner couldn't move a clean or change its crew from the road).
//
// Runs the REAL src/lib/officeEdit.ts (with timezone.ts and jobScope.ts) under
// Node's type stripping and checks:
//   • who gets the button: the office, on a clean that hasn't started;
//   • the rules copied from the web (lead by seniority, the weekly schedule,
//     the property's minimum crew): the same cases here, and, when the web repo
//     is on this machine, the same answers as the web's own code over a grid;
//   • what a draft changes: time, day (company clock, across the November DST
//     change), crew, lead; nothing changed is not a save; an unread time is not;
//   • the warnings and when each applies;
//   • the save, against a fake database: the move is recorded before the clean
//     changes, the clean changes only while it has the start the sheet read and
//     hasn't started, a write that matches nothing closes the record as not made
//     and touches no crew, the crew is rewritten only when it changed, a new day
//     emails people (a same-day move and a crew-only change don't), a failed
//     email never fails the save;
// and, in the screens: nothing goes through the offline outbox, the button and
// the sheet are office-only, every string the sheet uses exists.
//
// Usage: node scripts/test-office-edit.mjs
//   From a worktree, point the parity checks at the web repo:
//   RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-office-edit.mjs
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
// officeEdit imports './jobScope' and './timezone' the way Metro wants them; Node needs the file.
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec === './jobScope' || spec === './timezone') && ctx.parentURL?.includes('/src/lib/')) {
      return next(pathToFileURL(join(repo, 'src/lib', spec.slice(2) + '.ts')).href, ctx)
    }
    return next(spec, ctx)
  },
})
const E = await import(join(repo, 'src/lib/officeEdit.ts'))
const Z = await import(join(repo, 'src/lib/timezone.ts'))
Z.setCurrentTz('America/New_York')

// ── who gets the button ─────────────────────────────────────────────────────
const clean = (status, job_type = 'clean') => ({ status, job_type })
check('owner, manager and dispatcher on a scheduled clean',
  ['owner', 'manager', 'dispatcher'].map(r => E.canEditClean(r, clean('scheduled'))), [true, true, true])
check('crew never', ['lead_cleaner', 'cleaner', 'trainee', 'inspector', null].map(r => E.canEditClean(r, clean('scheduled'))), [false, false, false, false, false])
check('waiting approval and on the way: yes; started, done, cancelled: no',
  ['pending_approval', 'en_route', 'in_progress', 'paused', 'completed', 'cancelled', 'no_show'].map(s => E.canEditClean('owner', clean(s))),
  [true, true, false, false, false, false, false])
check('cleans only: not an inspection, task or laundry run',
  ['inspection', 'task', 'laundry_run'].map(t => E.canEditClean('owner', clean('scheduled', t))), [false, false, false])
check('a row with no job_type is a clean', E.canEditClean('manager', { status: 'scheduled' }), true)

// ── lead ────────────────────────────────────────────────────────────────────
const people = [
  { id: 'kristi', role: 'cleaner' }, { id: 'gina', role: 'lead_cleaner' },
  { id: 'kyle', role: 'owner' }, { id: 'tia', role: 'trainee' }, { id: 'x', role: null },
]
check('the most senior picked leads', E.pickLead(['kristi', 'gina', 'tia'], people), 'gina')
check('a tie goes to the one picked first', E.pickLead(['kristi', 'x', 'tia'], [...people, { id: 'k2', role: 'cleaner' }]), 'kristi')
check('nobody picked: no lead', E.pickLead([], people), '')
check('a chosen lead stands while still picked', E.resolveLead('kristi', ['kristi', 'gina'], people), 'kristi')
check('… and is re-picked once unticked', E.resolveLead('kristi', ['gina', 'tia'], people), 'gina')

// ── weekly schedule ─────────────────────────────────────────────────────────
const mon = [{ day_of_week: 1, is_available: true }]
check('no schedule rows: works any day', E.scheduleOffOn([], '2026-10-29'), null)
check('a day with no row is a day off', E.scheduleOffOn(mon, '2026-10-29'), 'weekday')
check('a ticked day is worked', E.scheduleOffOn(mon, '2026-10-26'), null)
check('an unticked row is a day off', E.scheduleOffOn([{ day_of_week: 4, is_available: false }], '2026-10-29'), 'weekday')
const eow = [{ day_of_week: 4, is_available: true, every_other_week: true, week_anchor: '2026-10-22' }]
check('every other Thursday: the anchor week and two later are worked, the one between is off',
  ['2026-10-22', '2026-10-29', '2026-11-05', '2026-10-15'].map(d => E.scheduleOffOn(eow, d)), [null, 'off_week', null, 'off_week'])

// ── crew size ───────────────────────────────────────────────────────────────
check('the property minimum, cleans only',
  [E.propertyMinCrew({ client_addresses: { min_cleaners: 2 } }), E.propertyMinCrew({ job_type: 'task', client_addresses: { min_cleaners: 2 } }),
    E.propertyMinCrew({ client_addresses: { min_cleaners: null } }), E.propertyMinCrew({ client_addresses: null })],
  [2, null, null, null])
check('the property maximum', [E.propertyMaxCrew({ client_addresses: { max_cleaners: 3 } }), E.propertyMaxCrew({ client_addresses: { max_cleaners: null } })], [3, null])

// ── a Z & K-shaped clean (America/New_York) ─────────────────────────────────
// Fri Oct 30 2026, 10:00 AM–12:30 PM EDT. PostgREST spells times '+00:00'.
const base = {
  id: 'job-1', tenant_id: 'ten-1', status: 'scheduled', job_type: 'clean',
  scheduled_start: '2026-10-30T14:00:00+00:00', scheduled_end: '2026-10-30T16:30:00+00:00',
  manually_retimed_at: null, min_crew: 2, max_crew: 2, is_turnover: true, reservation_id: 'res-1', address_id: 'addr-1',
  client_addresses: { id: 'addr-1', nickname: 'Blue Ridge', street: '1 Main', max_cleaners: 3, min_cleaners: null },
  crew: ['kristi', 'gina'], lead: 'kristi',
}
const d0 = E.draftFrom(base)
check('the sheet opens on the clean: its day, start, length, crew and lead',
  d0, { ymd: '2026-10-30', start: { h: 10, mi: 0 }, minutes: 150, crew: ['kristi', 'gina'], lead: 'kristi' })
check('opened and saved untouched: nothing to save', E.planEdit(base, d0).problem, 'nothing')
check('a time that can\'t be read: no save', E.planEdit(base, { ...d0, start: null }).problem, 'no_time')

const later = E.planEdit(base, { ...d0, start: { h: 13, mi: 0 } })
check('1 PM the same day: a time change, not a day change, no crew change',
  [later.problem, later.newStart, later.newEnd, later.timeChanged, later.dayChanged, later.crewChanged],
  [null, '2026-10-30T17:00:00.000Z', '2026-10-30T19:30:00.000Z', true, false, false])
const longer = E.planEdit(base, { ...d0, minutes: 180 })
check('only longer: a time change (the end moves)', [longer.timeChanged, longer.newEnd], [true, '2026-10-30T17:00:00.000Z'])
// Clocks go back at 2 AM on Sun Nov 1 2026 in New York: 10 AM is 15:00Z, not 14:00Z.
const sunday = E.planEdit(base, { ...d0, ymd: '2026-11-01' })
check('moved to Sunday Nov 1, across the clocks going back: 10 AM there is 15:00Z',
  [sunday.newStart, sunday.dayChanged], ['2026-11-01T15:00:00.000Z', true])
const swapped = E.planEdit(base, { ...d0, crew: ['gina', 'tia'], lead: 'gina' })
check('a crew swap: a crew change only', [swapped.timeChanged, swapped.crewChanged], [false, true])
check('a new lead, same people: a crew change', E.planEdit(base, { ...d0, lead: 'gina' }).crewChanged, true)
check('same people picked in another order: no change', E.planEdit(base, { ...d0, crew: ['gina', 'kristi'] }).problem, 'nothing')
const noLeadBase = { ...base, lead: '' }
check('a clean with crew but no lead flagged, opened and saved untouched: still nothing',
  E.planEdit(noLeadBase, E.draftFrom(noLeadBase)).problem, 'nothing')

check('length steps on the 15-minute grid, from an off-grid length too',
  [E.stepLength(150, 1), E.stepLength(150, -1), E.stepLength(130, 1), E.stepLength(130, -1), E.stepLength(15, -1), E.stepLength(720, 1)],
  [165, 135, 135, 120, 15, 720])

check('crew size on a crew change: no property minimum → min = max = picked',
  E.crewSizeFields(base, 3), { min_crew: 3, max_crew: 3 })
check('… nobody picked → 1', E.crewSizeFields(base, 0), { min_crew: 1, max_crew: 1 })
const minBase = { ...base, min_crew: 2, client_addresses: { ...base.client_addresses, min_cleaners: 2 } }
check('… a property minimum of 2 → max only, never below the minimum', [E.crewSizeFields(minBase, 1), E.crewSizeFields(minBase, 3)], [{ max_crew: 2 }, { max_crew: 3 }])

// ── warnings ────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-29T12:00:00Z')
const quiet = { window: null, timeOffIds: [], scheduleOff: new Map(), nowMs: NOW }
const warn = (draft, inp = {}, b = base) => E.editWarnings(b, draft, E.planEdit(b, draft), { ...quiet, ...inp }).map(w => w.code)
const win = { lo: '2026-10-30', hi: '2026-11-02' }
check('inside the booking window: no warning', warn({ ...d0, ymd: '2026-11-01' }, { window: win }), [])
check('before the guest checks out', warn({ ...d0, ymd: '2026-10-29' }, { window: win }), ['window_before'])
check('after the next guest arrives', warn({ ...d0, ymd: '2026-11-03' }, { window: win }), ['window_after'])
check('no next guest: any later day is fine', warn({ ...d0, ymd: '2026-11-20' }, { window: { lo: '2026-10-30', hi: null } }), [])
check('before 7 AM and from 7 PM', [warn({ ...d0, start: { h: 6, mi: 45 } }), warn({ ...d0, start: { h: 19, mi: 0 } }), warn({ ...d0, start: { h: 18, mi: 59 } })],
  [['off_hours'], ['off_hours'], []])
check('a time already gone', warn({ ...d0, ymd: '2026-10-28' }), ['past'])
const off = { timeOffIds: ['gina'], scheduleOff: new Map([['gina', 'weekday'], ['kristi', 'off_week']]) }
check('a new day: time off and the weekly schedule, each person once',
  E.editWarnings(base, { ...d0, ymd: '2026-10-31' }, E.planEdit(base, { ...d0, ymd: '2026-10-31' }), { ...quiet, ...off }),
  [{ code: 'time_off', ids: ['gina'] }, { code: 'schedule_off', ids: ['kristi'] }])
check('only the hour moves, same day, same crew: no day-off warnings', warn({ ...d0, start: { h: 11, mi: 0 } }, off), [])
check('a person added on their day off', warn({ ...d0, crew: ['kristi', 'gina', 'tia'] }, { timeOffIds: ['tia'] }), ['time_off'])
check('over the property maximum (3)', warn({ ...d0, crew: ['kristi', 'gina', 'tia', 'kyle'] }), ['over_max'])
check('under the property minimum (2)', warn({ ...d0, crew: ['gina'], lead: 'gina' }, {}, minBase), ['under_min'])
check('nobody left on it', warn({ ...d0, crew: [], lead: '' }), ['no_crew'])
check('the max is only about a crew change', warn({ ...d0, start: { h: 11, mi: 0 } }, {}, { ...base, crew: ['a', 'b', 'c', 'd'] }), [])

// ── the save, against a fake database ───────────────────────────────────────
function fakeDb(o = {}) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const q = { table, op: null, values: null, filters: [] }
      const chain = {
        insert(v) { q.op = 'insert'; q.values = v; return chain },
        update(v) { q.op = 'update'; q.values = v; return chain },
        delete() { q.op = 'delete'; return chain },
        select() { return chain },
        eq(c, v) { q.filters.push(['eq', c, v]); return chain },
        in(c, v) { q.filters.push(['in', c, v]); return chain },
        is(c, v) { q.filters.push(['is', c, v]); return chain },
        single() { return chain },
        maybeSingle() { return chain },
        neq(c, v) { q.filters.push(['neq', c, v]); return chain },
        gte(c, v) { q.filters.push(['gte', c, v]); return chain },
        order() { return chain },
        limit() { return chain },
        then(res, rej) {
          calls.push(q)
          const key = `${table}.${q.op}`
          const out = o[key] ? o[key](q) : key === 'job_reschedules.insert' ? { data: { id: 'rec-1' }, error: null }
            : key === 'jobs.update' ? { data: [{ id: 'job-1' }], error: null } : { data: null, error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return chain
    },
    functions: {
      invoke(name, opts) {
        calls.push({ table: `fn:${name}`, op: 'invoke', values: opts.body, filters: [] })
        if (o.invoke) return o.invoke()
        return Promise.resolve({ data: null, error: null })
      },
    },
  }
  return db
}
const shape = calls => calls.map(c => `${c.table}.${c.op}`)
const STAMP = '2026-10-29T12:00:00.000Z'
const save = (db, draft, b = base) => E.saveEdit(db, { base: b, draft, me: 'me-1', newBatchId: () => 'batch-1', now: () => STAMP })

{
  const db = fakeDb()
  const out = await save(db, { ...d0, ymd: '2026-10-31', start: { h: 9, mi: 0 }, crew: ['gina', 'tia'], lead: 'gina' })
  check('day + time + crew: record → clean → crew → email, in that order',
    shape(db.calls), ['job_reschedules.insert', 'jobs.update', 'job_assignments.delete', 'job_assignments.insert', 'fn:notify-reschedule.invoke'])
  check('… the record: who, from when, to when, as the web Edit tab writes it', db.calls[0].values, {
    tenant_id: 'ten-1', job_id: 'job-1', batch_id: 'batch-1', source: 'job_edit',
    old_start: '2026-10-30T14:00:00.000Z', old_end: '2026-10-30T16:30:00.000Z', old_manually_retimed_at: null,
    new_start: '2026-10-31T13:00:00.000Z', new_end: '2026-10-31T15:30:00.000Z', changed_by: 'me-1',
  })
  check('… the clean: new time, held against sync, crew size from the crew picked', db.calls[1].values, {
    min_crew: 2, max_crew: 2, scheduled_start: '2026-10-31T13:00:00.000Z', scheduled_end: '2026-10-31T15:30:00.000Z', manually_retimed_at: STAMP,
  })
  check('… only while it still starts when the sheet read it and hasn\'t started', db.calls[1].filters, [
    ['eq', 'id', 'job-1'], ['eq', 'scheduled_start', '2026-10-30T14:00:00+00:00'], ['in', 'status', ['pending_approval', 'scheduled', 'en_route']],
  ])
  check('… the crew rows, lead marked', db.calls[3].values, [
    { tenant_id: 'ten-1', job_id: 'job-1', user_id: 'gina', is_lead: true },
    { tenant_id: 'ten-1', job_id: 'job-1', user_id: 'tia', is_lead: false },
  ])
  check('… the email is the web drag\'s', db.calls[4].values, { job_id: 'job-1', tenant_id: 'ten-1', old_start: '2026-10-30T14:00:00+00:00', new_start: '2026-10-31T13:00:00.000Z' })
  check('… and it says so', out, { ok: true, timeChanged: true, dayChanged: true, crewChanged: true, retimedAt: STAMP })
}
{
  const db = fakeDb()
  await save(db, { ...d0, start: { h: 13, mi: 30 } })
  check('a same-day move: recorded and saved, crew untouched, nobody emailed', shape(db.calls), ['job_reschedules.insert', 'jobs.update'])
  check('… and the crew size is left alone', Object.keys(db.calls[1].values), ['scheduled_start', 'scheduled_end', 'manually_retimed_at'])
}
{
  const db = fakeDb()
  const out = await save(db, { ...d0, crew: ['kristi', 'gina', 'tia'] })
  check('a crew-only change: no move recorded, clean (crew size, still guarded), crew, no email',
    shape(db.calls), ['jobs.update', 'job_assignments.delete', 'job_assignments.insert'])
  check('… writes no time', db.calls[0].values, { min_crew: 3, max_crew: 3 })
  check('… is still guarded', db.calls[0].filters.length, 3)
  check('… and says so', [out.ok, out.timeChanged, out.crewChanged, out.retimedAt], [true, false, true, null])
}
{
  const db = fakeDb()
  await save(db, { ...d0, crew: [], lead: '' })
  check('taking everyone off: rows deleted, nothing inserted', shape(db.calls), ['jobs.update', 'job_assignments.delete'])
}
{
  const db = fakeDb({ 'jobs.update': () => ({ data: [], error: null }) })
  const out = await save(db, { ...d0, ymd: '2026-10-31', crew: ['gina'], lead: 'gina' })
  check('moved or started since the sheet read it: the record is closed as not made, crew untouched, nobody emailed',
    shape(db.calls), ['job_reschedules.insert', 'jobs.update', 'job_reschedules.update'])
  check('… closed by the mover, only if still open', [db.calls[2].values, db.calls[2].filters],
    [{ undone_at: STAMP, undone_by: 'me-1', not_made: true }, [['eq', 'id', 'rec-1'], ['is', 'undone_at', null]]])
  check('… and the sheet is told it was stale', [out.ok, out.stage, out.stale], [false, 'job', true])
}
{
  const db = fakeDb({ 'jobs.update': () => ({ data: null, error: { message: 'permission denied' } }) })
  const out = await save(db, { ...d0, start: { h: 11, mi: 0 } })
  check('a refused clean write: not made, the reason kept', [shape(db.calls), out.stale, out.error],
    [['job_reschedules.insert', 'jobs.update', 'job_reschedules.update'], false, 'permission denied'])
}
{
  const db = fakeDb({ 'job_reschedules.insert': () => ({ data: null, error: { message: 'new row violates row-level security' } }) })
  const out = await save(db, { ...d0, start: { h: 11, mi: 0 }, crew: ['gina'], lead: 'gina' })
  check('the move can\'t be recorded: nothing else is touched', [shape(db.calls), out.stage], [['job_reschedules.insert'], 'record'])
}
{
  const db = fakeDb({ 'job_assignments.insert': () => ({ data: null, error: { message: 'duplicate key' } }) })
  const out = await save(db, { ...d0, ymd: '2026-10-31', crew: ['gina'], lead: 'gina' })
  check('the crew insert fails after a new day: the move stands and is still emailed, the crew error comes back',
    [shape(db.calls).at(-1), out.ok, out.stage, out.error, out.timeChanged, out.retimedAt], ['fn:notify-reschedule.invoke', false, 'crew', 'duplicate key', true, STAMP])
}
{
  const db = fakeDb({ invoke: () => Promise.reject(new Error('network')) })
  const out = await save(db, { ...d0, ymd: '2026-10-31' })
  check('a failed email never fails the save', out.ok, true)
}
{
  const db = fakeDb()
  const out = await save(db, d0)
  check('nothing changed: nothing is written', [db.calls.length, out.ok], [0, false])
}
{
  const db = fakeDb()
  await save(db, { ...d0, crew: ['tia', 'gina'], lead: 'nobody-picked' })
  check('a lead who isn\'t picked never lands: the first picked leads', db.calls[2].values.map(r => r.is_lead), [true, false])
}

// ── loadEditBase: lead first, assignments folded into crew ──────────────────
{
  // A read leaves op null: it answers as 'jobs.null'.
  const r = await E.loadEditBase(fakeDb({ 'jobs.null': () => ({ data: { id: 'job-1', job_assignments: [
    { user_id: 'gina', is_lead: false }, { user_id: 'kristi', is_lead: true }] }, error: null }) }), 'job-1')
  check('the fresh read puts the lead first and keeps the lead', [r.base.crew, r.base.lead, 'job_assignments' in r.base], [['kristi', 'gina'], 'kristi', false])
  const none = await E.loadEditBase(fakeDb({ 'jobs.null': () => ({ data: null, error: null }) }), 'job-1')
  check('a clean that can\'t be read: no base', [none.base, none.error], [null, 'not found'])
}

// ── the screens ─────────────────────────────────────────────────────────────
const sheet = readFileSync(join(repo, 'src/components/OfficeEditSheet.tsx'), 'utf8')
const lib = readFileSync(join(repo, 'src/lib/officeEdit.ts'), 'utf8')
const detail = readFileSync(join(repo, 'src/screens/JobDetailScreen.tsx'), 'utf8')
check('online only: nothing goes through the offline outbox',
  [/writeThrough|enqueue|outbox\.|flushOutbox/.test(sheet.replace(/import \{ uuid4 \} from '..\/lib\/outbox'/, '')), /writeThrough|outbox/.test(lib.replace(/\/\/.*$/gm, ''))], [false, false])
check('the sheet asks whether the link answers before it loads and before it saves', (sheet.match(/await linkAnswering\(\)/g) || []).length, 2)
check('no drag anywhere in the sheet', /PanResponder|onPanResponder|Gesture|draggable/i.test(sheet), false)
check('the button shows through canEditClean only', /canEditClean\(user\.role, job\) && \(\s*<TouchableOpacity style=\{styles\.editBtn\}/.test(detail), true)
check('the sheet mounts for the office only', /\{isAdminRole && \(\s*<OfficeEditSheet/.test(detail), true)
const work = mkdtempSync(join(tmpdir(), 'office-edit-'))
try {
  writeFileSync(join(work, 'i18n.ts'), readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8').replace(
    "import AsyncStorage from '@react-native-async-storage/async-storage'",
    'const AsyncStorage = { getItem: async (_k: string) => null, setItem: async (_k: string, _v: string) => {} }'))
  const { translations: T } = await import(join(work, 'i18n.ts'))
  const used = [...new Set([...sheet.matchAll(/t\('([a-z_]+)'\)/g), ...detail.matchAll(/t\('(oe_[a-z_]+)'\)/g)].map(m => m[1]))]
  check(`every string the sheet uses is in en, es and pt (${used.length})`,
    used.filter(k => !(k in T.en && k in T.es && k in T.pt)), [])
  check('the crew-error keys picked by condition exist too',
    ['oe_err_crew', 'oe_err_crew_time_saved', 'oe_needs_signal', 'oe_load_failed', 'oe_started'].filter(k => !(k in T.en)), [])
} finally {
  rmSync(work, { recursive: true, force: true })
}

// ── parity with the web's own code ──────────────────────────────────────────
const WEB = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
const webFile = f => join(WEB, 'src/lib', f)
if (['leadSelection.ts', 'weeklySchedule.ts', 'jobQueue.ts'].every(f => existsSync(webFile(f))) && /min_cleaners/.test(readFileSync(webFile('jobQueue.ts'), 'utf8'))) {
  const L = await import(webFile('leadSelection.ts'))
  const W = await import(webFile('weeklySchedule.ts'))
  const Q = await import(webFile('jobQueue.ts'))
  const roles = ['owner', 'manager', 'dispatcher', 'lead_cleaner', 'inspector', 'cleaner', 'trainee', 'laundry_runner', 'maintenance', null, 'unknown']
  const crew = roles.map((role, i) => ({ id: `u${i}`, role }))
  const ids = crew.map(c => c.id)
  let leadDiff = 0, leadN = 0
  for (let a = 0; a < ids.length; a++) for (let b = 0; b < ids.length; b++) for (let c = 0; c < ids.length; c++) {
    const pick = [...new Set([ids[a], ids[b], ids[c]])]
    for (const cur of [null, ids[a], ids[c], 'gone']) {
      leadN++
      if (E.resolveLead(cur, pick, crew) !== L.resolveLead(cur, pick, crew)) leadDiff++
    }
  }
  check(`web: the same lead over ${leadN} pickings`, leadDiff, 0)
  const rowsets = [[], mon, eow, [{ day_of_week: 4, is_available: false }],
    [{ day_of_week: 0, is_available: true, every_other_week: true, week_anchor: '2026-11-01' }, { day_of_week: 3, is_available: true }],
    [{ day_of_week: 4, is_available: true, every_other_week: true, week_anchor: null }]]
  let schedDiff = 0, schedN = 0
  for (const rows of rowsets) for (let i = 0; i < 120; i++) {
    const ymd = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)
    schedN++
    if (E.scheduleOffOn(rows, ymd) !== W.scheduleOffOn(rows, ymd)) schedDiff++
  }
  check(`web: the same weekly-schedule answer on ${schedN} person-days`, schedDiff, 0)
  const addrs = [null, {}, { min_cleaners: null }, { min_cleaners: 0 }, { min_cleaners: 1 }, { min_cleaners: 2 }, { min_cleaners: 2.5 }, { min_cleaners: '3' }]
  const mins = []
  for (const a of addrs) for (const jt of [undefined, null, 'clean', 'task', 'inspection']) mins.push([E.propertyMinCrew({ job_type: jt, client_addresses: a }), Q.propertyMinCrew({ job_type: jt, client_addresses: a })])
  check(`web: the same property minimum in ${mins.length} cases`, mins.filter(([a, b]) => a !== b).length, 0)
} else {
  console.log(`–  web parity skipped (no current leadSelection/weeklySchedule/jobQueue under ${WEB}/src/lib)`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
