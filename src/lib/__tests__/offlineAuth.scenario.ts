// Offline sign-in scenario test. Run with: node scripts/test-offline-auth.mjs
//
// Exercises the REAL src/lib/supabase.ts + netFetch.ts + dataCache.ts +
// outbox.ts + locationTracker.ts on top of the REAL supabase-js 2.99.2 that
// ships in the app, with the network replaced by a mock Supabase server whose
// signal you control. Native modules are stubs (offlineAuth.mocks.ts).
//
// The failure this guards against (measured 2026-09-28 against the same
// supabase-js, before the fix): with the hour-long access token expired and
// no signal, getSession() answered NULL after 50.8 s, three parallel reads
// finished one after another at 76 / 102 / 127 s, and the app routed the null
// session to the login screen.
//
// Each scenario runs in its own Node process (module state, the auth client
// and its timers are per-process), started by the runner with the scenario
// name as argv[2]. `baseline` runs the pre-fix client for the before/after.

const h: any = ((globalThis as any).__harness = (globalThis as any).__harness ?? {})
const store: Map<string, string> = (h.store = h.store ?? new Map())
// auth-js console.error()s every failed fetch and refresh; that is the
// condition under test, not a result. Results go through console.log.
console.error = () => {}

// ── Tokens ──────────────────────────────────────────────────────────────────
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const USER = { id: 'auth-u1', aud: 'authenticated', role: 'authenticated', email: 'crew@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
function jwt(expSec: number) {
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER.id, exp: expSec, role: 'authenticated', aud: 'authenticated', n: Math.random() })}.sig`
}
function makeSession(expSec: number, rt = 'rt-0') {
  return { access_token: jwt(expSec), refresh_token: rt, token_type: 'bearer', expires_in: 3600, expires_at: expSec, user: USER }
}
function expOf(token: string): number | null {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp ?? null } catch { return null }
}
const SESSION_KEY = 'sb-cbnbhwclbtowfbjylnph-auth-token'

// ── Mock Supabase server ────────────────────────────────────────────────────
const server = {
  mode: 'online' as 'online' | 'offline' | 'hang',
  refresh: 'ok' as 'ok' | 'revoked' | 'outage',
  clockOffsetMs: 0, // server clock minus phone clock
  tables: {} as Record<string, any[]>,
  rest: [] as { method: string; table: string; token: string; body: any }[],
  expiredRejected: 0,
  refreshCalls: 0,
  issued: [] as string[],
}
const serverNow = () => Date.now() + server.clockOffsetMs
const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

;(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const signal: AbortSignal | undefined = init.signal
  if (signal?.aborted) throw abortError()
  if (server.mode === 'offline') throw new TypeError('Network request failed')
  if (server.mode === 'hang') {
    return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(abortError())))
  }
  const headers = new Headers(init.headers || {})
  const date = new Date(serverNow()).toUTCString()
  const json = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date } })
  const path = url.pathname
  if (path === '/auth/v1/health') return json(200, { name: 'GoTrue' })
  if (path === '/auth/v1/token') {
    server.refreshCalls++
    if (server.refresh === 'revoked') return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' })
    if (server.refresh === 'outage') return json(503, { message: 'Service Unavailable' })
    const s = makeSession(Math.floor(serverNow() / 1000) + 3600, `rt-${server.refreshCalls}`)
    server.issued.push(s.access_token)
    return json(200, s)
  }
  if (path.startsWith('/rest/v1/')) {
    const token = (headers.get('authorization') || '').replace(/^Bearer /, '')
    const exp = expOf(token)
    if (exp != null && exp * 1000 <= serverNow()) {
      server.expiredRejected++
      return json(401, { code: 'PGRST303', message: 'JWT expired' })
    }
    const method = String(init.method || 'GET').toUpperCase()
    const table = path.slice('/rest/v1/'.length)
    server.rest.push({ method, table, token, body: init.body ? JSON.parse(String(init.body)) : null })
    if (method === 'GET') return json(200, server.tables[table] ?? [])
    return new Response('', { status: method === 'DELETE' ? 204 : 201, headers: { date } })
  }
  if (path.startsWith('/functions/v1/')) return json(200, {})
  return json(404, { message: 'not found' })
}

// ── Test plumbing ───────────────────────────────────────────────────────────
let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const timed = async <T>(p: Promise<T>) => { const t0 = Date.now(); const v = await p; return { v, ms: Date.now() - t0 } }
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function seedSession(expSec: number) { store.set(SESSION_KEY, JSON.stringify(makeSession(expSec))) }
function seedCache(key: string, data: any) { store.set(`dataCache:${key}`, JSON.stringify(data)) }
const nowSec = () => Math.floor(Date.now() / 1000)
function load() { return require(process.env.CLIENT_BUNDLE as string) }

function localNoonToday() { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString() }
function localAt(dayOffset: number, hour: number) {
  const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(hour, 0, 0, 0); return d.toISOString()
}

// ── Scenarios ───────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {

  // The field failure: token expired an hour-plus into a dead zone, app cold-
  // started. Then signal returns and the queued punch must replay under a
  // FRESH token.
  async expiredColdStartThenReconnect() {
    seedSession(nowSec() - 600)
    ;['k1', 'k2', 'k3'].forEach(k => seedCache(k, [{ id: k }]))
    server.mode = 'offline'
    const c = load()
    const events: string[] = []
    c.supabase.auth.onAuthStateChange((e: string) => events.push(e))
    const stale = JSON.parse(store.get(SESSION_KEY)!).access_token

    const gs = await timed(c.supabase.auth.getSession())
    const s = (gs.v as any).data.session
    ok('cold start: getSession hands back the stored sign-in', !!s && s.access_token === stale, secs(gs.ms))
    ok('cold start: answered fast (was null after 50.8 s)', gs.ms < 1000, secs(gs.ms))
    ok('an INITIAL_SESSION without a session is NOT a sign-out while the sign-in is stored',
      (await c.isSignedOut('INITIAL_SESSION', null)) === false)

    const reads = await timed(Promise.all(['k1', 'k2', 'k3'].map(k => c.cachedQuery(k, c.supabase.from('jobs').select('id')))))
    ok('3 parallel reads come from the saved copy', (reads.v as any[]).every(r => r.fromCache && r.data?.[0]?.id), secs(reads.ms))
    ok('…in parallel, fast (was 76 / 102 / 127 s one after another)', reads.ms < 1000, secs(reads.ms))

    const entryId = c.uuid4()
    const w = await timed(c.writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id',
      values: { id: entryId, user_id: 'U1', job_id: 'J1', clocked_in_at: new Date().toISOString() } }))
    ok('clock-in queues in the outbox, no error', (w.v as any).queued === true && !(w.v as any).error, secs(w.ms))
    ok('nothing reached the server with the lapsed token', server.expiredRejected === 0)

    // Signal returns.
    server.mode = 'online'
    const t0 = Date.now()
    let fresh: string | null = null
    while (Date.now() - t0 < 20_000) {
      const r = await c.supabase.auth.getSession()
      const tok = r.data.session?.access_token
      if (tok && tok !== stale) { fresh = tok; break }
      await sleep(250)
    }
    const recoverMs = Date.now() - t0
    ok('signal back: token renewed', !!fresh && server.issued.includes(fresh), secs(recoverMs))
    ok('…within ~6 s of signal (holds released, no 12.8 s backoff sleep)', recoverMs < 7000, secs(recoverMs))
    await sleep(50)
    ok('TOKEN_REFRESHED announced (App.tsx reloads the live profile on it)', events.includes('TOKEN_REFRESHED'))

    await c.flushOutbox()
    const replay = server.rest.find(r => r.table === 'job_time_entries' && r.method === 'POST')
    ok('queued clock-in replays on flush', (await c.pendingOpCount()) === 0 && !!replay)
    ok('…under the NEW token', replay?.token === fresh)
    ok('…with the same client-minted id (idempotent replay)', (Array.isArray(replay?.body) ? replay?.body[0] : replay?.body)?.id === entryId)
    ok('no request was ever refused by the server for an expired token', server.expiredRejected === 0)
  },

  // A sign-in the SERVER rejects must not be kept alive by the offline path.
  async revokedSignInIsDropped() {
    seedSession(nowSec() - 600)
    server.mode = 'online'
    server.refresh = 'revoked'
    const c = load()
    const events: string[] = []
    c.supabase.auth.onAuthStateChange((e: string) => events.push(e))
    const r = await c.supabase.auth.getSession()
    await sleep(50)
    ok('revoked refresh token: getSession returns no session', r.data.session === null)
    ok('stored sign-in removed', !store.has(SESSION_KEY))
    ok('SIGNED_OUT announced', events.includes('SIGNED_OUT'))
    ok('isSignedOut: SIGNED_OUT → true', (await c.isSignedOut('SIGNED_OUT', null)) === true)
    ok('isSignedOut: INITIAL_SESSION with nothing stored → true', (await c.isSignedOut('INITIAL_SESSION', null)) === true)
  },

  // One bar of signal: requests that never answer.
  async hungNetworkHitsDeadlines() {
    seedSession(nowSec() + 3000)
    seedCache('today', [{ id: 'J1' }])
    const c = load()
    c.NET_TIMEOUTS.read = 800
    c.NET_TIMEOUTS.write = 1200
    server.mode = 'hang'
    const r = await timed(c.cachedQuery('today', c.supabase.from('jobs').select('id')))
    ok('hung read gives up at its deadline and falls back to the saved copy',
      (r.v as any).fromCache && r.ms >= 700 && r.ms < 2500, secs(r.ms))
    const w = await timed(c.writeThrough({ table: 'jobs', op: 'update', match: { id: 'J1' }, values: { status: 'in_progress' } }))
    ok('hung write gives up at its deadline and queues', (w.v as any).queued === true && w.ms < 3000, secs(w.ms))
  },

  // Network up, auth down (or renewal too slow): the lapsed token must never
  // reach PostgREST, where a 401 is not a fallback case for reads and counts
  // toward parking a queued write.
  async authOutageNeverSendsLapsedToken() {
    seedSession(nowSec() - 600)
    seedCache('today', [{ id: 'J1' }])
    server.mode = 'online'
    server.refresh = 'outage'
    const c = load()
    c.AUTH_WAIT.ms = 1000
    const r = await timed(c.cachedQuery('today', c.supabase.from('jobs').select('id')))
    ok('read falls back to the saved copy', (r.v as any).fromCache === true, secs(r.ms))
    const w = await c.writeThrough({ table: 'jobs', op: 'update', match: { id: 'J1' }, values: { status: 'completed' } })
    ok('write queues instead of failing', w.queued === true && !w.error)
    ok('PostgREST never saw the lapsed token', server.expiredRejected === 0 && server.rest.length === 0)
    server.refresh = 'ok'
    let renewed = false
    for (let i = 0; i < 40 && !renewed; i++) {
      const s = await c.supabase.auth.getSession()
      renewed = server.issued.includes(s.data.session?.access_token ?? '')
      if (!renewed) await sleep(250)
    }
    ok('auth back: renewed', renewed)
    await c.flushOutbox()
    ok('queued write replays', (await c.pendingOpCount()) === 0 && server.rest.some(x => x.method === 'PATCH' && x.table === 'jobs'))
  },

  // A phone whose clock runs 2 h fast sees every token as expired. The server
  // doesn't; its requests must still go out.
  async fastPhoneClockStillWorks() {
    server.clockOffsetMs = -2 * 3600_000
    const serverNowSec = Math.floor((Date.now() + server.clockOffsetMs) / 1000)
    seedSession(serverNowSec + 1800) // fine for the server, 1.5 h "expired" to the phone
    server.tables.jobs = [{ id: 'J9' }]
    server.mode = 'online'
    const c = load()
    const r = await c.cachedQuery('fast', c.supabase.from('jobs').select('id'))
    ok('live read succeeds (not refused as a lapsed token)', r.fromCache === false && r.data?.[0]?.id === 'J9')
    ok('server accepted it', server.expiredRejected === 0 && server.rest.length === 1)
  },

  // Unchanged behaviour: a valid token with no signal.
  async validTokenOffline() {
    seedSession(nowSec() + 3000)
    seedCache('today', [{ id: 'J1' }])
    server.mode = 'offline'
    const c = load()
    const r = await timed(c.cachedQuery('today', c.supabase.from('jobs').select('id')))
    ok('valid token offline: saved copy, fast', (r.v as any).fromCache === true && r.ms < 1000, secs(r.ms))
    const s = await c.supabase.auth.getSession()
    ok('valid token offline: getSession returns it', !!s.data.session)
  },

  // Location tracking must not switch itself off in a dead zone.
  async trackerKeepsWorkingOffline() {
    seedSession(nowSec() + 3000)
    server.mode = 'online'
    server.tables.job_time_entries = [{ id: 'E1', user_id: 'U1', job_id: 'J1', entry_type: 'work', clocked_out_at: null }]
    server.tables.jobs = [{ id: 'J1', status: 'in_progress', scheduled_start: localNoonToday(), job_assignments: [{ user_id: 'U1' }],
      client_addresses: { lat: 47.1, lng: -121.9, geocode_precision: null, nickname: 'Cabin', street: '1 Main' } }]
    const c = load()
    let w = await c.checkWork('U1')
    ok('online: clocked in → working, active job found', w.working === true && w.activeJob?.id === 'J1')

    server.mode = 'offline'
    w = await c.checkWork('U1')
    ok('offline: still working (was: query failed → "not working" → tracking stopped)', w.working === true)
    ok('offline: active job + address still known for the left-the-property alert', w.activeJob?.client_addresses?.nickname === 'Cabin')

    await c.writeThrough({ table: 'job_time_entries', op: 'update', match: { id: 'E1' }, values: { clocked_out_at: new Date().toISOString() } })
    await c.writeThrough({ table: 'jobs', op: 'update', match: { id: 'J1' }, values: { status: 'completed' } })
    w = await c.checkWork('U1')
    ok('offline clock-out + completion (queued) → not working, tracking may stop', w.working === false)

    server.mode = 'online'
    server.tables.job_time_entries = []
    server.tables.jobs = []
    w = await c.checkWork('U2')
    ok('online, nothing open → not working', w.working === false)
    server.mode = 'offline'
    await c.writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id',
      values: { id: c.uuid4(), user_id: 'U2', job_id: null, entry_type: 'shift', clocked_in_at: new Date().toISOString() } })
    w = await c.checkWork('U2')
    ok('offline start-of-day (queued) → working, tracking may start', w.working === true)

    w = await c.checkWork('U3')
    ok('offline with nothing ever saved → unknown (null), not "stopped"', w.working === null)
  },

  // Which cleans a ping names and fences, and when tracking stops. Per-job,
  // "you're still clocked in" may only be said about a clean with an open
  // punch, and a clean left in progress without one (paused, or held open by
  // the completion gate) no longer keeps the phone on the map. Each ping below
  // runs through the real startLocationTracking.
  async trackerFollowsTheClock() {
    seedSession(nowSec() + 3000)
    server.mode = 'online'
    const c = load()
    const here = { lat: 47.2, lng: -121.8 }  // where the phone is
    const away = { lat: 47.6, lng: -122.3 }  // ~50 km from here
    h.position = { latitude: here.lat, longitude: here.lng, accuracy: 5 }
    const job = (id: string, userId: string, status: string, hour: number, at: any, nickname: string, day = 0) => ({
      id, status, scheduled_start: localAt(day, hour), route_order: null, job_number: hour,
      job_assignments: [{ user_id: userId }],
      client_addresses: { lat: at.lat, lng: at.lng, geocode_precision: null, nickname, street: '1 Main' },
    })
    const punch = (id: string, userId: string, jobId: string | null, hour: number, entryType = 'work', day = 0) => ({
      id, user_id: userId, job_id: jobId, entry_type: entryType, clocked_in_at: localAt(day, hour), clocked_out_at: null,
    })
    const perJob = (id: string) => ({ id, tenant_id: 'T1', _timeMode: 'per_job' })
    const daily = (id: string) => ({ id, tenant_id: 'T2', _timeMode: 'daily' })
    // One ping: what reached crew_locations and notification_log, and which pushes fired.
    const ping = async (user: any) => {
      server.rest = []
      h.pushes = []
      await c.startLocationTracking(user)
      const loc = server.rest.filter(r => r.table === 'crew_locations')
      const res = {
        dot: loc.find(r => r.method === 'POST')?.body ?? null,
        stopped: loc.some(r => r.method === 'DELETE'),
        pushes: h.pushes as any[],
        logged: server.rest.filter(r => r.table === 'notification_log').map(r => r.body?.job_id),
      }
      await c.stopLocationTracking() // clears the ping timer
      return res
    }

    // Per-job: clocked out of the last clean, the completion gate held it open, gone home.
    server.tables.job_time_entries = []
    server.tables.jobs = [job('A1', 'P1', 'in_progress', 10, away, 'Cabin A')]
    let r = await ping(perJob('P1'))
    ok('per-job, clean left in progress with no punch: tracking stops', r.stopped && !r.dot)
    ok('…and no "still clocked in" push', r.pushes.length === 0)

    // Per-job: paused A ("Going to another job"), clocked into B, standing at B.
    server.tables.jobs = [job('A2', 'P2', 'in_progress', 10, away, 'Cabin A'), job('B2', 'P2', 'in_progress', 12, here, 'Cabin B')]
    server.tables.job_time_entries = [punch('E2', 'P2', 'B2', 12)]
    r = await ping(perJob('P2'))
    ok('per-job, A paused and clocked into B: the dot names B', r.dot?.job_id === 'B2' && r.dot?.status === 'active')
    ok('…and nothing is pushed about A', r.pushes.length === 0)

    // Per-job: clocked into B, which is scheduled BEFORE the paused A.
    server.tables.jobs = [job('A3', 'P3', 'in_progress', 14, away, 'Cabin A'), job('B3', 'P3', 'in_progress', 12, here, 'Cabin B')]
    server.tables.job_time_entries = [punch('E3', 'P3', 'B3', 13)]
    r = await ping(perJob('P3'))
    ok('per-job, clocked into a clean scheduled before the paused one: the dot still names it', r.dot?.job_id === 'B3')
    ok('…and no push (schedule order alone would have fenced A)', r.pushes.length === 0)

    // Per-job: never clocked out of A, clocked into B, standing at B.
    server.tables.jobs = [job('A4', 'P4', 'in_progress', 10, away, 'Cabin A'), job('B4', 'P4', 'in_progress', 12, here, 'Cabin B')]
    server.tables.job_time_entries = [punch('E4a', 'P4', 'A4', 10), punch('E4b', 'P4', 'B4', 12)]
    r = await ping(perJob('P4'))
    ok('per-job, still clocked into A after starting B: the dot names B (newest punch)', r.dot?.job_id === 'B4')
    ok('…one push, about A, saying they are still clocked in',
      r.pushes.length === 1 && r.pushes[0]?.data?.jobId === 'A4' && r.pushes[0]?.title === 'Still clocked in!')
    ok('…logged against A', r.logged.length === 1 && r.logged[0] === 'A4')

    // Per-job: a punch left open on yesterday's clean. Not in today's read, so
    // its clean comes embedded in the time entry.
    server.tables.jobs = [job('B5', 'P5', 'in_progress', 12, here, 'Cabin B')]
    server.tables.job_time_entries = [
      { ...punch('E5a', 'P5', 'Y5', 15, 'work', -1), jobs: job('Y5', 'P5', 'in_progress', 15, away, 'Yesterday', -1) },
      punch('E5b', 'P5', 'B5', 12),
    ]
    r = await ping(perJob('P5'))
    ok('per-job, a punch still open from yesterday is fenced from the embedded clean',
      r.pushes.length === 1 && r.pushes[0]?.data?.jobId === 'Y5')

    // Per-job: en route to C, with A stranded in progress.
    server.tables.jobs = [job('A6', 'P6', 'in_progress', 10, away, 'Cabin A'), job('C6', 'P6', 'en_route', 13, away, 'Cabin C')]
    server.tables.job_time_entries = []
    r = await ping(perJob('P6'))
    ok('per-job, en route: still tracked, shown idle (the web map draws en route itself)',
      !r.stopped && r.dot?.status === 'idle' && r.dot?.job_id === null)
    ok('…and no push about the stranded clean', r.pushes.length === 0)

    // Daily: on the day's shift, two cleans in progress, standing at the later one.
    server.tables.jobs = [job('A7', 'D7', 'in_progress', 10, away, 'Cabin A'), job('B7', 'D7', 'in_progress', 12, here, 'Cabin B')]
    server.tables.job_time_entries = [punch('S7', 'D7', null, 8, 'shift')]
    r = await ping(daily('D7'))
    ok('daily, two cleans in progress: the dot names the later one (was: none)', r.dot?.job_id === 'B7' && r.dot?.status === 'active')
    ok('…and only it is fenced (standing there: no push)', r.pushes.length === 0)

    // Daily is otherwise unchanged: a clean in progress counts, shift or not.
    server.tables.jobs = [job('A8', 'D8', 'in_progress', 10, away, 'Cabin A')]
    server.tables.job_time_entries = []
    r = await ping(daily('D8'))
    ok('daily, a clean in progress with no shift open: still tracked', !r.stopped && !!r.dot)
    ok('…and leaving it draws "not marked complete", not "clocked in"',
      r.pushes.length === 1 && r.pushes[0]?.title === 'Not marked complete')

    // Offline: a pause queued in a dead zone ends the per-job clock right away.
    server.tables.jobs = [job('A9', 'P9', 'in_progress', 10, here, 'Cabin A')]
    server.tables.job_time_entries = [punch('E9', 'P9', 'A9', 10)]
    let w = await c.checkWork('P9')
    ok('per-job clocked in, online: working, fenced on that clean',
      w.working === true && w.fenceJobs.map((j: any) => j.id).join() === 'A9')
    server.mode = 'offline'
    await c.writeThrough({ table: 'job_time_entries', op: 'update', match: { id: 'E9' },
      values: { clocked_out_at: new Date().toISOString(), pause_reason: 'Going to another job' } })
    w = await c.checkWork('P9')
    ok('offline pause (queued) → off the clock, tracking may stop', w.working === false && w.fenceJobs.length === 0)
    w = await c.checkWork('P9', true)
    ok('…while the same clean in a daily company still counts', w.working === true && w.activeJob?.id === 'A9')
    server.mode = 'online'
  },

  // One departure, one push (CKS 2026-09-30: an inspection left open after the
  // inspector drove off pushed 50 times in two hours, often 2-3 at once).
  async departureAnnouncedOnce() {
    seedSession(nowSec() + 3000)
    server.mode = 'online'
    let c = load()
    const here = { lat: 47.2, lng: -121.8 }
    const away = { lat: 47.6, lng: -122.3 }
    const user = { id: 'Q1', tenant_id: 'T1', _timeMode: 'per_job' }
    server.tables.jobs = [{
      id: 'J1', status: 'in_progress', scheduled_start: localAt(0, 10), route_order: null, job_number: 1,
      job_assignments: [{ user_id: 'Q1' }],
      client_addresses: { lat: here.lat, lng: here.lng, geocode_precision: null, nickname: 'Cabin', street: '1 Main' },
    }]
    server.tables.job_time_entries = [{ id: 'E1', user_id: 'Q1', job_id: 'J1', entry_type: 'work', clocked_in_at: localAt(0, 10), clocked_out_at: null }]
    const stand = (p: any) => { h.position = { latitude: p.lat, longitude: p.lng, accuracy: 5 } }
    const ping = async () => {
      server.rest = []
      h.pushes = []
      await c.startLocationTracking(user)
      await c.stopLocationTracking()
      return { pushes: (h.pushes as any[]).length, logged: server.rest.filter(r => r.table === 'notification_log').length }
    }

    stand(away)
    let r = await ping()
    ok('first check outside the fence: one push, logged', r.pushes === 1 && r.logged === 1)
    r = await ping()
    ok('next check, still away: no push', r.pushes === 0 && r.logged === 0)

    // Overlapping checks (leaked timer, background task) must not both claim it.
    stand(here); await ping(); stand(away)
    const realNow = Date.now
    Date.now = () => realNow() + 31 * 60 * 1000
    try {
      server.rest = []
      h.pushes = []
      await Promise.all([c.startLocationTracking(user), c.startLocationTracking(user)])
      await c.stopLocationTracking()
      ok('back on site, then a new departure after the gap: two racing checks push once',
        (h.pushes as any[]).length === 1)
    } finally { Date.now = realNow }

    // Back inside, out again within REALERT_GAP: GPS drift, not a new departure.
    stand(here); await ping(); stand(away)
    r = await ping()
    ok('re-crossing the edge within 30 minutes: no push', r.pushes === 0)

    // A relaunch (fresh module state) remembers it already told them.
    delete require.cache[require.resolve(process.env.CLIENT_BUNDLE as string)]
    c = load()
    r = await ping()
    ok('after a relaunch, still away: no push (persisted)', r.pushes === 0)
  },

  // Before the fix, same conditions as expiredColdStartThenReconnect. Opt-in
  // (--baseline): takes ~2 minutes because that is the bug.
  async baseline() {
    seedSession(nowSec() - 600)
    server.mode = 'offline'
    const c = load()
    const t0 = Date.now()
    const log: string[] = []
    const el = () => secs(Date.now() - t0)
    const gs = c.supabase.auth.getSession().then((r: any) => log.push(`${el()}  getSession → session=${!!r.data.session}`))
    const qs = [1, 2, 3].map(i => c.supabase.from('jobs').select('id').then((r: any) => log.push(`${el()}  read ${i} → status ${r.status}`)))
    await Promise.all([gs, ...qs])
    console.log('BEFORE the fix (origin/main supabase.ts), token expired, no signal:\n  ' + log.join('\n  '))
  },
}

// A request that hangs forever with no timer pending lets Node's event loop
// drain and exit 0 mid-scenario — which would read as a pass. That hang is
// the very bug the deadlines exist for, so an unfinished scenario fails.
let finished = false
process.on('exit', () => {
  if (!finished) { console.log('FAIL  scenario never finished (a request hung with nothing to end it)'); process.exitCode = 1 }
})

;(async () => {
  const name = process.argv[2]
  const run = scenarios[name]
  if (!run) { console.log(`unknown scenario ${name}; have: ${Object.keys(scenarios).join(', ')}`); process.exit(2) }
  console.log(`\n── ${name}`)
  try { await run() } catch (e: any) { failures++; console.log(`FAIL  threw: ${e?.stack || e}`) }
  finished = true
  process.exit(failures ? 1 : 0)
})()
