// Test doubles for photoQueue.ts — swapped in for the real modules by
// scripts/test-photo-queue.mjs at build time. AsyncStorage answers after a
// random 0–3 ms, so two writers that don't take turns really do lose each
// other's changes here, as they can on a phone. The network is controlled per
// test through `net`; a held upload stays in flight until release(). Storage
// keeps who uploaded each file and, like job-photos after rinse-base-app
// #1391, refuses an overwrite by anyone else.
const store = new Map<string, string>()
const QUEUE_KEY = 'rinsebase.photoQueue.v1'
const jitter = () => new Promise(r => setTimeout(r, Math.random() * 3))

export const AsyncStorage = {
  async getItem(k: string) { await jitter(); return store.has(k) ? store.get(k)! : null },
  async setItem(k: string, v: string) { await jitter(); store.set(k, v) },
}

export function rawQueue(): any[] {
  const raw = store.get(QUEUE_KEY)
  return raw ? JSON.parse(raw) : []
}
export function setRawQueue(q: any[]) { store.set(QUEUE_KEY, JSON.stringify(q)) }

/** Files on the "phone". */
export const files = new Set<string>()
/** What a file holds; a file not listed here holds its own uri's bytes. */
export const fileBytes = new Map<string, Uint8Array>()
export function bytesOf(uri: string): Uint8Array {
  return fileBytes.get(uri) ?? new Uint8Array(Buffer.from(uri))
}
/** Files whose read fails (the fingerprint can't be worked out). */
export const unreadable = new Set<string>()
/** Every readAsStringAsync, by uri. */
export const fsReads: string[] = []

export const FileSystem = {
  documentDirectory: 'file:///app/NEW/Documents/',
  EncodingType: { UTF8: 'utf8', Base64: 'base64' } as const,
  async getInfoAsync(uri: string) { return { exists: files.has(uri) } },
  async makeDirectoryAsync(_uri: string, _opts?: any) {},
  async copyAsync({ from, to }: { from: string; to: string }) {
    if (!files.has(from)) throw new Error(`copy: no such file ${from}`)
    files.add(to)
    fileBytes.set(to, bytesOf(from))
  },
  async deleteAsync(uri: string, _opts?: any) { files.delete(uri); fileBytes.delete(uri) },
  async readAsStringAsync(uri: string, opts?: { encoding?: string }) {
    fsReads.push(uri)
    if (opts?.encoding !== 'base64') throw new Error('read: test only reads base64')
    if (!files.has(uri) || unreadable.has(uri)) throw new Error(`read: could not read ${uri}`)
    return Buffer.from(bytesOf(uri)).toString('base64')
  },
}

export const net = {
  offline: false,
  /** Hold every upload in flight until release(). */
  hold: false,
  held: [] as (() => void)[],
  /** Storage names whose upload never finishes (only the timeout ends it). */
  slow: new Set<string>(),
  /** Every storage POST that reached the fake server, in order. */
  attempts: [] as string[],
  /** Storage names that finished uploading, in order. */
  uploads: [] as string[],
  /** The file uri each upload was read from. */
  readFrom: [] as string[],
  rows: [] as any[],
  /** Every job_photos insert that reached the server, kept or refused. */
  inserts: [] as any[],
  /** The database doesn't have job_photos.taken_at yet (migration not applied). */
  noTakenAtColumn: false,
  /** The database doesn't have job_photos.photo_sha256 yet. */
  noSha256Column: false,
  /** The database doesn't have job_photos.check_first_line_id yet, said the
   *  way PostgREST says it (PGRST204) or the way Postgres does (42703). */
  noCheckFirstColumn: false as false | 'PGRST204' | '42703',
  attaches: [] as { p_report_id: string; p_url: string }[],
  attachResult: 'ok' as 'ok' | 'no_report',
  /** Who is signed in on the phone (the bearer token names them). */
  token: 'A',
  /** What storage holds, by name: who uploaded it and its bytes. */
  storage: new Map<string, { owner: string; bytes: Uint8Array }>(),
  /** Storage names whose upload lands but whose answer never reaches the phone. */
  loseAnswer: new Set<string>(),
  /** Storage refuses every new file (a policy that says no). */
  refuseNew: false,
  /** HEADs of public URLs, in order. */
  heads: [] as string[],
  /** A HEAD gets no answer. */
  headFails: false,
  /** The next job_photos insert lands but its answer never reaches the phone. */
  loseInsertAnswer: false,
  /** Hold the next job_photos insert's answer (the row is written) until release(). */
  holdInsert: false,
  /** job_photos lookups fail at the server. */
  selectFails: false,
  /** Every job_photos lookup that reached the server: its filters. */
  selects: [] as Record<string, unknown>[],
}

export function release() {
  net.hold = false
  net.holdInsert = false
  const held = net.held.splice(0)
  held.forEach(r => r())
}

export class MockFormData {
  parts: [string, any][] = []
  append(k: string, v: any) { this.parts.push([k, v]) }
}

const rlsRefusal = () => ({
  ok: false, status: 400,
  text: async () => JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }),
})

// React Native's fetch fails a multipart part whose file is missing exactly
// like a dead network: TypeError "Network request failed".
export async function fetchMock(url: string, init: any): Promise<any> {
  const name = url.split('/job-photos/')[1]
  if (init?.method === 'HEAD') {
    net.heads.push(name)
    if (net.offline || net.headFails) throw new TypeError('Network request failed')
    return net.storage.has(name) ? { ok: true, status: 200 } : { ok: false, status: 400 }
  }
  const part = (init.body as MockFormData).parts.find(([k]) => k === 'file')?.[1]
  if (net.offline || !part || !files.has(part.uri)) throw new TypeError('Network request failed')
  net.attempts.push(name)
  const uploader = String(init.headers?.Authorization ?? '').replace('Bearer ', '')
  const existing = net.storage.get(name)
  if (existing ? existing.owner !== uploader : net.refuseNew) return rlsRefusal()
  if (net.slow.has(name)) {
    await new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    }))
  }
  if (net.hold) await new Promise<void>(r => net.held.push(r))
  net.storage.set(name, { owner: uploader, bytes: bytesOf(part.uri) })
  if (net.loseAnswer.delete(name)) throw new TypeError('Network request failed')
  net.uploads.push(name)
  net.readFrom.push(part.uri)
  return { ok: true, status: 200, text: async () => '' }
}

export const supabase = {
  storage: {
    from: (_bucket: string) => ({
      getPublicUrl: (name: string) => ({ data: { publicUrl: `https://cdn.test/job-photos/${name}` } }),
    }),
  },
  from: (_table: string) => ({
    insert: async (row: any) => {
      if (net.offline) return { error: { message: 'TypeError: fetch failed' }, status: 0 }
      net.inserts.push({ ...row })
      if (net.noTakenAtColumn && 'taken_at' in row) {
        return { error: { code: 'PGRST204', message: "Could not find the 'taken_at' column of 'job_photos' in the schema cache" }, status: 400 }
      }
      if (net.noSha256Column && 'photo_sha256' in row) {
        return { error: { code: 'PGRST204', message: "Could not find the 'photo_sha256' column of 'job_photos' in the schema cache" }, status: 400 }
      }
      if (net.noCheckFirstColumn && 'check_first_line_id' in row) {
        return net.noCheckFirstColumn === 'PGRST204'
          ? { error: { code: 'PGRST204', message: "Could not find the 'check_first_line_id' column of 'job_photos' in the schema cache" }, status: 400 }
          : { error: { code: '42703', message: 'column "check_first_line_id" of relation "job_photos" does not exist' }, status: 400 }
      }
      net.rows.push({ ...row })
      if (net.holdInsert) {
        net.holdInsert = false
        await new Promise<void>(r => net.held.push(r))
      }
      if (net.loseInsertAnswer) {
        net.loseInsertAnswer = false
        return { error: { message: 'TypeError: Network request failed' }, status: 0 }
      }
      return { error: null, status: 201 }
    },
    select: (_columns: string) => {
      const filters: [string, unknown][] = []
      const query = {
        eq(column: string, value: unknown) { filters.push([column, value]); return query },
        async limit(n: number) {
          if (net.offline) return { data: null, error: { message: 'TypeError: fetch failed' }, status: 0 }
          net.selects.push(Object.fromEntries(filters))
          if (net.selectFails) return { data: null, error: { message: 'canceling statement due to statement timeout' }, status: 500 }
          const found = net.rows.filter(r => filters.every(([k, v]) => r[k] === v)).slice(0, n)
          return { data: found.map((_, i) => ({ id: `row-${i}` })), error: null, status: 200 }
        },
      }
      return query
    },
  }),
  rpc: async (_fn: string, args: any) => {
    if (net.offline) return { data: null, error: { message: 'TypeError: fetch failed' }, status: 0 }
    net.attaches.push(args)
    return { data: net.attachResult === 'no_report' ? 'no_report' : 'attached', error: null, status: 200 }
  },
}

export async function usableAccessToken() { return net.token }

export const reported: string[] = []
export function reportClientError(msg?: string) { reported.push(msg || '') }
