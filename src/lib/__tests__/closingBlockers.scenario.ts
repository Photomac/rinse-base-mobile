// Needs closing badges scenario test. Run with: node scripts/test-closing-blockers.mjs
//
// Exercises the REAL src/lib/closingBlockers.ts against a fake rpc, then checks
// Home's wiring on its source text (src/ is copied next to the scenario by the
// runner).
//
// Why: Home asked job_completion_blockers() about each open clean in its own
// request, all at once. An office phone at a company with 42 or 55 open cleans
// fired that many requests in a fraction of a second (API logs 2026-11-17/18:
// 367 ms average, 731 ms p90, against ~20 ms for one call alone).
// job_completion_blocker_counts(uuid[]) (rinse-base-app 20261118210000)
// answers them in one request.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closingBlockerCounts, countsFromRows, batchMissing, BATCH_SIZE, FALLBACK_AT_ONCE, type Rpc } from '../closingBlockers'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8')

// The gate's answer per clean, as the server would count it.
const gate = (id: string) => (id.charCodeAt(id.length - 1) % 3)
const ids = (n: number, prefix = 'j') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

type Call = { fn: string; args: any }
function fakeServer(opts: { batch?: 'ok' | 'missing' | 'down'; junk?: boolean } = {}) {
  const calls: Call[] = []
  let inFlight = 0
  let maxInFlight = 0
  const rpc: Rpc = (fn, args) => {
    calls.push({ fn, args })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise(resolve => setTimeout(() => {
      inFlight--
      if (fn === 'job_completion_blocker_counts') {
        if (opts.batch === 'missing') return resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
        if (opts.batch === 'down') return resolve({ data: null, error: { message: 'FetchError: Network request failed', status: 0 } })
        const rows: any[] = (args.p_job_ids as string[]).map(id => ({ job_id: id, blockers: gate(id) }))
        if (opts.junk) rows.push(null, { job_id: '', blockers: 1 }, { job_id: 'x', blockers: -1 }, { job_id: 'y', blockers: 1.5 }, { job_id: 7, blockers: 1 })
        return resolve({ data: rows, error: null })
      }
      if (fn === 'job_completion_blockers') {
        if (args.p_job_id === 'j3') return resolve({ data: null, error: { message: 'timeout' } })
        return resolve({ data: Array.from({ length: gate(String(args.p_job_id)) }, () => ({ code: 'no_after_photo' })), error: null })
      }
      resolve({ data: null, error: { message: `unexpected ${fn}` } })
    }, 1))
  }
  return { rpc, calls, maxInFlight: () => maxInFlight }
}

async function main() {
  // ── one request for a whole office list ──
  {
    const s = fakeServer()
    const out = await closingBlockerCounts(s.rpc, ids(55))
    ok('55 open cleans: one request', s.calls.length === 1 && s.calls[0].fn === 'job_completion_blocker_counts', JSON.stringify(s.calls.map(c => c.fn)))
    ok('it sends all 55 ids', (s.calls[0]?.args.p_job_ids ?? []).length === 55)
    ok('every clean gets the gate\'s count', ids(55).every(id => out[id] === gate(id)))
    ok('no one-clean calls', !s.calls.some(c => c.fn === 'job_completion_blockers'))
  }

  // ── more than one batch, duplicates and blanks ──
  {
    const s = fakeServer()
    const list = [...ids(230), ...ids(20), '', null as any, undefined as any]
    const out = await closingBlockerCounts(s.rpc, list)
    ok(`230 distinct cleans: ${Math.ceil(230 / BATCH_SIZE)} requests of at most ${BATCH_SIZE}`,
      s.calls.length === 3 && s.calls.every(c => c.args.p_job_ids.length <= BATCH_SIZE),
      s.calls.map(c => c.args.p_job_ids.length).join(','))
    ok('each id is asked about once', s.calls.flatMap(c => c.args.p_job_ids).length === 230)
    ok('blank ids are never sent', !s.calls.flatMap(c => c.args.p_job_ids).some((x: any) => !x))
    ok('all 230 answered', Object.keys(out).length === 230)
    ok('the cap stays under the server\'s 200', BATCH_SIZE <= 200)
  }

  // ── malformed rows are dropped ──
  {
    const s = fakeServer({ junk: true })
    const out = await closingBlockerCounts(s.rpc, ids(3))
    ok('junk rows are dropped', Object.keys(out).sort().join(',') === 'j0,j1,j2', Object.keys(out).join(','))
    ok('countsFromRows of a non-array is empty', Object.keys(countsFromRows({ job_id: 'a', blockers: 1 })).length === 0)
  }

  // ── a server without the batch: the one-clean gate, a few at a time ──
  {
    const s = fakeServer({ batch: 'missing' })
    const out = await closingBlockerCounts(s.rpc, ids(10))
    const singles = s.calls.filter(c => c.fn === 'job_completion_blockers')
    ok('batch missing: falls back to the one-clean gate for each clean', singles.length === 10)
    ok(`never more than ${FALLBACK_AT_ONCE} one-clean calls in flight`, s.maxInFlight() <= FALLBACK_AT_ONCE, String(s.maxInFlight()))
    ok('the fallback counts the gate\'s rows', ids(10).filter(id => id !== 'j3').every(id => out[id] === gate(id)))
    ok('a clean whose call failed gets no badge', !('j3' in out))
    ok('PGRST202 and 404 read as missing; a network error does not',
      batchMissing({ code: 'PGRST202' }) && batchMissing({ status: 404 }) && !batchMissing({ status: 0 }) && !batchMissing(null))
  }

  // ── no signal / server error: nothing, and no flood of retries ──
  {
    const s = fakeServer({ batch: 'down' })
    const out = await closingBlockerCounts(s.rpc, ids(55))
    ok('batch down: no badges', Object.keys(out).length === 0)
    ok('batch down: no one-clean calls (no burst)', s.calls.length === 1)
  }
  {
    const throwing: Rpc = () => Promise.reject(new Error('socket hang up'))
    let threw = false
    let out: Record<string, number> = { sentinel: 1 }
    try { out = await closingBlockerCounts(throwing, ids(5)) } catch { threw = true }
    ok('a rejected request does not throw', !threw)
    ok('a rejected request answers nothing', Object.keys(out).length === 0)
  }
  {
    const s = fakeServer()
    const out = await closingBlockerCounts(s.rpc, [])
    ok('no open cleans: no request', s.calls.length === 0 && Object.keys(out).length === 0)
  }

  // ── Home's wiring ──
  const dash = src('screens/DashboardScreen.tsx')
  ok('Home imports closingBlockerCounts', /import \{ closingBlockerCounts \} from '\.\.\/lib\/closingBlockers'/.test(dash))
  ok('Home asks for the Needs closing ids in one call', dash.includes("closingBlockerCounts((fn, args) => supabase.rpc(fn, args), needsClosing.map((j: any) => j.id as string))"))
  ok('Home no longer calls the one-clean gate per open clean', !dash.includes("supabase.rpc('job_completion_blockers'"))
  ok('Home still shows the count it is given', dash.includes('const n = closingBlockers[job.id]') && dash.includes('const isReady = n === 0'))
  const lib = src('lib/closingBlockers.ts')
  ok('the module calls job_completion_blocker_counts with p_job_ids', lib.includes("rpc('job_completion_blocker_counts', { p_job_ids: chunk })"))
  ok('the fallback still calls the one-clean gate by its real name', lib.includes("rpc('job_completion_blockers', { p_job_id: id })"))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
