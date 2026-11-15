#!/usr/bin/env node
// 📅 on the cleans a booking calendar made (Five Star, 2026-11-12; the web
// Schedule and Dispatch carry the same mark).
//
// Checks:
//   1. lib/calendarMade: a clean is calendar-made exactly when it is linked to a
//      booking (reservation_id), never because is_turnover is ticked.
//   2. The job screen's source: a platform by name, an owner block, a booking
//      the office added by hand, and the plain line when the booking can't be
//      read or has no name we know; in en, es and pt.
//   3. The four strings exist in every language with {{platform}} where needed.
//   4. The screens: Home, Schedule and Open jobs put 📅 after the job number; their reads select reservation_id; the job screen's meta read
//      embeds the booking's platform and shows the line under the time.
//
// Runs the REAL src/lib/calendarMade.ts under Node's type stripping (no imports).
// Usage: node scripts/test-calendar-mark.mjs
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

const { isCalendarMade, calendarSource, calendarSourceLine, CALENDAR_MARK } = await import(join(repo, 'src/lib/calendarMade.ts'))

console.log('\n1. Which cleans a booking made')
check('linked to a booking: calendar-made', isCalendarMade({ reservation_id: 'r1' }), true)
check('typed in by the office: not', isCalendarMade({ reservation_id: null }), false)
check('hand-made with turnover ticked: still not', isCalendarMade({ is_turnover: true }), false)
check('a row cached before reservation_id was read: no mark', isCalendarMade({ id: 'j1' }), false)
check('no job: not', isCalendarMade(undefined), false)

console.log('\n2. Where the booking came from')
check('Airbnb', calendarSource({ platform: 'airbnb', reservation_id: 'x@airbnb.com' }, true), { kind: 'platform', name: 'Airbnb' })
check('OwnerRez, case and spaces ignored', calendarSource({ platform: ' OwnerRez ' }, true), { kind: 'platform', name: 'OwnerRez' })
check('homeaway reads as VRBO', calendarSource({ platform: 'homeaway' }, true), { kind: 'platform', name: 'VRBO' })
check('owner block', calendarSource({ platform: 'owner_block' }, true), { kind: 'owner_block' })
check('a booking the office added by hand', calendarSource({ platform: 'vrbo', reservation_id: 'manual:5f0c' }, true), { kind: 'by_hand' })
check('"other" feed: the plain line', calendarSource({ platform: 'other' }, true), { kind: 'calendar' })
check('"direct": the plain line', calendarSource({ platform: 'direct' }, true), { kind: 'calendar' })
check('linked but the booking can\'t be read: the plain line', calendarSource(null, true), { kind: 'calendar' })
check('no booking at all: nothing', calendarSource(null, false), null)

const i18nSrc = readFileSync(join(repo, 'src/lib/i18n.ts'), 'utf8')
const blocks = {
  en: i18nSrc.slice(i18nSrc.indexOf('  en: {'), i18nSrc.indexOf('  es: {')),
  es: i18nSrc.slice(i18nSrc.indexOf('  es: {'), i18nSrc.indexOf('  pt: {')),
  pt: i18nSrc.slice(i18nSrc.indexOf('  pt: {')),
}
const str = (lang, key) => (blocks[lang].match(new RegExp(`\\b${key}: '([^']*)'`)) ?? [])[1]
const tFor = lang => key => str(lang, key) ?? key
check('en: Airbnb', calendarSourceLine({ kind: 'platform', name: 'Airbnb' }, tFor('en')), `${CALENDAR_MARK} From the calendar: Airbnb`)
check('es: Airbnb', calendarSourceLine({ kind: 'platform', name: 'Airbnb' }, tFor('es')), `${CALENDAR_MARK} Del calendario: Airbnb`)
check('pt: Hospitable', calendarSourceLine({ kind: 'platform', name: 'Hospitable' }, tFor('pt')), `${CALENDAR_MARK} Do calendário: Hospitable`)
check('en: owner block', calendarSourceLine({ kind: 'owner_block' }, tFor('en')), `${CALENDAR_MARK} From the calendar: owner block`)
check('es: by hand', calendarSourceLine({ kind: 'by_hand' }, tFor('es')), `${CALENDAR_MARK} De una reserva que agregó la oficina`)
check('pt: plain', calendarSourceLine({ kind: 'calendar' }, tFor('pt')), `${CALENDAR_MARK} Do calendário de reservas`)
check('no source: no line', calendarSourceLine(null, tFor('en')), null)

console.log('\n3. The strings, in every language')
for (const key of ['cal_from_platform', 'cal_from_owner_block', 'cal_from_by_hand', 'cal_from_calendar']) {
  const vals = ['en', 'es', 'pt'].map(l => str(l, key))
  check(`${key} in en, es and pt`, vals.every(Boolean), true)
  check(`${key}: es and pt are not the English`, vals[1] !== vals[0] && vals[2] !== vals[0], true)
  check(`${key}: {{platform}} only where the platform goes`, vals.map(v => (v ?? '').includes('{{platform}}')), key === 'cal_from_platform' ? [true, true, true] : [false, false, false])
}

console.log('\n4. The screens and their reads')
const src = p => readFileSync(join(repo, p), 'utf8')
const MARK = '{isCalendarMade(job) ? <Text>  📅</Text> : null}'
const home = src('src/screens/DashboardScreen.tsx')
const sched = src('src/screens/ScheduleScreen.tsx')
const open = src('src/screens/OpenJobsScreen.tsx')
const detail = src('src/screens/JobDetailScreen.tsx')
const reads = src('src/lib/jobReads.ts')
check('Home: 📅 right after the job number', home.includes(`#{(job as any).job_number}</Text> : null}${MARK}`), true)
check('Schedule: 📅 right after the job number', sched.includes(`#{(job as any).job_number}</Text> : null}${MARK}`), true)
check('Open jobs: 📅 after the number on both lists', open.split(`#{job.job_number}</Text> : null}${MARK}`).length - 1, 2)
// The job screen spells it out under the time instead: a 📅 in the title wrapped
// onto a line of its own on a phone and said the same thing twice.
check('job screen title: no 📅 (the line under the time says it)', detail.includes(MARK), false)
// Home's and Schedule's selects are constants since crew read scope stage 1
// (crew send them through lib/crewScope, which keeps reservation_id).
const dashSelect = /\.select\(jobSelectFor\(office, HOME_DAY_SELECT\)\)/.test(reads) ? ((reads.match(/export const HOME_DAY_SELECT = '([^']*)'/) ?? [])[1] ?? '') : ''
const schedSelect = sched.includes('cachedRead(scheduleRead(') ? ((src('src/lib/pushTap.ts').match(/export const SCHEDULE_JOB_SELECT = '([^']*)'/) ?? [])[1] ?? '') : ''
check('Home\'s read (and the offline day pack) selects reservation_id', /(^|, )reservation_id(,|$)/.test(dashSelect), true)
check('Schedule\'s read selects reservation_id', /^id, job_number[^']*\breservation_id\b/.test(schedSelect), true)
// The board reads open_board_jobs() since crew read scope stage 1: the RPC says
// only whether a booking made the clean (calendar_made), and lib/openJobs carries
// that as the card's reservation_id, so the mark reads it as everywhere else.
const openJobsLib = src('src/lib/openJobs.ts')
check('Open jobs\' cards carry the calendar mark from open_board_jobs()', /reservation_id: r\.calendar_made \? 'calendar' : null/.test(openJobsLib) && open.includes("supabase.rpc('open_board_jobs'"), true)
const metaSelect = (reads.match(/export const jobMetaRead[\s\S]*?\.select\('([^']*)'/) ?? [])[1] ?? ''
// The client's type comes from crew_job_context since crew read scope stage 1, not a clients embed.
check('job meta read: reservation_id + the booking\'s platform and id', /\breservation_id, property_reservations\(/.test(metaSelect) && metaSelect.includes('property_reservations(guest_count, pet_count, platform, reservation_id)'), true)
check('job screen: the source comes from the meta read', detail.includes('setCalSource(calendarSource((jr as any).property_reservations, !!(jr as any).reservation_id))'), true)
check('job screen: the line sits right under the time', /🕐 \{fmtTimeRangeAt\([^)]*\)\}<\/Text>\s*\{\/\* 📅[^*]*\*\/\}\s*\{calSource && \(/.test(detail), true)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
