// Test doubles for outbox.ts — swapped in for the real modules by
// scripts/test-outbox.mjs at build time. In-memory AsyncStorage plus a fake
// supabase whose network you control per-test: `net.online = false` makes
// every call fail the way postgrest-js 2.99.2 fails on a dead network
// (error + status 0 — verified against the real client 2026-08-09), and
// `net.rejectTables` simulates a real server rejection (RLS 403).
const store = new Map<string, string>()

export const AsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null },
  async setItem(k: string, v: string) { store.set(k, v) },
  async removeItem(k: string) { store.delete(k) },
}

export const net = {
  online: false,
  rejectTables: new Set<string>(),
  /** Reject only this op kind on rejectTables (unset = every op). */
  rejectOp: null as string | null,
  applied: [] as { table: string; op: string; values: any; filters: string[] }[],
}

function result(table: string, op: string, values: any, filters: string[]) {
  if (!net.online) return { error: { message: 'TypeError: fetch failed' }, status: 0 }
  if (net.rejectTables.has(table) && (!net.rejectOp || net.rejectOp === op)) {
    return { error: { message: 'violates row-level security' }, status: 403 }
  }
  net.applied.push({ table, op, values, filters })
  return { error: null, status: 201 }
}

// Thenable builder: resolves lazily like postgrest-js, so .eq()/.is()/.not()
// chains work. Filters are recorded as text so tests can check what a delete
// would have matched.
function builder(table: string, op: string, values: any) {
  const filters: string[] = []
  const p: any = {
    eq: (k: string, v: any) => { filters.push(`${k}=eq.${v}`); return p },
    is: (k: string, v: any) => { filters.push(`${k}=is.${v}`); return p },
    not: (k: string, o: string, v: any) => { filters.push(`${k}=not.${o}.${v}`); return p },
    in: (k: string, v: any[]) => { filters.push(`${k}=in.(${v.join(',')})`); return p },
    then: (f: any) => Promise.resolve(result(table, op, values, filters)).then(f),
  }
  return p
}

export const supabase = {
  from: (table: string) => ({
    upsert: (values: any, _opts?: any) => builder(table, 'upsert', values),
    update: (values: any) => builder(table, 'update', values),
    delete: () => builder(table, 'delete', null),
  }),
}

export const reported: string[] = []
export function reportClientError(msg: string) { reported.push(msg) }
