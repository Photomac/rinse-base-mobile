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
  /** Server-side RUNNING per-job entries, keyed `${job_id}|${user_id}`. Only
   *  consulted once a test seeds it; mirrors job_time_entries_one_open_per_job. */
  openWork: new Map<string, { id: string; clocked_in_at: string }>(),
}

const filterVal = (filters: string[], k: string) =>
  filters.find(f => f.startsWith(`${k}=eq.`))?.slice(k.length + 4)

function result(table: string, op: string, values: any, filters: string[]) {
  if (!net.online) return { error: { message: 'TypeError: fetch failed' }, status: 0 }
  if (net.rejectTables.has(table) && (!net.rejectOp || net.rejectOp === op)) {
    return { error: { message: 'violates row-level security' }, status: 403 }
  }
  if (table === 'job_time_entries' && net.openWork.size) {
    if (op === 'select') {
      const hit = net.openWork.get(`${filterVal(filters, 'job_id')}|${filterVal(filters, 'user_id')}`)
      return { data: hit ? [{ ...hit }] : [], error: null, status: 200 }
    }
    if (op === 'upsert' && !Array.isArray(values) && values?.job_id && !values.clocked_out_at && values.entry_type !== 'shift') {
      const key = `${values.job_id}|${values.user_id}`
      const running = net.openWork.get(key)
      if (running && running.id !== values.id) {
        return { error: { code: '23505', message: 'duplicate key value violates unique constraint "job_time_entries_one_open_per_job"' }, status: 409 }
      }
      net.openWork.set(key, { id: values.id, clocked_in_at: values.clocked_in_at })
    }
    if (op === 'update') {
      const id = filterVal(filters, 'id')
      for (const [k, v] of net.openWork) {
        if (v.id !== id) continue
        if (values?.clocked_out_at) net.openWork.delete(k)
        else if (values?.clocked_in_at) v.clocked_in_at = values.clocked_in_at
      }
    }
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
    order: () => p,
    limit: () => p,
    then: (f: any) => Promise.resolve(result(table, op, values, filters)).then(f),
  }
  return p
}

export const supabase = {
  from: (table: string) => ({
    select: (_cols?: string) => builder(table, 'select', null),
    upsert: (values: any, _opts?: any) => builder(table, 'upsert', values),
    update: (values: any) => builder(table, 'update', values),
    delete: () => builder(table, 'delete', null),
  }),
}

export const reported: string[] = []
export function reportClientError(msg: string) { reported.push(msg) }
