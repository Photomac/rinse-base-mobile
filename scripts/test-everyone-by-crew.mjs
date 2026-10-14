#!/usr/bin/env node
// "Everyone", crew by crew, on Home and Schedule, for the office.
//
// Runs the REAL src/lib/crewGroups.ts (with the real crewNames and jobScope it
// imports) under Node's type stripping, on a day shaped like CKS Perfections'
// 2026-10-14: 27 cleans and 4 cancelled ones, nine people. The owner leads 5;
// a manager leads 10 with the same helper on every one, 9 of them route-ordered;
// two cleaners lead one another's cleans; four more work alone. Names are
// invented, the shape is theirs. Checks:
//   • one section per person who leads a clean, A–Z by full name, the viewer
//     in her own place as "You"; "No crew assigned" first;
//   • each clean once, under its lead; a helper-only person gets no section;
//     the section counts add up to Home's Today;
//   • working order kept inside a section, "Stop k of M" over that person's stops;
//   • no lead flagged, two leads, unreadable names, short names that collide;
//   • a row cached before the crew line → no sections (the plain list);
//   • without sections the list is exactly the old one (Mine unchanged);
// and, in the screens, that only the office's Everyone gets sections.
//
// Usage: node scripts/test-everyone-by-crew.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
// crewGroups imports './crewNames' and './jobScope' the way Metro wants them
// (no extension); Node needs the file.
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec === './crewNames' || spec === './jobScope') && ctx.parentURL?.includes('/src/lib/')) {
      return next(pathToFileURL(join(repo, 'src/lib', spec.slice(2) + '.ts')).href, ctx)
    }
    return next(spec, ctx)
  },
})
const { crewGroups, listItems, UNASSIGNED_GROUP } = await import(join(repo, 'src/lib/crewGroups.ts'))
const { dayView } = await import(join(repo, 'src/lib/jobScope.ts'))
const { byCrewDayOrder } = await import(join(repo, 'src/lib/jobOrder.ts'))

// ── the day ──────────────────────────────────────────────────────────────────
const P = {
  owner:   ['u-owner', 'Carla Keane'],          // the viewer: owner who cleans
  manager: ['u-mgr', 'NORA WESTFIELD'],         // leads 10, with Mia on all
  helper:  ['u-help', 'MIA ELLIS '],            // helper only (trailing space as entered)
  jen:     ['u-jen', 'JESSICA CORTEZ'],
  ali:     ['u-ali', 'ALMA SOTO'],
  kris:    ['u-kris', 'Kira Gomez'],
  brit:    ['u-brit', 'BRENDA FORD'],
  eve:     ['u-eve', 'EVA DUARTE'],
  taw:     ['u-taw', 'Tess Ross'],
}
const crew = (...members) => members.map(([key, lead]) => ({ user_id: P[key][0], is_lead: lead, users: { full_name: P[key][1] } }))
const at = hm => `2026-10-14T${hm}:00-07:00`
let n = 0
const job = (hm, members, extra = {}) => {
  const c = crew(...members)
  return { id: `j${++n}`, scheduled_start: at(hm), status: 'scheduled', route_order: null, job_number: 1000 + n,
    job_assignments: c.map(r => ({ user_id: r.user_id })), crew: c, ...extra }
}
const mgr = (hm, ro, extra) => job(hm, [['manager', true], ['helper', false]], { route_order: ro, ...extra })
const raw = [
  job('07:00', [['owner', true]], { status: 'completed' }),
  job('08:00', [['jen', true], ['ali', false]]),
  job('08:00', [['ali', true], ['jen', false]]),
  job('09:15', [['kris', true]]),
  { id: 'x1', scheduled_start: at('10:00'), status: 'cancelled', route_order: null, job_number: 24, job_assignments: [], crew: [] },
  job('10:00', [['brit', true]]),
  { id: 'x2', scheduled_start: at('10:00'), status: 'cancelled', route_order: null, job_number: 411, job_assignments: [], crew: [] },
  job('10:00', [['kris', true]]),
  job('10:00', [['owner', true]], { status: 'in_progress' }),
  job('10:00', [['eve', true]]),
  job('10:00', [['taw', true]]),
  mgr('10:01', 2),
  mgr('10:30', 1),
  job('10:45', [['eve', true]]),
  mgr('11:00', 3),
  { id: 'x3', scheduled_start: at('11:00'), status: 'cancelled', route_order: null, job_number: 2, job_assignments: [], crew: [] },
  { id: 'x4', scheduled_start: at('11:00'), status: 'cancelled', route_order: null, job_number: 220, job_assignments: [], crew: [] },
  job('11:00', [['eve', true]]),
  job('11:00', [['owner', true]]),
  mgr('11:30', 4),
  job('11:30', [['brit', true]]),
  job('11:30', [['owner', true]]),
  mgr('12:15', 5),
  job('12:15', [['owner', true]]),
  mgr('12:30', null),
  job('13:00', [['jen', true], ['ali', false]]),
  job('13:00', [['kris', true]]),
  mgr('13:30', 6),
  mgr('14:30', 7),
  mgr('14:45', 8),
  mgr('15:00', 9),
]
// The screens hand crewGroups the day in working order, cancelled taken out.
const VIEWER = P.owner[0]
const everyone = dayView([...raw].sort(byCrewDayOrder), VIEWER, 'everyone')
const groups = crewGroups(everyone.jobs, VIEWER, 'You')
const head = gs => gs.map(g => `${g.label || g.id} · ${g.jobs.length}`)
const idsOf = g => g.jobs.map(j => j.id)
const stopsOf = g => g.jobs.map(j => g.stops[j.id] ? `${g.stops[j.id].k}/${g.stops[j.id].m}` : '-')
const find = (gs, id) => gs.find(g => g.id === id)

// ── sections ─────────────────────────────────────────────────────────────────
check('the day: 27 cleans, 4 cancelled kept apart', [everyone.jobs.length, everyone.cancelled.length], [27, 4])
check('one section per lead, A–Z by full name, the owner as "You" in her own place',
  head(groups), ['ALMA S. · 1', 'BRENDA F. · 2', 'You · 5', 'EVA D. · 3', 'JESSICA C. · 2', 'Kira G. · 3', 'NORA W. · 10', 'Tess R. · 1'])
check('kinds: the viewer\'s section is "me", the rest "crew"', groups.map(g => g.kind),
  ['crew', 'crew', 'me', 'crew', 'crew', 'crew', 'crew', 'crew'])
check('the counts add up to Home\'s Today (each clean once)', groups.reduce((s, g) => s + g.jobs.length, 0), everyone.jobs.length)
check('no clean in two sections', new Set(groups.flatMap(idsOf)).size, 27)
check('a helper-only person has no section of their own (named on each card instead)', groups.some(g => g.id === P.helper[0]), false)
check('a shared clean sits under its lead: Jessica leads j2 + j22, Alma leads j3',
  [idsOf(find(groups, P.jen[0])), idsOf(find(groups, P.ali[0]))], [['j2', 'j22'], ['j3']])
check('no "No crew assigned" section when every clean is staffed', groups.some(g => g.kind === 'unassigned'), false)
check('no cancelled clean in any section', groups.some(g => g.jobs.some(j => j.status === 'cancelled')), false)

// ── order and stops inside a section ─────────────────────────────────────────
const nora = find(groups, P.manager[0])
check('inside a section: the working order the day already had',
  idsOf(nora), everyone.jobs.filter(j => j.crew[0].user_id === P.manager[0]).map(j => j.id))
check('her own five in working order, done one and active one included',
  idsOf(find(groups, VIEWER)), ['j1', 'j7', 'j15', 'j18', 'j20'])
check('"Stop k of M" over the lead\'s own stops: Nora 9 route-ordered of 10, one without a stop',
  stopsOf(nora), ['2/9', '1/9', '3/9', '4/9', '5/9', '-', '6/9', '7/9', '8/9', '9/9'])
check('a section with no route order shows no stops', find(groups, P.eve[0]).stops, {})

const mixed = [
  job('08:00', [['brit', true]], { route_order: 4 }),
  job('09:00', [['taw', true]], { route_order: 7 }),
  job('10:00', [['brit', true]], { route_order: 1 }),
]
const mg = crewGroups(mixed, VIEWER, 'You')
check('per-crew route numbers that overlap company-wide still read 1..M per person',
  mg.map(g => `${g.label}: ${stopsOf(g).join(',')}`), ['BRENDA F.: 2/2,1/2', 'Tess R.: 1/1'])

// ── unassigned ───────────────────────────────────────────────────────────────
const orphanDay = [job('06:30', []), ...everyone.jobs, job('16:00', [])]
const og = crewGroups(orphanDay, VIEWER, 'You')
check('"No crew assigned" comes first, both unstaffed cleans in it, in working order',
  [og[0].id, og[0].kind, og[0].label, og[0].jobs.map(j => j.scheduled_start.slice(11, 16))],
  [UNASSIGNED_GROUP, 'unassigned', '', ['06:30', '16:00']])
check('the people after it are unchanged', head(og.slice(1)), head(groups))
check('a crew whose only name can\'t be read lands where its card says: "No crew assigned"',
  crewGroups([{ id: 'nameless', crew: [{ user_id: 'u-x', is_lead: true, users: null }] }], VIEWER, 'You').map(g => g.kind), ['unassigned'])

// ── leads ────────────────────────────────────────────────────────────────────
const noLead = (members, viewer = 'nobody') => crewGroups([{ id: 'q', crew: crew(...members.map(k => [k, false])) }], viewer, 'You')[0].label
check('no lead flagged: under the first name on the crew line (A–Z)', noLead(['taw', 'brit']), 'BRENDA F.')
check('no lead flagged and the viewer on it: under "You", as the crew line reads', noLead(['taw', 'owner'], VIEWER), 'You')
check('two leads: the first lead on the crew line', crewGroups([{ id: 'q', crew: crew(['taw', true], ['brit', true], ['eve', false]) }], 'nobody', 'You')[0].label, 'BRENDA F.')
check('the viewer helping on a crew member\'s clean: under the lead, not "You"',
  crewGroups([{ id: 'q', crew: crew(['kris', true], ['owner', false]) }], VIEWER, 'You')[0].label, 'Kira G.')

// ── names ────────────────────────────────────────────────────────────────────
const twins = crewGroups([
  { id: 'a', crew: [{ user_id: 'm1', is_lead: true, users: { full_name: 'Maria Garcia' } }] },
  { id: 'b', crew: [{ user_id: 'm2', is_lead: true, users: { full_name: 'Maria Gonzalez' } }] },
  { id: 'c', crew: [{ user_id: 'm3', is_lead: true, users: { full_name: 'Marco Lopez' } }] },
], 'nobody', 'You')
check('two people who shorten alike get their full names; others stay short',
  twins.map(g => g.label), ['Marco L.', 'Maria Garcia', 'Maria Gonzalez'])
check('A–Z ignores capitals, as typed names mix them (Kira after JESSICA, before NORA)',
  groups.map(g => g.id).indexOf(P.kris[0]) === groups.map(g => g.id).indexOf(P.jen[0]) + 1, true)

// ── when sections can't be drawn ─────────────────────────────────────────────
const stale = everyone.jobs.map((j, i) => (i === 5 ? (({ crew: _, ...rest }) => rest)(j) : j))
check('a row cached before the crew line → no sections (the plain list)', crewGroups(stale, VIEWER, 'You'), null)
check('an empty day → no sections, nothing to draw', crewGroups([], VIEWER, 'You'), [])

// ── the list the screen draws ────────────────────────────────────────────────
const items = listItems(everyone.jobs, everyone.stops, groups)
check('sectioned: a header before each person\'s cleans, every clean once',
  [items.filter(i => i.kind === 'header').length, items.filter(i => i.kind === 'job').length, items[0].kind, items[1].kind],
  [groups.length, 27, 'header', 'job'])
check('sectioned: each card carries its own section\'s stops',
  items.filter(i => i.kind === 'job' && i.job.crew[0].user_id === P.manager[0]).every(i => i.stops === nora.stops), true)
const mine = dayView([...raw].sort(byCrewDayOrder), VIEWER, 'mine')
const mineItems = listItems(mine.jobs, mine.stops, null)
check('no sections (Mine, crew): the old list exactly, same jobs, same day stops',
  [mineItems.every(i => i.kind === 'job'), mineItems.map(i => i.job), mineItems.every(i => i.stops === mine.stops)],
  [true, mine.jobs, true])
check('Mine still her five, renumbered over her own stops as before', mineItems.map(i => i.job.id), ['j1', 'j7', 'j15', 'j18', 'j20'])

// ── screens ──────────────────────────────────────────────────────────────────
const dash = readFileSync(join(repo, 'src/screens/DashboardScreen.tsx'), 'utf8')
const sched = readFileSync(join(repo, 'src/screens/ScheduleScreen.tsx'), 'utf8')
check('sections only for the office\'s Everyone, on both screens (crew have viewScope "everyone" too)',
  [/isOffice && viewScope === 'everyone' \? crewGroups\(day\.jobs, user\.id, youLabel\) : null/.test(dash),
   /isOffice && viewScope === 'everyone' \? crewGroups\(selectedJobs, user\.id, youLabel\) : null/.test(sched)], [true, true])
check('both lists draw from listItems, headers through CrewGroupHeader',
  [/todayItems\.map\(item =>/.test(dash), /selectedItems\.map\(item =>/.test(sched),
   /if \(item\.kind === 'header'\) return <CrewGroupHeader/.test(dash), /if \(item\.kind === 'header'\) return <CrewGroupHeader/.test(sched)],
  [true, true, true, true])
check('the "You" label comes from the language, both screens',
  [/const youLabel = t\('crew_you'\)/.test(dash), /const youLabel = t\('crew_you'\)/.test(sched)], [true, true])
check('Home\'s stop badge reads the card\'s own section stops', /const stop = item\.stops\[job\.id\]/.test(dash), true)
check('Home\'s cancelled cards get their own header under sections',
  /\{groups && cancelledToday\.length > 0 && <CrewGroupHeader kind="cancelled"/.test(dash), true)
check('no sorting by crew on the screens: the order comes from the day as loaded',
  [/sort\(byCrewDayOrder\)/.test(dash), /sort\(byCrewDayOrder\)/.test(sched)], [true, true])

const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
for (const key of ['crew_group_one', 'crew_group_n', 'crew_unassigned', 'job_cancelled_label', 'crew_you']) {
  check(`"${key}" in all three languages`, (i18n.match(new RegExp(`\\n    ${key}: ['"]`, 'g')) || []).length, 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
