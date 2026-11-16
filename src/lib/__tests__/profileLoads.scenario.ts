// The profile loads once per launch, not three times. Run with: node scripts/test-profile-loads.mjs
//
// The bug (CKS, 2026-11-16): App.tsx loaded the profile from getSession() AND
// from every auth event carrying a session, and supabase-js sends three of
// those to a phone that is already signed in, so a launch loaded it three
// times and re-ran Home's reads with each new profile object.
//
// Exercises the REAL src/lib/profileLoads.ts, supabase.ts and netFetch.ts on
// top of the REAL supabase-js 2.99.2 that ships in the app, with the network
// replaced by a mock Supabase server (native modules are the offline-auth
// stubs). `launchBefore` wires a launch the old way and shows the three loads
// with the real library; the others wire it the way App.tsx does now. The
// `wiring` scenario holds App.tsx to that.
//
// Each scenario runs in its own Node process (the auth client is per process,
// like an app launch), started by the runner with the scenario name as argv[2].
declare const require: (m: string) => any
declare const process: any
declare const Buffer: any

const h: any = ((globalThis as any).__harness = (globalThis as any).__harness ?? {})
const store: Map<string, string> = (h.store = h.store ?? new Map())
console.error = () => {} // auth-js logs failed fetches; a condition under test
console.warn = () => {}

// ── Tokens ──────────────────────────────────────────────────────────────────
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const AUTH_ID = 'auth-crew-1'
const USER = { id: AUTH_ID, aud: 'authenticated', role: 'authenticated', email: 'crew@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
const nowSec = () => Math.floor(Date.now() / 1000)
function jwt(expSec: number) {
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: AUTH_ID, exp: expSec, role: 'authenticated', aud: 'authenticated', n: Math.random() })}.sig`
}
function makeSession(expiresIn = 3600) {
  const exp = nowSec() + expiresIn
  return { access_token: jwt(exp), refresh_token: `rt-${Math.random()}`, token_type: 'bearer', expires_in: expiresIn, expires_at: exp, user: USER }
}
const SESSION_KEY = 'sb-cbnbhwclbtowfbjylnph-auth-token'
/** A phone that is already signed in: the stored sign-in the app opens with. */
const signedInPhone = (expiresIn = 3600) => store.set(SESSION_KEY, JSON.stringify(makeSession(expiresIn)))

// ── Mock Supabase server ────────────────────────────────────────────────────
const server = {
  offline: false,
  usersDelayMs: 0,
  row: { id: 'row-1', auth_user_id: AUTH_ID, is_active: true, tenant_id: 't-1', role: 'cleaner', full_name: 'Crew One' } as any,
  calls: [] as string[],
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

;(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const method = String(init.method || 'GET').toUpperCase()
  const path = url.pathname
  const json = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } })
  if (server.offline) throw new TypeError('Network request failed')
  if (path === '/auth/v1/health') return json(200, { name: 'GoTrue' })
  server.calls.push(`${method} ${path}`)
  if (path === '/auth/v1/token') return json(200, makeSession())
  if (path === '/auth/v1/logout') return new Response(null, { status: 204 })
  if (path === '/auth/v1/user') return json(200, { ...USER, user_metadata: { changed: true } })
  if (path === '/rest/v1/users') {
    if (server.usersDelayMs) await sleep(server.usersDelayMs)
    return json(200, server.row ? [server.row] : [])
  }
  return json(404, { message: 'not found' })
}

// ── Test plumbing ───────────────────────────────────────────────────────────
let failures = 0
const ok = (name: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'}  ${name}${pass ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const load = () => require(process.env.CLIENT_BUNDLE as string)
const called = (what: string) => server.calls.filter(c => c === what).length
const read = (p: string) => require('node:fs').readFileSync(require('node:path').join(process.env.REPO, p), 'utf8') as string
const code = (p: string) => read(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// A small model of App.tsx: the same wiring and the same steps in loadUser
// that the gate cares about (read, stale, isCurrent, show, settle, chores).
function app(c: any, opts: { now?: () => number } = {}) {
  const loads = c.createProfileLoads(opts.now)
  const t = {
    loads,
    events: [] as string[],
    runs: 0, // loadUser started
    applied: 0, // a profile handed to the screens (setUser with a new object)
    chores: 0, // push token / location tracking / SOS resume
    shown: null as any,
    cached: null as any, // the offline copy
  }
  async function loadUser(authId: string, gen: number) {
    t.runs++
    const { data, error } = await c.supabase.from('users').select('id, auth_user_id, is_active, tenant_id, role, full_name').eq('auth_user_id', authId)
    const row = data?.[0] ?? null
    let stale = false
    let effective = row ? { ...row, _tz: 'America/Phoenix' } : null
    if (row) { if (!loads.isCurrent(gen)) return; t.cached = effective }
    if (!row) {
      if (!loads.isCurrent(gen)) return
      if (error) effective = t.cached
      if (effective) stale = true
    }
    if (!loads.isCurrent(gen)) return
    const next = c.sameProfile(t.shown, effective) ? t.shown : effective
    if (next !== t.shown) { t.shown = next; t.applied++ }
    loads.settle(gen, authId, { shown: !!effective, stale })
    if (effective && loads.choresDue(authId, effective)) t.chores++
  }
  // Exactly App.tsx's order: getSession(), then the listener.
  c.supabase.auth.getSession().then(({ data: { session } }: any) => {
    if (session) loads.request('startup', session.user.id, (gen: number) => loadUser(session.user.id, gen))
  })
  c.supabase.auth.onAuthStateChange((event: string, session: any) => {
    t.events.push(event)
    if (session) { loads.request(event, session.user.id, (gen: number) => loadUser(session.user.id, gen)); return }
    c.isSignedOut(event, session).then((out: boolean) => { if (out) { loads.reset(); t.shown = null } })
  })
  return t
}

// ── Scenarios ───────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {

  async launchBefore() {
    // The old wiring, on the real library: what crew phones do today.
    signedInPhone()
    const c = load()
    const events: string[] = []
    let runs = 0
    const loadUser = async () => { runs++; await c.supabase.from('users').select('id').eq('auth_user_id', AUTH_ID) }
    c.supabase.auth.getSession().then(({ data: { session } }: any) => { if (session) loadUser() })
    c.supabase.auth.onAuthStateChange((e: string, s: any) => { events.push(e); if (s) loadUser() })
    await sleep(200)
    ok('old wiring: the auth events a signed-in phone gets at launch', events, ['SIGNED_IN', 'INITIAL_SESSION'])
    ok('old wiring: the profile loads THREE times (the bug)', runs, 3)
    ok('old wiring: three users reads', called('GET /rest/v1/users'), 3)
  },

  async launch() {
    signedInPhone()
    const c = load()
    const t = app(c)
    await sleep(200)
    ok('launch: the same auth events arrive', t.events, ['SIGNED_IN', 'INITIAL_SESSION'])
    ok('launch: the profile loads once', t.runs, 1)
    ok('launch: one users read', called('GET /rest/v1/users'), 1)
    ok('launch: the profile reaches the screens once', [t.applied, t.shown?.id], [1, 'row-1'])
    ok('launch: startup chores once', t.chores, 1)
  },

  async launchLapsedToken() {
    // Opened after more than an hour: supabase-js renews first (TOKEN_REFRESHED).
    signedInPhone(-60)
    const c = load()
    const t = app(c)
    await sleep(300)
    ok('lapsed token: renewed once', called('POST /auth/v1/token'), 1)
    ok('lapsed token: the renewal is what arrives', t.events.includes('TOKEN_REFRESHED'), true)
    ok('lapsed token: still one load, one users read', [t.runs, called('GET /rest/v1/users')], [1, 1])
  },

  async renewalWhileOpen() {
    signedInPhone()
    let skew = 0
    const c = load()
    const t = app(c, { now: () => Date.now() + skew })
    await sleep(200)
    await c.supabase.auth.refreshSession()
    await sleep(50)
    ok('renewal minutes later: no reload', [t.runs, called('GET /rest/v1/users')], [1, 1])
    skew = c.PROFILE_FRESH_MS + 1000
    await c.supabase.auth.refreshSession()
    await sleep(50)
    ok('renewal 30+ min after the last load: reloads (office changes still arrive)', t.runs, 2)
    ok('...nothing changed: the screens keep the same profile object', t.applied, 1)
    ok('...and the startup chores don\'t run again', t.chores, 1)
    server.row = { ...server.row, role: 'lead_cleaner' }
    skew += c.PROFILE_FRESH_MS + 1000
    await c.supabase.auth.refreshSession()
    await sleep(50)
    ok('the office changed the role: the new profile reaches the screens', [t.runs, t.applied, t.shown?.role], [3, 2, 'lead_cleaner'])
    ok('...and the chores run for it', t.chores, 2)
  },

  async openedOffline() {
    // No signal at launch: the offline copy opens, and the next renewal that
    // gets through loads the real profile.
    signedInPhone()
    const c = load()
    const t = app(c)
    t.cached = { ...server.row, _tz: 'America/Phoenix', full_name: 'Crew One (copy)' }
    server.offline = true
    await sleep(300)
    ok('offline launch: one load, the offline copy on screen', [t.runs, t.shown?.full_name], [1, 'Crew One (copy)'])
    server.offline = false
    await c.supabase.auth.refreshSession()
    await sleep(50)
    ok('signal back: the renewal reloads at once (the copy is stale)', [t.runs, t.shown?.full_name], [2, 'Crew One'])
    await c.supabase.auth.refreshSession()
    await sleep(50)
    ok('then a renewal minutes later doesn\'t', t.runs, 2)
  },

  async signOutWhileLoading() {
    signedInPhone()
    server.usersDelayMs = 300
    const c = load()
    const t = app(c)
    await sleep(50) // the launch load is out, waiting on the users read
    await c.supabase.auth.signOut({ scope: 'local' })
    await sleep(500)
    ok('signed out mid-load: the late answer brings nothing back', [t.shown, t.applied], [null, 0])
    server.usersDelayMs = 0
    await c.supabase.auth.signInWithPassword({ email: USER.email, password: 'x' })
    await sleep(100)
    ok('signing in again loads the profile', [t.shown?.id, t.applied], ['row-1', 1])
    ok('...and runs the startup chores for that sign-in', t.chores, 1)
  },

  async userUpdated() {
    signedInPhone()
    const c = load()
    const t = app(c)
    await sleep(200)
    await c.supabase.auth.updateUser({ data: { changed: true } })
    await sleep(50)
    ok('an account change (USER_UPDATED) reloads even when fresh', [t.events.includes('USER_UPDATED'), t.runs], [true, 2])
  },

  async rules() {
    const c = load()
    let clock = 1_000_000
    const g = c.createProfileLoads(() => clock)
    let runs = 0
    let release: () => void = () => {}
    const slow = (gen: number) => new Promise<void>(r => { runs++; release = () => { g.settle(gen, 'A', { shown: true, stale: false }); r() } })
    const p1 = g.request('startup', 'A', slow)
    const p2 = g.request('SIGNED_IN', 'A', slow)
    const p3 = g.request('INITIAL_SESSION', 'A', slow)
    ok('three requests while one is out: one load', runs, 1)
    ok('...the others wait for that same load', p2 === p1 && p3 === p1, true)
    release(); await p1
    await g.request('TOKEN_REFRESHED', 'A', async () => { runs++ })
    ok('fresh profile on screen: a renewal doesn\'t load', runs, 1)
    clock += c.PROFILE_FRESH_MS
    await g.request('TOKEN_REFRESHED', 'A', async (gen: number) => { runs++; g.settle(gen, 'A', { shown: true, stale: false }) })
    ok('30 minutes on: it does', runs, 2)
    // USER_UPDATED while a load is out: one more load after it.
    let order: string[] = []
    let rel2: () => void = () => {}
    const p4 = g.request('USER_UPDATED', 'A', (gen: number) => new Promise<void>(r => { order.push('load'); rel2 = () => { g.settle(gen, 'A', { shown: true, stale: false }); r() } }))
    g.request('USER_UPDATED', 'A', async () => {})
    rel2(); await sleep(0); rel2(); await p4
    ok('an account change during a load: loads once more after it', order, ['load', 'load'])
    // A load that fails is swallowed: the gate stays usable.
    await g.request('USER_UPDATED', 'A', async () => { throw new Error('boom') })
    let after = 0
    await g.request('USER_UPDATED', 'A', async () => { after++ })
    ok('a load that throws doesn\'t wedge the gate', after, 1)
    // Sign out: a load still out may not apply; everything is forgotten.
    let gen0 = -1
    const p5 = g.request('USER_UPDATED', 'A', (gen: number) => { gen0 = gen; return sleep(10) })
    g.reset()
    ok('signed out: the load that was out is no longer current', g.isCurrent(gen0), false)
    await p5
    let fresh = 0
    await g.request('SIGNED_IN', 'A', async () => { fresh++ })
    ok('signed in again: loads', fresh, 1)
    // Another login while one is shown: the old one's load is stale.
    let genA = -1
    g.request('USER_UPDATED', 'A', (gen: number) => { genA = gen; return sleep(10) })
    let b = 0
    await g.request('SIGNED_IN', 'B', async () => { b++ })
    ok('another login: loads, and the first login\'s load may not apply', [b, g.isCurrent(genA)], [1, false])
    // Nothing shown (an empty read): the next event loads again.
    const g2 = c.createProfileLoads(() => clock)
    let empty = 0
    await g2.request('startup', 'A', async (gen: number) => { empty++; g2.settle(gen, 'A', { shown: false, stale: false }) })
    await g2.request('SIGNED_IN', 'A', async () => { empty++ })
    ok('no profile on screen (login screen): a sign-in loads', empty, 2)
  },

  async chores() {
    const c = load()
    const g = c.createProfileLoads()
    const p = { tenant_id: 't-1', role: 'cleaner' }
    ok('first profile for a login: chores due', g.choresDue('A', p), true)
    ok('same login, same company and role: not again', [g.choresDue('A', p), g.choresDue('A', { ...p, full_name: 'x' })], [false, false])
    ok('role changed: due', g.choresDue('A', { ...p, role: 'lead_cleaner' }), true)
    ok('company changed: due', g.choresDue('A', { tenant_id: 't-2', role: 'lead_cleaner' }), true)
    g.reset()
    ok('after a sign-out: due again', g.choresDue('A', { tenant_id: 't-2', role: 'lead_cleaner' }), true)
  },

  async sameProfile() {
    const c = load()
    const s = c.sameProfile
    ok('same fields in another order', s({ a: 1, b: { c: 2, d: [1, 2] } }, { b: { d: [1, 2], c: 2 }, a: 1 }), true)
    ok('an undefined field counts as absent', s({ a: 1, b: undefined }, { a: 1 }), true)
    ok('a changed value', s({ a: 1, b: 2 }, { a: 1, b: 3 }), false)
    ok('a changed array', s({ a: [1, 2] }, { a: [2, 1] }), false)
    ok('null against a profile', [s(null, { a: 1 }), s({ a: 1 }, null)], [false, false])
    ok('null against null (no profile either way)', s(null, null), true)
    ok('null is not an empty value', s({ a: null }, { a: 0 }), false)
  },

  async wiring() {
    const app = code('App.tsx')
    ok('App.tsx: loadUser runs only through profileLoads.request (startup + auth events)',
      [(app.match(/profileLoads\.request\('startup', authId, gen => loadUser\(authId, gen\)\)/g) || []).length,
       (app.match(/profileLoads\.request\(_event, authId, gen => loadUser\(authId, gen\)\)/g) || []).length,
       (app.match(/\bloadUser\(/g) || []).length],
      [1, 1, 3])
    ok('App.tsx: a sign-out resets the gate before the login screen', /if \(!signedOut\) return\s*\n[\s\S]{0,120}?profileLoads\.reset\(\)\s*\n\s*shownProfile\.current = null/.test(app), true)
    ok('App.tsx: the time zone is set before the profile reaches the screens',
      /setCurrentTz\(effective\?\._tz\)[\s\S]{0,400}?setUser\(next\)/.test(app), true)
    ok('App.tsx: an unchanged profile keeps the object on screen',
      /const next = sameProfile\(shownProfile\.current, effective\) \? shownProfile\.current : effective\s*\n\s*if \(next !== shownProfile\.current\) \{ shownProfile\.current = next; setUser\(next\) \}/.test(app), true)
    ok('App.tsx: setUser is called in two places only (the load, and the sign-out)', (app.match(/\bsetUser\(/g) || []).length, 2)
    ok('App.tsx: the outcome is recorded after the profile is shown', /setLoading\(false\)\s*\n\s*profileLoads\.settle\(gen, authId, \{ shown: !!effective, stale \}\)/.test(app), true)
    ok('App.tsx: push token, location tracking and SOS resume run when choresDue says',
      /if \(profileLoads\.choresDue\(authId, effective\)\) \{\s*\n\s*registerPushToken\(effective\)[\s\S]{0,120}?startLocationTracking\(effective\)[\s\S]{0,400}?resumeSOSTrailIfOpen\(\)/.test(app), true)
    ok('App.tsx: the version report still runs on every load', /reportClientVersion\(\)\.catch\(console\.warn\)\s*\n\s*\/\/ Once per login|reportClientVersion\(\)\.catch\(console\.warn\)\s*\n\s*if \(profileLoads\.choresDue/.test(read('App.tsx')), true)
    ok('App.tsx: a stale answer applies nothing (checked before the copy is saved, before the fallback, after the refusal)',
      (app.match(/if \(!profileLoads\.isCurrent\(gen\)\) return/g) || []).length, 3)
    ok('App.tsx: settings or clock from the copy mark the profile stale', (app.match(/\bstale = true\b/g) || []).length, 3)
  },
}

const name = process.argv[2]
const run = scenarios[name]
if (!run) { console.log(`unknown scenario ${name}`); process.exit(2) }
console.log(`\n— ${name}`)
run().then(() => process.exit(failures ? 1 : 0), (e: any) => { console.log(`✗  ${name} threw: ${e?.stack || e}`); process.exit(1) })
