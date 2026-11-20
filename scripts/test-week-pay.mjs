#!/usr/bin/env node
// My Week's pay in one request (2026-11-20).
//
// My Week used to ask crew_pay_for_period for the running pay through each day
// of the week so far in its own request, all at once (up to 7 per load, 118 ms
// each on average where the whole week takes 6-35 ms in one go). lib/weekPay
// asks crew_pay_through_days (rinse-base-app 20261120165023_crew_pay_through_days) once and hands
// myWeekRead the same per-day answers.
//
// Runs the REAL src/lib/weekPay.ts (with closingBlockers.ts) under Node's type
// stripping, against a fake server whose crew_pay_through_days is, as on the
// real one, crew_pay_for_period asked once per day, and checks:
//   • one request with the start, every day end and the person; each day gets
//     exactly the rows the per-day call gives for it, in order (no rows: []);
//   • a server without the batch (PGRST202, or a 404) gets the per-day calls,
//     with the same arguments as before, and the same answers;
//   • no signal (status 0, or a thrown fetch) is every day's no signal, so My
//     Week falls back to its saved copy; a server error or a malformed answer is
//     every day's error (pay unknown), never a partial or a $0 week, and never
//     the per-day calls;
//   • no days: no request.
//
// Usage: node scripts/test-week-pay.mjs
import { existsSync } from 'node:fs'
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
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') && ctx.parentURL?.includes('/src/lib/')) {
      const file = join(dirname(fileURLToPath(ctx.parentURL)), `${spec}.ts`)
      if (existsSync(file)) return next(pathToFileURL(file).href, ctx)
    }
    return next(spec, ctx)
  },
})
const { weekPayThrough, payRowsByDay } = await import(join(repo, 'src/lib/weekPay.ts'))

const START = '2026-11-16T07:00:00.000Z'
const ENDS = ['2026-11-17T06:59:59.999Z', '2026-11-18T06:59:59.999Z', '2026-11-19T06:59:59.999Z', '2026-11-20T06:59:59.999Z', '2026-11-21T06:59:59.999Z']
const ME = 'u-1'

// crew_pay_for_period's rows through an end: one row for the person, its
// running total growing by day (day 3 paid nothing new), none on day 1.
function payThrough(end) {
  const day = ENDS.indexOf(end) + 1
  if (day === 1) return []
  return [{ user_id: ME, labor_total: [0, 0, 120, 120, 205.5, 290][day], total_minutes: day * 60, jobs: [{ job_id: `j-${day}`, amount: 10 }] }]
}

function server({ batch = 'ok', perDay = 'ok' } = {}) {
  const calls = []
  const rpc = (fn, args) => {
    calls.push([fn, args])
    if (fn === 'crew_pay_through_days') {
      if (batch === 'missing') return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 })
      if (batch === 'missing404') return Promise.resolve({ data: null, error: { message: 'Not Found' }, status: 404 })
      if (batch === 'offline') return Promise.resolve({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 })
      if (batch === 'throws') return Promise.reject(new Error('fetch failed'))
      if (batch === 'error') return Promise.resolve({ data: null, error: { code: 'P0001', message: 'crew_pay_for_period: not allowed' }, status: 400 })
      if (batch === 'malformed') return Promise.resolve({ data: [{ day_index: 9, pay: {} }], error: null, status: 200 })
      if (batch === 'notarray') return Promise.resolve({ data: { day_index: 1 }, error: null, status: 200 })
      // As the real one: crew_pay_for_period per end, numbered from 1.
      return Promise.resolve({ data: args.p_ends.flatMap((e, i) => payThrough(e).map(pay => ({ day_index: i + 1, pay }))), error: null, status: 200 })
    }
    if (fn === 'crew_pay_for_period') {
      if (perDay === 'offline') return Promise.resolve({ data: null, error: { message: 'Network request failed' }, status: 0 })
      return Promise.resolve({ data: payThrough(args.p_end), error: null, status: 200 })
    }
    return Promise.resolve({ data: null, error: { message: `unknown ${fn}` }, status: 404 })
  }
  return { rpc, calls }
}
const oldWay = ENDS.map(e => ({ data: payThrough(e), error: null, status: 200 }))

// ── One request ─────────────────────────────────────────────────────────────
{
  const s = server()
  const got = await weekPayThrough(s.rpc, START, ENDS, ME)
  check('one request: crew_pay_through_days with the start, every day end and the person', s.calls, [['crew_pay_through_days', { p_start: START, p_ends: ENDS, p_user_id: ME }]])
  check('each day is exactly what the per-day call answered (day 1 paid nothing: no rows)', got, oldWay)
}
{
  const rows = [{ day_index: 2, pay: { a: 1 } }, { day_index: 2, pay: { a: 2 } }, { day_index: 1, pay: { a: 0 } }]
  check('rows split by day, in the order they came', payRowsByDay(rows, 3), [[{ a: 0 }], [{ a: 1 }, { a: 2 }], []])
}

// ── The fallback ────────────────────────────────────────────────────────────
for (const batch of ['missing', 'missing404']) {
  const s = server({ batch })
  const got = await weekPayThrough(s.rpc, START, ENDS, ME)
  check(`no batch on the server (${batch === 'missing' ? 'PGRST202' : 'a 404'}): the per-day calls, with the arguments the app always sent`,
    s.calls.slice(1), ENDS.map(e => ['crew_pay_for_period', { p_start: START, p_end: e, p_user_id: ME }]))
  check('…and the same answers', got, oldWay)
}
{
  const s = server({ batch: 'missing', perDay: 'offline' })
  const got = await weekPayThrough(s.rpc, START, ENDS, ME)
  check('…whose own failures come through as they did', got.map(d => d.status), ENDS.map(() => 0))
}

// ── One outcome ─────────────────────────────────────────────────────────────
for (const batch of ['offline', 'throws']) {
  const s = server({ batch })
  const got = await weekPayThrough(s.rpc, START, ENDS, ME)
  check(`no signal (${batch === 'offline' ? 'status 0' : 'a thrown fetch'}): every day says status 0, so My Week shows its saved copy`,
    [got.length, got.every(d => d.error && d.status === 0 && d.data === null)], [ENDS.length, true])
  check('…and the per-day calls are not tried', s.calls.length, 1)
}
{
  const s = server({ batch: 'error' })
  const got = await weekPayThrough(s.rpc, START, ENDS, ME)
  check('a server error is every day\'s error (pay unknown), with its message, and no per-day calls',
    [got.every(d => d.error?.message === 'crew_pay_for_period: not allowed' && d.status === 400 && d.data === null), s.calls.length], [true, 1])
}
for (const batch of ['malformed', 'notarray']) {
  const got = await weekPayThrough(server({ batch }).rpc, START, ENDS, ME)
  check(`a malformed answer (${batch}) is every day's error, never a $0 week`, got.every(d => d.error && d.data === null), true)
}

// ── No days ─────────────────────────────────────────────────────────────────
{
  const s = server()
  check('no days: nothing asked, nothing answered', [await weekPayThrough(s.rpc, START, [], ME), s.calls.length], [[], 0])
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
