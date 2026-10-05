// Test doubles for photoQueue.ts — swapped in for the real modules by
// scripts/test-photo-queue.mjs at build time. AsyncStorage answers after a
// random 0–3 ms, so two writers that don't take turns really do lose each
// other's changes here, as they can on a phone. The network is controlled per
// test through `net`; a held upload stays in flight until release().
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

export const FileSystem = {
  documentDirectory: 'file:///app/NEW/Documents/',
  async getInfoAsync(uri: string) { return { exists: files.has(uri) } },
  async makeDirectoryAsync(_uri: string, _opts?: any) {},
  async copyAsync({ from, to }: { from: string; to: string }) {
    if (!files.has(from)) throw new Error(`copy: no such file ${from}`)
    files.add(to)
  },
  async deleteAsync(uri: string, _opts?: any) { files.delete(uri) },
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
  attaches: [] as { p_report_id: string; p_url: string }[],
  attachResult: 'ok' as 'ok' | 'no_report',
}

export function release() {
  net.hold = false
  const held = net.held.splice(0)
  held.forEach(r => r())
}

export class MockFormData {
  parts: [string, any][] = []
  append(k: string, v: any) { this.parts.push([k, v]) }
}

// React Native's fetch fails a multipart part whose file is missing exactly
// like a dead network: TypeError "Network request failed".
export async function fetchMock(url: string, init: any): Promise<any> {
  const name = url.split('/job-photos/')[1]
  const part = (init.body as MockFormData).parts.find(([k]) => k === 'file')?.[1]
  if (net.offline || !part || !files.has(part.uri)) throw new TypeError('Network request failed')
  net.attempts.push(name)
  if (net.slow.has(name)) {
    await new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    }))
  }
  if (net.hold) await new Promise<void>(r => net.held.push(r))
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
      net.rows.push(row)
      return { error: null, status: 201 }
    },
  }),
  rpc: async (_fn: string, args: any) => {
    if (net.offline) return { data: null, error: { message: 'TypeError: fetch failed' }, status: 0 }
    net.attaches.push(args)
    return { data: net.attachResult === 'no_report' ? 'no_report' : 'attached', error: null, status: 200 }
  },
}

export async function usableAccessToken() { return 'token' }

export const reported: string[] = []
export function reportClientError(msg?: string) { reported.push(msg || '') }
