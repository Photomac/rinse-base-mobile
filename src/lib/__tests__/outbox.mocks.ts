// Test doubles for outbox.ts — swapped in for the real modules by
// scripts/test-outbox.mjs at build time. In-memory AsyncStorage plus a fake
// supabase whose network you control per-test: `net.online = false` makes
// every call fail the way postgrest-js 2.99.2 fails on a dead network
// (error + status 0 — verified against the real client 2026-08-09), and
// `net.rejectTables` simulates a real server rejection (RLS 403).
//
// `net.openShifts` models the one-open-day-shift index
// (job_time_entries_one_open_shift): an upsert of an open shift for a user who
// already has a different one open gets 23505 / 409, as PostgREST returns it.
const store = new Map<string, string>()

export const AsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null },
  async setItem(k: string, v: string) { store.set(k, v) },
  async removeItem(k: string) { store.delete(k) },
}

export const net = {
  online: false,
  rejectTables: new Set<string>(),
  applied: [] as { table: string; op: string; values: any; match: Record<string, any> }[],
  openShifts: new Map<string, { id: string; clocked_in_at: string }>(),
  // The open shift is ended between the refused insert and the read-back.
  hideOpenOnRead: false,
}

function result(table: string, op: string, values: any, match: Record<string, any>) {
  if (!net.online) return { error: { message: 'TypeError: fetch failed' }, status: 0 }
  if (net.rejectTables.has(table)) return { error: { message: 'violates row-level security' }, status: 403 }
  if (table === 'job_time_entries') {
    if (op === 'upsert' && values?.entry_type === 'shift' && !values?.clocked_out_at) {
      const open = net.openShifts.get(values.user_id)
      if (open && open.id !== values.id) {
        return { error: { code: '23505', message: 'duplicate key value violates unique constraint "job_time_entries_one_open_shift"' }, status: 409 }
      }
      net.openShifts.set(values.user_id, { id: values.id, clocked_in_at: values.clocked_in_at })
    }
    if (op === 'update') {
      for (const [u, s] of net.openShifts) {
        if (s.id !== match.id) continue
        if (values?.clocked_out_at) net.openShifts.delete(u)
        else if (values?.clocked_in_at) net.openShifts.set(u, { ...s, clocked_in_at: values.clocked_in_at })
      }
    }
  }
  net.applied.push({ table, op, values, match })
  return { error: null, status: 201 }
}

// Thenable builder: resolves lazily like postgrest-js, so .eq()/.is() chains work.
function builder(table: string, op: string, values: any) {
  const match: Record<string, any> = {}
  const p: any = {
    eq: (k: string, v: any) => { match[k] = v; return p },
    is: (k: string, v: any) => { match[k] = v; return p },
    then: (f: any) => Promise.resolve(result(table, op, values, match)).then(f),
  }
  return p
}

// Reads: only "this user's open shift" is modelled, which is all outbox.ts asks.
function reader(table: string) {
  const filters: Record<string, any> = {}
  const p: any = {
    eq: (k: string, v: any) => { filters[k] = v; return p },
    is: (k: string, v: any) => { filters[k] = v; return p },
    order: () => p,
    limit: () => p,
    then: (f: any) => {
      if (!net.online) return Promise.resolve({ data: null, error: { message: 'TypeError: fetch failed' }, status: 0 }).then(f)
      const open = table === 'job_time_entries' && !net.hideOpenOnRead ? net.openShifts.get(filters.user_id) : undefined
      return Promise.resolve({ data: open ? [open] : [], error: null, status: 200 }).then(f)
    },
  }
  return p
}

export const supabase = {
  from: (table: string) => ({
    upsert: (values: any, _opts?: any) => builder(table, 'upsert', values),
    update: (values: any) => builder(table, 'update', values),
    select: (_cols?: string) => reader(table),
  }),
}

export const reported: string[] = []
export function reportClientError(msg: string) { reported.push(msg) }
