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
  applied: [] as { table: string; op: string; values: any }[],
}

function result(table: string, op: string, values: any) {
  if (!net.online) return { error: { message: 'TypeError: fetch failed' }, status: 0 }
  if (net.rejectTables.has(table)) return { error: { message: 'violates row-level security' }, status: 403 }
  net.applied.push({ table, op, values })
  return { error: null, status: 201 }
}

// Thenable builder: resolves lazily like postgrest-js, so .eq()/.is() chains work.
function builder(table: string, op: string, values: any) {
  const p: any = {
    eq: () => p,
    is: () => p,
    then: (f: any) => Promise.resolve(result(table, op, values)).then(f),
  }
  return p
}

export const supabase = {
  from: (table: string) => ({
    upsert: (values: any, _opts?: any) => builder(table, 'upsert', values),
    update: (values: any) => builder(table, 'update', values),
  }),
}

export const reported: string[] = []
export function reportClientError(msg: string) { reported.push(msg) }
