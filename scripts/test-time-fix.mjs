#!/usr/bin/env node
// "Fix my times" and "Start my day before a clean" (True Shine Cleaning
// Services, Elle, 2026-11-23; web repo 20261124132253_time_fix_requests and
// 20261124132236_clean_start_needs_day).
//
// Runs the REAL src/lib/timeFix.ts and src/lib/pauseReason.ts under Node's type
// stripping (both pure), and checks:
//   • the times the sheet refuses before sending (no time, end before start,
//     over 16 hours, in the future, the day's own times) and the ones it lets go;
//   • which days can be fixed from the app (today and the 14 before it);
//   • the server's refusals in the crew's words, and no signal as no signal;
//   • a day's line on My week (the newest ask that counts; a replaced one never);
//   • only a closed day shift is fixable;
//   • Start on a clean asks for the day only at a day-shift company with the
//     switch on, for crew with no day running, never when the phone can't tell;
//   • an approved fix's note on the time list in the crew's language;
//   • every new string in English, Spanish and Portuguese, same {placeholders};
// and, in the screens, that the sheet calls request_time_fix with its
// parameter names and a stable id, Home offers "End and fix times" and ends the
// day before the sheet, My week offers the links at a day-shift company only,
// and the clean screen checks before the note and Check first windows.
//
// Usage: node scripts/test-time-fix.mjs
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
const F = await import(join(repo, 'src/lib/timeFix.ts'))
const { pauseReasonLabel } = await import(join(repo, 'src/lib/pauseReason.ts'))
const { translations } = await import(join(repo, 'src/lib/i18n.ts'))
const read = p => readFileSync(join(repo, p), 'utf8')

// ── The sheet's own refusals ────────────────────────────────────────────────
const H = 3600_000
const NOW = Date.parse('2026-11-23T23:00:00Z')
const day = Date.parse('2026-11-23T14:00:00Z')   // 7:00 AM in Phoenix
const p = (inMs, outMs, was = null) => F.fixProblem({ inMs, outMs, nowMs: NOW, was })
check('a good fix passes', p(day, day + 8 * H), null)
check('no start typed', p(NaN, day + 8 * H), 'no_start')
check('no end typed', p(day, NaN), 'no_end')
check('end before start', p(day, day - H), 'order')
check('end at the start', p(day, day), 'order')
check('over 16 hours', p(day, day + 16 * H + 60_000), 'long')
check('exactly 16 hours passes', p(day - 10 * H, day + 6 * H), null)
check('an end later than now', p(NOW - 2 * H, NOW + 10 * 60_000), 'future')
check('…but the server\'s 5 minutes of grace pass', p(NOW - 2 * H, NOW + 4 * 60_000), null)
check('the day\'s own times are nothing to fix', p(day, day + 9 * H, { inMs: day + 20_000, outMs: day + 9 * H + 30_000 }), 'same')
check('a new end on the same day passes', p(day, day + 8 * H, { inMs: day, outMs: day + 16 * H }), null)
check('every refusal has words', Object.keys(F.FIX_PROBLEM_KEYS).sort(), ['future', 'long', 'no_end', 'no_start', 'order', 'same'])

// ── Which days ──────────────────────────────────────────────────────────────
check('today can be fixed', F.withinFixWindow('2026-11-23', '2026-11-23'), true)
check('14 days back can', F.withinFixWindow('2026-11-09', '2026-11-23'), true)
check('15 days back can\'t (the office\'s)', F.withinFixWindow('2026-11-08', '2026-11-23'), false)
check('a day ahead can\'t', F.withinFixWindow('2026-11-24', '2026-11-23'), false)
check('across a month end', F.withinFixWindow('2026-10-30', '2026-11-12'), true)

// ── The server's refusals, in the crew's words ──────────────────────────────
const e = m => F.fixErrorKey({ message: m })
check('no signal', [F.fixErrorKey({ message: 'TypeError: Network request failed' }), F.fixErrorKey(null)], ['fix_no_signal', 'fix_no_signal'])
check('overlap', e('Those times run into another day you have. Fix that day instead.'), 'fix_e_overlap')
check('payroll approved', e('Payroll already approved that day. Ask the office.'), 'fix_e_paid')
check('too old', e('You can fix a day from the last 14 days. Ask the office for an older one.'), 'fix_e_old')
check('still running', e('End your day first, then fix its times.'), 'fix_e_running')
check('same times', e('Those are already that day\'s times.'), 'fix_p_same')
check('the start on another day', e('The start has to be on the same day.'), 'fix_e_same_day')
check('not found', e('That day could not be found.'), 'fix_e_not_found')
check('the database before its migration', e('Could not find the function public.request_time_fix(p_entry_id, p_id, p_in, p_out, p_reason) in the schema cache'), 'fix_e_not_ready')
check('a per-clean company', e('Fixing a day\'s times is for day-shift companies.'), 'fix_e_not_ready')
check('anything else shows as the server wrote it', e('Sign in again to do this.'), null)
// The web repo's migration, when that repo is on this machine (as test-i18n:
// RINSEBASE_WEB_REPO, else a sibling checkout).
const WEB = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
let SERVER = ''
try { SERVER = readFileSync(join(WEB, 'supabase/migrations/20261124132253_time_fix_requests.sql'), 'utf8') } catch { /* not here: skipped */ }
if (SERVER) {
  const raised = [...SERVER.matchAll(/raise exception '([^']*(?:''[^']*)*)' using errcode = '(?:22023|55000|23P01|P0002)'/g)].map(m => m[1].replace(/''/g, "'"))
  const crewSide = raised.filter(m => !/office can answer|Approve or decline|time fix could not|now run into|deleted|running again|Change it on Payroll|Fix it on Payroll|changed after they asked|Missing the ask/.test(m))
  check('every refusal request_time_fix raises has the crew\'s words (web migration on this machine)',
    crewSide.filter(m => !F.fixErrorKey({ message: m })), [])
}

// ── My week's line ──────────────────────────────────────────────────────────
const ask = (o) => ({ id: 'x', time_entry_id: null, work_date: '2026-11-22', asked_in: '', asked_out: '', status: 'pending', review_note: null, created_at: '2026-11-23T01:00:00Z', ...o })
check('no ask, no line', F.dayFixLine([], '2026-11-22'), null)
check('a waiting ask', F.dayFixLine([ask({})], '2026-11-22'), { status: 'pending', note: null })
check('a replaced ask is never shown',
  F.dayFixLine([ask({ status: 'replaced', created_at: '2026-11-23T02:00:00Z' })], '2026-11-22'), null)
check('the newest that counts wins',
  F.dayFixLine([ask({ status: 'declined', review_note: 'Off that day', created_at: '2026-11-23T01:00:00Z' }), ask({ status: 'approved', created_at: '2026-11-23T03:00:00Z' })], '2026-11-22'),
  { status: 'approved', note: null })
check('another day\'s ask', F.dayFixLine([ask({ work_date: '2026-11-21' })], '2026-11-22'), null)

// ── Fixable entries ─────────────────────────────────────────────────────────
check('a closed day shift', F.fixableShift({ entry_type: 'shift', job_id: null, clocked_out_at: '2026-11-22T23:00:00Z' }), true)
check('a running day', F.fixableShift({ entry_type: 'shift', job_id: null, clocked_out_at: null }), false)
check('a clean\'s own clock entry', F.fixableShift({ entry_type: 'work', job_id: 'j', clocked_out_at: '2026-11-22T23:00:00Z' }), false)

// ── Start my day before a clean ─────────────────────────────────────────────
const base = { dailyMode: true, switchOn: true, officeExempt: false, recordsForOthers: false, dayRunning: false }
check('crew, switch on, no day running: asked', F.dayNeededFirst(base), true)
check('…not with the day running', F.dayNeededFirst({ ...base, dayRunning: true }), false)
check('…not when the phone can\'t tell', F.dayNeededFirst({ ...base, dayRunning: null }), false)
check('…not with the switch off', F.dayNeededFirst({ ...base, switchOn: false }), false)
check('…not at a per-clean company', F.dayNeededFirst({ ...base, dailyMode: false }), false)
check('…not owners, admins, managers', F.dayNeededFirst({ ...base, officeExempt: true }), false)
check('…not desk staff recording someone\'s time', F.dayNeededFirst({ ...base, recordsForOthers: true }), false)
check('the open-day read: a row = running', F.dayRunningFrom([{ clocked_out_at: null, entry_type: 'shift' }]), true)
check('…no row = not running', F.dayRunningFrom([]), false)
check('…a queued End my day over it = not running', F.dayRunningFrom([{ clocked_out_at: '2026-11-23T20:00:00Z', entry_type: 'shift' }]), false)

// ── Notes ───────────────────────────────────────────────────────────────────
const tr = lang => k => translations[lang][k] || translations.en[k] || k
check('an approved fix\'s note, English', pauseReasonLabel('Time fix approved: Forgot to end my day', tr('en')), 'Time fix approved: Forgot to end my day')
check('…Spanish', pauseReasonLabel('Time fix approved: Forgot to end my day', tr('es')), 'Corrección aprobada: Forgot to end my day')
check('an added day, Portuguese', pauseReasonLabel('Added from a time fix: Phone died', tr('pt')), 'Adicionado por uma correção: Phone died')
check('after the system\'s own note', pauseReasonLabel('Auto-closed: forgot to clock out · Time fix approved: x', tr('en')),
  `${translations.en.pr_auto_forgot} · Time fix approved: x`)
if (SERVER) {
  check('the notes are the ones review_time_fix writes (web migration on this machine)',
    [SERVER.includes("'Time fix approved: ' || v_req.reason"), SERVER.includes("'Added from a time fix: ' || v_req.reason")], [true, true])
}

// ── Strings ─────────────────────────────────────────────────────────────────
const NEW = Object.keys(translations.en).filter(k => /^(fix_|day_first_|week_fix_|week_forgot_|pr_time_fix_)/.test(k))
check('the new strings', NEW.length >= 40, true)
const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
for (const lang of ['es', 'pt']) {
  check(`every new string in ${lang}`, NEW.filter(k => !translations[lang][k]), [])
  check(`…with the same {placeholders} in ${lang}`, NEW.filter(k => JSON.stringify(ph(translations[lang][k] || '')) !== JSON.stringify(ph(translations.en[k]))), [])
  check(`…and none still English in ${lang}`, NEW.filter(k => translations[lang][k] === translations.en[k]), [])
}
check('the quick reasons have words in all three', F.FIX_REASONS.filter(r => !['en', 'es', 'pt'].every(l => translations[l][r.key])).map(r => r.value), [])
check('Spanish asks with ¿', ['fix_why', 'week_forgot_link'].every(k => translations.es[k].startsWith('¿')), true)

// ── Wiring ──────────────────────────────────────────────────────────────────
const sheet = read('src/components/TimeFixSheet.tsx')
check('the sheet calls request_time_fix with its parameter names',
  ['request_time_fix', 'p_id:', 'p_entry_id:', 'p_in:', 'p_out:', 'p_reason:'].every(w => sheet.includes(w)), true)
check('…with an id made once per sheet', /askId = useRef\(uuid4\(\)\)/.test(sheet) && sheet.includes('p_id: askId.current'), true)
check('…and sends nothing while a refusal or no reason stands', sheet.includes('if (problem || needReason || sending) return'), true)
const home = read('src/screens/DashboardScreen.tsx')
const confirm = home.slice(home.indexOf('function confirmEndDay()'), home.indexOf('async function endDayNow()'))
check('Home offers End and fix times beside End my day', confirm.includes("t('fix_end_and_fix')") && confirm.includes("t('end_my_day'), style: 'destructive'"), true)
check('…which ends the day first, then opens the sheet on it', confirm.indexOf('await endDayNow()') < confirm.indexOf('setFixFor('), true)
check('…and says so when the end only queued', confirm.includes("ended === 'queued'") && confirm.includes("t('fix_day_ended_offline')"), true)
check('Home renders the sheet', home.includes('<TimeFixSheet target={fixFor}'), true)
const week = read('src/screens/MyWeekScreen.tsx')
check('My week offers it at a day-shift company only', week.includes("const dailyMode = user._timeMode === 'daily'") && week.includes('if (!dailyMode || asks === null) return null'), true)
check('…reads only the person\'s own asks', week.includes(".from('time_fix_requests')") && week.includes(".eq('user_id', user.id)"), true)
check('…within the window, not on a running or coming day', week.includes('withinFixWindow(d.ymd, todayKey())') && week.includes("d.state !== 'upcoming' && !d.open"), true)
const job = read('src/screens/JobDetailScreen.tsx')
const start = job.slice(job.indexOf('async function handleStartDaily()'), job.indexOf('async function dayNotStarted()'))
check('the clean screen checks the day before the note and Check first',
  start.indexOf('await dayNotStarted()') >= 0 && start.indexOf('await dayNotStarted()') < start.indexOf('setNotePrompt'), true)
const gate = job.slice(job.indexOf('async function dayNotStarted()'), job.indexOf('function askCheckFirst('))
check('…never for owners, admins, managers or desk staff recording time', gate.includes('if (!dailyMode || recordsForOthers || notCheckedRole(user.role)) return false'), true)
check('…reads the switch and the open day, a queued Start counting', ['cleanStartNeedsDayRead(user.tenant_id)', 'dashShiftRead(user)', "overlayPending('job_time_entries'"].every(w => gate.includes(w)), true)
check('…and lets the start go when anything fails', gate.includes('} catch {\n      return false'), true)
const reads = read('src/lib/jobReads.ts')
check('the switch is its own request, not on every clean\'s shared one', reads.includes("select('clean_start_needs_day')") && !read('src/lib/tenantColumnsCore.ts').includes('clean_start_needs_day'), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
