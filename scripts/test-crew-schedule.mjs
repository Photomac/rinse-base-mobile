#!/usr/bin/env node
// A cleaner sets their own week (Profile → My week), behind a company switch.
//
// Runs the REAL src/lib/crewSchedule.ts under Node's type stripping (it is pure)
// and checks that each tap writes rows the shared rule reads as the person meant:
// no rows = any day, otherwise only a day with an is_available row. Then checks
// the card is gated on the switch and asks for its rows back on every write.
//
// Usage: node scripts/test-crew-schedule.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleansOnWeekday, planDayTap, worksDay } from '../src/lib/crewSchedule.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}
const row = (d, on = true, extra = {}) => ({ id: `r${d}`, day_of_week: d, is_available: on, ...extra })

check('no rows works any day', [0, 3, 6].map(d => worksDay([], d)), [true, true, true])
check('first day off writes the other six', planDayTap([], 2), { kind: 'insert', days: [0, 1, 3, 4, 5, 6] })

const week = [0, 1, 3, 4, 5, 6].map(d => row(d))
check('after that, the day is off', worksDay(week, 2), false)
check('and the rest are on', worksDay(week, 3), true)
check('tapping a day with no row turns it on', planDayTap(week, 2), { kind: 'insert', days: [2] })
check('an unticked row turns back on', planDayTap([row(1), row(2, false)], 2), { kind: 'update', id: 'r2', patch: { is_available: true } })
check('off clears every-other-week too',
  planDayTap([row(1), row(2, true, { every_other_week: true, week_anchor: '2026-11-03' })], 2),
  { kind: 'update', id: 'r2', patch: { is_available: false, every_other_week: false, week_anchor: null } })
check('the last day stays on', planDayTap([row(1), row(2, false)], 1), { kind: 'last_day' })
check('a row-set ticking nothing reads as off', worksDay([row(1, false)], 1), false)

check('counts cleans on the weekday', cleansOnWeekday(['2026-11-03', '2026-11-10', '2026-11-04'], 2), 2)
check('no cleans', cleansOnWeekday([], 2), 0)

const card = readFileSync(join(repo, 'src/components/CrewWeekCard.tsx'), 'utf8')
check('hidden unless the company turned it on', card.includes("(tenant as any)?.crew_set_availability !== true"), true)
check('renders nothing when not allowed', card.includes('if (!allowed) return null'), true)
check('the read and both writes use one column list, so writes return rows', (card.match(/\.select\(SELECT\)/g) || []).length, 3)
check('a write that matched nothing is a failure', card.includes('error || !data?.length'), true)
const profile = readFileSync(join(repo, 'src/screens/ProfileScreen.tsx'), 'utf8')
check('Profile shows the card', profile.includes('<CrewWeekCard tenantId={user.tenant_id} userId={user.id} />'), true)

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
