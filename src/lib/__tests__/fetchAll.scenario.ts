// Paged-read scenario test. Run with: node scripts/test-fetchall.mjs
//
// Exercises the REAL src/lib/fetchAll.ts and src/lib/dataCache.ts (dataCache's
// AsyncStorage import rewritten to fetchAll.mocks.ts by the runner) against a
// fake PostgREST table that cuts an unranged read at 1,000 rows, the way
// Supabase does.
//
// The bug: ScheduleScreen read a whole tenant's window with no range. Lee
// Concierge had 1,370 cleans in it on 2026-09-28, so row 1,000 fell on Oct 11
// and every clean after it vanished from every phone, owner and crew, with no
// error anywhere. The invariants below are the ones the fix promises, plus the
// offline one it must not break: a dead network still falls back to the last
// COMPLETE schedule, and a half-read one is never cached or shown.
import { fetchAllPages } from '../fetchAll'
import { cachedQuery } from '../dataCache'
import { fakeTable, store, MAX_ROWS, type Row } from './fetchAll.mocks'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// A window shaped like Lee's on 2026-09-28: near-term calendars fill first, so
// the first 1,000 cleans sit in Aug 28 – Oct 11 and the rest spread to Nov 28.
// Several share each slot, so page boundaries land inside runs of equal start
// times.
function tenantWindow(n: number): Row[] {
  const dense = Math.min(n, 1000)
  const rows: Row[] = []
  for (let i = 0; i < n; i++) {
    const offset = i < dense ? Math.floor(i * 45 / dense) : 44 + Math.ceil((i - dense + 1) * 48 / (n - dense))
    const day = new Date(Date.UTC(2026, 7, 28 + offset))
    day.setUTCHours(17 + (i % 3))
    // Ids don't follow start order, so the id tiebreak actually does something.
    rows.push({ id: `job-${String((i * 7919) % 100000).padStart(5, '0')}`, scheduled_start: day.toISOString() })
  }
  return rows
}
const same = (a: Row[] | null, b: Row[]) =>
  !!a && a.length === b.length && a.every((r, i) => r.id === b[i].id)
const lastDay = (rows: Row[] | null) => rows?.[rows.length - 1]?.scheduled_start.slice(0, 10)

;(async () => {
  // ── The bug, reproduced: an unranged read silently stops at row 1,000 ─────
  const lee = fakeTable(tenantWindow(1370))
  const expected = lee.all
  const old = await lee.unranged()
  ok('old read: 1,000 of 1,370 rows, no error', old.data.length === MAX_ROWS && old.error === null)
  ok('old read: schedule ends mid-October, not Nov 28', lastDay(old.data) === '2026-10-11' && lastDay(expected) === '2026-11-28')

  // ── The fix: every row, in order, no page-boundary skips or repeats ───────
  const all = await fetchAllPages<Row>(() => lee.query())
  ok('paged read returns all 1,370 rows in ORDER BY order', same(all.data, expected) && all.error === null)
  ok('no duplicate ids across the page boundary', new Set(all.data?.map(r => r.id)).size === 1370)
  ok('two requests: rows 0-999, then 1000-1999',
    lee.requests.length === 2 && lee.requests[0].from === 0 && lee.requests[0].to === 999 && lee.requests[1].from === 1000)

  // ── Edges of the stop rule ───────────────────────────────────────────────
  const exact = fakeTable(tenantWindow(1000))
  const ex = await fetchAllPages<Row>(() => exact.query())
  ok('exactly 1,000 rows: a full page is not taken as the last one', ex.data?.length === 1000 && exact.requests.length === 2)
  const short = fakeTable(tenantWindow(999))
  ok('999 rows: one request', (await fetchAllPages(() => short.query())).data?.length === 999 && short.requests.length === 1)
  const none = fakeTable([])
  const empty = await fetchAllPages(() => none.query())
  ok('no rows: empty list, not null', Array.isArray(empty.data) && empty.data.length === 0 && none.requests.length === 1)

  // ── Offline: the cache holds the last COMPLETE read ──────────────────────
  const key = 'sched:crew-1'
  const first = await cachedQuery(key, fetchAllPages<Row>(() => lee.query()))
  ok('online read caches all 1,370 rows', !first.fromCache && JSON.parse(store.get('dataCache:' + key)!).length === 1370)

  const drop = fakeTable(tenantWindow(1400))
  drop.failRequest = { index: 1, status: 0 }   // signal dies between page 1 and page 2
  const offline = await cachedQuery(key, fetchAllPages<Row>(() => drop.query()))
  ok('network drop mid-read falls back to the cache', offline.fromCache && offline.error === null)
  ok('...and shows the whole cached schedule, not the half it got', offline.data?.length === 1370)
  ok('...and does not overwrite the cache with a partial read', JSON.parse(store.get('dataCache:' + key)!).length === 1370)

  const denied = fakeTable(tenantWindow(1400))
  denied.failRequest = { index: 1, status: 403 }   // the server says no: honour it
  const refused = await cachedQuery(key, fetchAllPages<Row>(() => denied.query()))
  ok('server refusal on page 2 surfaces the error, no cache fallback', !refused.fromCache && refused.data === null && !!refused.error)
  ok('...and leaves the cache untouched', JSON.parse(store.get('dataCache:' + key)!).length === 1370)

  const cold = fakeTable(tenantWindow(10))
  cold.failRequest = { index: 0, status: 0 }
  const never = await cachedQuery('sched:never-loaded', fetchAllPages(() => cold.query()))
  ok('offline with nothing cached: an error, not a crash', !never.fromCache && !!never.error)

  // ── A server that ignores the range cannot loop forever ─────────────────
  const stuck = fakeTable(tenantWindow(1370))
  stuck.ignoreRange = true
  const runaway = await fetchAllPages(() => stuck.query())
  ok('range-ignoring server stops at the page ceiling with an error', runaway.data === null && !!runaway.error && stuck.requests.length === 10)

  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nAll paged-read invariants hold.')
})()
