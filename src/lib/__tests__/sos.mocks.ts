// Test doubles for sosQueue.ts (and sosTracker.ts), swapped in by
// scripts/test-sos.mjs and scripts/test-sos-tracker.mjs.
//
// Unlike outbox.mocks.ts this does NOT fake the supabase client. The runners
// build the REAL @supabase/supabase-js client and hand it `fakeFetch` below,
// so "offline" here is the real postgrest-js turning a rejected fetch into
// { error, status: 0 }, the discriminator every offline path in the app relies
// on, not a fake returning status 0 because it was told to. The Expo push goes
// through the same fetch.

// ── AsyncStorage, in memory ──
// failWrites: a full phone. failReads: a read that throws (Android can fail one
// under memory pressure). onRead: act at an exact point between a read and
// what the reader does next.
const store = new Map<string, string>()
export const storage = {
  store,
  failWrites: false,
  failReads: false,
  onRead: null as null | (() => void),
}

export const AsyncStorage = {
  async getItem(k: string) {
    if (storage.failReads) throw new Error('CursorWindow: Could not allocate')
    const v = store.has(k) ? store.get(k)! : null
    storage.onRead?.()
    return v
  },
  async setItem(k: string, v: string) {
    if (storage.failWrites) throw new Error('ENOSPC: no space left on device')
    store.set(k, v)
  },
  async removeItem(k: string) { store.delete(k) },
  async getAllKeys() {
    if (storage.failReads) throw new Error('CursorWindow: Could not allocate')
    return [...store.keys()]
  },
}

// ── errorReporter ──
export const reported: string[] = []
export function reportClientError(message?: string) { reported.push(String(message)) }

// ── The network ──
// online    answers normally
// offline   fetch rejects the way React Native's does with no signal
// hang      the request never answers (one weak bar); only an abort ends it
// lose-ack  the server applies the request, then the answer is lost
// slow      answers after `delayMs`
export type Mode = 'online' | 'offline' | 'hang' | 'lose-ack' | 'slow'
export const net = {
  rest: 'online' as Mode,
  expo: 'online' as Mode,
  delayMs: 40,
  // Per-request mode, checked first: return null to fall through to rest/expo.
  override: null as null | ((method: string, url: URL) => Mode | null),
  refuse: new Set<string>(),   // tables that answer 403 (row-level security)
  calls: [] as { host: string; method: string; path: string; query: string; id?: string }[],
}

export const server = {
  sos_alerts: new Map<string, Record<string, any>>(),
  sos_pings: [] as Record<string, any>[],
  push_tokens: [] as { tenant_id: string; user_id: string; token: string; role: string }[],
  pushes: [] as any[][],       // one entry per Expo request: its message array
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// PostgREST equality filters, e.g. ?id=eq.abc&status=eq.active
function eqFilters(url: URL): [string, string][] {
  const out: [string, string][] = []
  url.searchParams.forEach((v, k) => { if (v.startsWith('eq.')) out.push([k, v.slice(3)]) })
  return out
}

// Just enough PostgREST for the calls sosQueue and sosTracker make.
function postgrest(url: URL, method: string, headers: Headers, body: any): Response {
  const table = url.pathname.replace('/rest/v1/', '')
  if (net.refuse.has(table)) {
    return json(403, { code: '42501', message: `new row violates row-level security policy for table "${table}"` })
  }
  const prefer = headers.get('Prefer') || ''
  if (table === 'sos_alerts' && method === 'POST') {
    for (const row of Array.isArray(body) ? body : [body]) {
      const existing = server.sos_alerts.get(row.id)
      if (existing && prefer.includes('resolution=ignore-duplicates')) continue
      if (existing && prefer.includes('resolution=merge-duplicates')) { Object.assign(existing, row); continue }
      if (existing) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "sos_alerts_pkey"' })
      server.sos_alerts.set(row.id, { status: 'active', ...row })
    }
    return new Response(null, { status: 201 })
  }
  if (table === 'sos_alerts' && method === 'PATCH') {
    const filters = eqFilters(url)
    for (const row of server.sos_alerts.values()) {
      if (filters.every(([k, v]) => String(row[k]) === v)) Object.assign(row, body)
    }
    return new Response(null, { status: 204 })
  }
  if (table === 'sos_alerts' && method === 'GET') {
    const filters = eqFilters(url)
    return json(200, [...server.sos_alerts.values()].filter(row => filters.every(([k, v]) => String(row[k]) === v)))
  }
  if (table === 'sos_pings' && method === 'POST') {
    // RLS sos_pings_insert: the parent alert must exist.
    const row = Array.isArray(body) ? body[0] : body
    if (!server.sos_alerts.has(row.alert_id)) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "sos_pings"' })
    server.sos_pings.push(row)
    return new Response(null, { status: 201 })
  }
  if (table === 'push_tokens' && method === 'GET') {
    const filters = eqFilters(url)
    const rows = server.push_tokens.filter(r => filters.every(([k, v]) => String((r as any)[k]) === v))
    return json(200, rows.map(r => ({ token: r.token, user_id: r.user_id, users: { role: r.role } })))
  }
  return json(404, { message: `fake PostgREST has no route for ${method} ${table}` })
}

function expo(body: any[]): Response {
  server.pushes.push(body)
  return json(200, { data: body.map(() => ({ status: 'ok', id: 'ticket' })) })
}

const aborted = () => new DOMException('The operation was aborted.', 'AbortError')

export async function fakeFetch(input: any, init: any = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input))
  const method = String(init.method || 'GET').toUpperCase()
  const isExpo = url.hostname === 'exp.host'
  const mode = net.override?.(method, url) ?? (isExpo ? net.expo : net.rest)
  const signal: AbortSignal | undefined = init.signal
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  net.calls.push({
    host: url.hostname, method, path: url.pathname, query: url.search,
    id: body ? (Array.isArray(body) ? body[0]?.id : body.id) : undefined,
  })

  if (signal?.aborted) throw aborted()
  if (mode === 'offline') throw new TypeError('Network request failed')
  if (mode === 'hang') {
    return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(aborted())))
  }
  if (mode === 'slow') {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, net.delayMs)
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(aborted()) })
    })
  }
  const res = isExpo ? expo(body) : postgrest(url, method, new Headers(init.headers), body)
  if (mode === 'lose-ack') throw new TypeError('Network request failed')
  return res
}
