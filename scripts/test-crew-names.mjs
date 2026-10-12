#!/usr/bin/env node
// Who is scheduled, under each job on Today and Schedule.
//
// Runs the REAL src/lib/crewNames.ts under Node's type stripping (it is pure),
// with the crews Celebrity Clean had on 2026-10-08, and checks:
//   • names: lead first, the viewer as "You", "First L." so two Stewarts read apart;
//   • a teammate whose name can't be read is skipped, never shown blank;
//   • a big crew collapses to "+N";
// and, in the screens, that both lists fetch the crew through the ALIASED embed
// (so a "my jobs" filter on job_assignments can't trim it to the viewer), with
// the users FK named (two FKs to users → PGRST201 otherwise), and that the line
// renders nothing for a row cached before it existed.
//
// Usage: node scripts/test-crew-names.mjs
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
const { crewNames, crewLineText, shortName } = await import(join(repo, 'src/lib/crewNames.ts'))
const line = (rows, viewer, max) => crewLineText(crewNames(rows, viewer, 'You'), 'lead', max)

// Melrose Manor #987, 2026-10-08.
const melrose = [
  { user_id: 'marin', is_lead: false, users: { full_name: 'Marin Leslie' } },
  { user_id: 'tasia', is_lead: true, users: { full_name: 'Tasia Cotten' } },
  { user_id: 'madison', is_lead: false, users: { full_name: 'Madison Hensley' } },
]
check('owner view: lead first, then by name', line(melrose, 'keilani'), 'Tasia C. (lead) · Madison H. · Marin L.')
check('Marin\'s phone: lead first, then "You"', line(melrose, 'marin'), 'Tasia C. (lead) · You · Madison H.')
check('the lead\'s own phone', line(melrose, 'tasia'), 'You (lead) · Madison H. · Marin L.')

// Gables #1057, 2026-10-06: same last name.
const gables = [
  { user_id: 'gracie', is_lead: false, users: { full_name: 'Gracie Stewart' } },
  { user_id: 'abigail', is_lead: true, users: { full_name: 'Abigail Stewart' } },
]
check('two Stewarts still read apart', line(gables, 'owner'), 'Abigail S. (lead) · Gracie S.')
check('short names', [shortName('Abigail Stewart'), shortName('Cher'), shortName('  maria  de la cruz '), shortName('')], ['Abigail S.', 'Cher', 'maria C.', ''])

check('nobody assigned: no names (the card shows "No crew assigned" to the office)', crewNames([], 'owner', 'You'), [])
check('not fetched (old cached row): no names, no claim', crewNames(undefined, 'owner', 'You'), [])
check('a teammate whose name can\'t be read is skipped, never blank',
  line([{ user_id: 'x', is_lead: false, users: null }, { user_id: 'me', is_lead: false, users: null }], 'me'), 'You')
check('a duplicated assignment row is listed once', line([...gables, gables[0]], 'owner'), 'Abigail S. (lead) · Gracie S.')
const six = ['Ana B', 'Bea C', 'Cy D', 'Di E', 'Ed F', 'Flo G'].map((n, i) => ({ user_id: `u${i}`, is_lead: i === 3, users: { full_name: n } }))
check('more than 4: three names then +N', line(six, 'owner'), 'Di E. (lead) · Ana B. · Bea C. · +3')
check('exactly 4: all shown', line(six.slice(0, 4), 'owner'), 'Di E. (lead) · Ana B. · Bea C. · Cy D.')

// ── screens ──────────────────────────────────────────────────────────────────
const CREW = 'crew:job_assignments!job_assignments_job_id_fkey(user_id, is_lead, users!job_assignments_user_id_fkey(full_name))'
const dash = readFileSync(join(repo, 'src/screens/DashboardScreen.tsx'), 'utf8')
const sched = readFileSync(join(repo, 'src/screens/ScheduleScreen.tsx'), 'utf8')
const todayQuery = dash.slice(dash.indexOf('cachedQuery(`dash:today:'), dash.indexOf('cachedQuery(`dash:month:'))
check('Today fetches the crew through the aliased, FK-named embed', todayQuery.includes(CREW), true)
check('Schedule fetches the crew through the aliased, FK-named embed', sched.includes(CREW), true)
check('no unhinted users embed anywhere on these screens (PGRST201)', /job_assignments[^)]*users\(/.test(dash + sched), false)
check('Today and Schedule cards render the crew line, unassigned shown to the office only',
  [/<CrewLine crew=\{job\.crew\} viewerId=\{user\.id\} showUnassigned=\{canSeeClientNames\} \/>/.test(dash),
   /<CrewLine crew=\{job\.crew\} viewerId=\{user\.id\} showUnassigned=\{canSeeClientNames\} \/>/.test(sched)], [true, true])
const comp = readFileSync(join(repo, 'src/components/CrewLine.tsx'), 'utf8')
check('a row without the crew (cached before this) renders nothing', /if \(!Array\.isArray\(crew\)\) return null/.test(comp), true)

const i18n = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
for (const key of ['crew_you', 'crew_unassigned']) {
  check(`"${key}" in all three languages`, (i18n.match(new RegExp(`\\n    ${key}: '`, 'g')) || []).length, 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
