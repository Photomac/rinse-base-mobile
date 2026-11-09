// Test doubles for fetchAll.ts + dataCache.ts — swapped in by
// scripts/test-fetchall.mjs. In-memory AsyncStorage, plus a fake PostgREST
// table that behaves like the real server where it matters here: an unranged
// read is silently cut at MAX_ROWS (Supabase's max-rows, 1,000 — measured in
// production as `content-range: 0-999/2023`), a ranged read returns at most
// that many, and failures look the way postgrest-js 2.99 reports them: error +
// status 0 for a dead network, the HTTP status for a real server answer.
export const store = new Map<string, string>()

export const AsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null },
  async setItem(k: string, v: string) { store.set(k, v) },
}

export const MAX_ROWS = 1000

export type Row = { id: string; scheduled_start: string }

export function fakeTable(rows: Row[]) {
  // The order the caller's ORDER BY scheduled_start, id produces.
  const sorted = [...rows].sort((a, b) =>
    a.scheduled_start.localeCompare(b.scheduled_start) || a.id.localeCompare(b.id))
  const t = {
    // Every row, in ORDER BY order: what a correct read must return.
    all: sorted,
    requests: [] as { from: number; to: number }[],
    // Fail the Nth request (0-based) with this status.
    failRequest: null as null | { index: number; status: number },
    // A server that ignores the range and always answers from row 0.
    ignoreRange: false,
    // One builder per request, like postgrest-js: resolving it twice is a bug
    // in the caller, so it throws instead of quietly answering again.
    query() {
      let used = false
      return {
        range(from: number, to: number) {
          if (used) throw new Error('builder re-used: build() must return a fresh one')
          used = true
          const index = t.requests.push({ from, to }) - 1
          return Promise.resolve().then(() => {
            if (t.failRequest?.index === index) {
              const { status } = t.failRequest
              return { data: null, error: { message: status === 0 ? 'TypeError: Network request failed' : 'permission denied' }, status }
            }
            const start = t.ignoreRange ? 0 : from
            return { data: sorted.slice(start, start + Math.min(to - from + 1, MAX_ROWS)), error: null, status: 200 }
          })
        },
      }
    },
    // What the old Schedule read was: one select, no range. The server cuts it.
    async unranged() {
      return { data: sorted.slice(0, MAX_ROWS), error: null, status: 200 }
    },
  }
  return t
}
