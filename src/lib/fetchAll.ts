// Paged reads past PostgREST's silent row cap.
//
// Supabase's PostgREST returns AT MOST 1,000 rows for a select with no
// .range()/.limit() — no error, no warning, just a short array cut wherever
// the ORDER BY put row 1,000. The Schedule tab read a whole tenant's window
// that way, and on 2026-09-28 Lee Concierge had 1,370 cleans in it: every
// phone, owner and crew, showed nothing after Oct 11.
//
// fetchAllPages pages explicitly. `build` must return a FRESH builder on every
// call (a postgrest-js builder can't be re-awaited) and must end with a stable
// ORDER BY — a unique column, or an .order('id') tiebreaker after a non-unique
// sort — or a page boundary skips or repeats rows. PAGE must not exceed the
// server's max-rows (1,000), or a capped page reads as the last one.
//
// Unlike the web's fetchAllRows it never throws: it resolves to the same
// { data, error, status } a single postgrest-js query does, so it drops
// straight into cachedQuery. Any failed page fails the whole read with that
// page's status — status 0 (no signal) still falls back to the last good
// cache, and a partial list is never cached or drawn as if it were whole.
const PAGE = 1000
// Ten thousand rows is far past anything a phone should draw; narrow the query
// instead of raising this. It also stops a server that ignored the range from
// looping forever.
const MAX_PAGES = 10

export async function fetchAllPages<T = any>(
  build: () => any,
): Promise<{ data: T[] | null; error: any; status: number }> {
  const out: T[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await build().range(page * PAGE, (page + 1) * PAGE - 1)
    if (res.error) return { data: null, error: res.error, status: res.status }
    const rows: T[] = res.data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return { data: out, error: null, status: res.status }
  }
  return { data: null, error: { message: `fetchAllPages: more than ${MAX_PAGES * PAGE} rows` }, status: 413 }
}
