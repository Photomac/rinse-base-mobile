// Test doubles for scripts/test-complete-after-photos.mjs: the REAL outbox.ts
// and photoQueue.ts on one phone, against one fake server. Everything
// photoQueue.mocks.ts fakes is reused as is (the shared AsyncStorage, the
// phone's files, storage, the job_photos table: `net`). Added here: the tables
// the outbox writes (`db`), and the completion gate
// (enforce_job_completion_gate), which refuses a Complete with RB_BLOCKED while
// the clean has no after photo row.
import { net, supabase as photoServer } from './photoQueue.mocks'

export * from './photoQueue.mocks'

export const db = {
  /** The outbox's writes get through. (Storage and job_photos follow `net.offline`.) */
  online: true,
  /** Every write to the outbox's tables that reached the server, in order. */
  log: [] as { table: string; op: string; values: any; filters: string[]; refused?: string; rowsAtTheTime: number }[],
  /** jobs.status by id. */
  jobs: new Map<string, string>(),
  /** What the gate says a clean still needs. Default: one after photo row. */
  gate: (jobId: string): { code: string }[] =>
    net.rows.some(r => r.job_id === jobId && r.photo_type === 'after') ? [] : [{ code: 'no_after_photo' }],
  /** Hold the answer to the writes this matches (they are applied) until releaseWrites(). */
  holdWrite: null as null | ((table: string, op: string, values: any) => boolean),
  heldWrites: [] as (() => void)[],
}

export function releaseWrites() {
  db.holdWrite = null
  db.heldWrites.splice(0).forEach(r => r())
}

const filterVal = (filters: string[], k: string) =>
  filters.find(f => f.startsWith(`${k}=eq.`))?.slice(k.length + 4)

async function answer(table: string, op: string, values: any, filters: string[]) {
  if (!db.online) return { error: { message: 'TypeError: Network request failed' }, status: 0 }
  const entry = { table, op, values, filters, rowsAtTheTime: net.rows.length } as (typeof db.log)[number]
  db.log.push(entry)
  if (table === 'jobs' && op === 'update' && values?.status) {
    const id = filterVal(filters, 'id') ?? ''
    if (values.status === 'completed' && db.jobs.get(id) !== 'completed') {
      const blockers = db.gate(id)
      if (blockers.length) {
        entry.refused = `RB_BLOCKED: ${JSON.stringify(blockers)}`
        return { error: { code: 'P0001', message: entry.refused }, status: 400 }
      }
    }
    db.jobs.set(id, values.status)
  }
  if (db.holdWrite?.(table, op, values)) await new Promise<void>(r => db.heldWrites.push(r))
  return { error: null, status: 200 }
}

// postgrest-js style: the filters chain, the request goes when awaited.
function builder(table: string, op: string, values: any) {
  const filters: string[] = []
  const b: any = {
    eq: (k: string, v: any) => { filters.push(`${k}=eq.${v}`); return b },
    is: (k: string, v: any) => { filters.push(`${k}=is.${v}`); return b },
    in: (k: string, v: any[]) => { filters.push(`${k}=in.(${v.join(',')})`); return b },
    not: (k: string, o: string, v: any) => { filters.push(`${k}=not.${o}.${v}`); return b },
    limit: () => b,
    then: (f: any, g: any) => answer(table, op, values, filters).then(f, g),
  }
  return b
}

export const supabase = {
  storage: photoServer.storage,
  rpc: photoServer.rpc,
  from: (table: string) => table === 'job_photos' ? photoServer.from(table) : {
    select: () => builder(table, 'select', null),
    upsert: (values: any) => builder(table, 'upsert', values),
    update: (values: any) => builder(table, 'update', values),
    delete: () => builder(table, 'delete', null),
  },
}
