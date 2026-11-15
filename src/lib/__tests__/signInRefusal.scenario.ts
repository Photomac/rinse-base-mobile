// Deactivated crew are told why at sign-in. Run with: node scripts/test-sign-in-refusal.mjs
//
// The bug (help-center audit 2026-11-14, must-fix 11): a crew member the office
// deactivated signs in, the password is accepted, the users read comes back
// empty (RLS skips inactive rows), and App.tsx dropped back to the login screen
// with no message and the session still on the phone. They took it for a wrong
// password.
//
// Exercises the REAL src/lib/signInRefusal.ts, myUsersRow.ts, supabase.ts and
// netFetch.ts on top of the REAL supabase-js 2.99.2 that ships in the app, with
// the network replaced by a mock Supabase server (native modules are the
// offline-auth stubs). Each scenario runs the calls App.tsx makes, in its
// order: sign in, read the users row, and on a clean empty read ask
// my_profile_status() through refuseSignInWithoutProfile with the same
// arguments App.tsx passes. The `wiring` scenario checks App.tsx, LoginScreen
// and i18n really do that.
//
// Each scenario runs in its own Node process (the auth client is per process),
// started by the runner with the scenario name as argv[2].
declare const require: (m: string) => any
declare const process: any
declare const Buffer: any

const h: any = ((globalThis as any).__harness = (globalThis as any).__harness ?? {})
const store: Map<string, string> = (h.store = h.store ?? new Map())
// auth-js console.error()s failed fetches; that is a condition under test.
console.error = () => {}
// signInRefusal.ts warns when the sign-out itself fails (logoutFails).
console.warn = () => {}

// ── Tokens ──────────────────────────────────────────────────────────────────
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const AUTH_ID = 'auth-crew-1'
const USER = { id: AUTH_ID, aud: 'authenticated', role: 'authenticated', email: 'crew@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
const nowSec = () => Math.floor(Date.now() / 1000)
function jwt(expSec: number) {
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: AUTH_ID, exp: expSec, role: 'authenticated', aud: 'authenticated', n: Math.random() })}.sig`
}
function makeSession() {
  const exp = nowSec() + 3600
  return { access_token: jwt(exp), refresh_token: `rt-${Math.random()}`, token_type: 'bearer', expires_in: 3600, expires_at: exp, user: USER }
}
const SESSION_KEY = 'sb-cbnbhwclbtowfbjylnph-auth-token'

// ── Mock Supabase server ────────────────────────────────────────────────────
const server = {
  password: 'right-password',
  // What the users read returns for this login, AFTER RLS: a deactivated
  // crew member's row is invisible, so it is [] for them.
  users: [] as any[],
  status: 'active' as string, // my_profile_status()'s answer
  statusFails: false,
  logoutFails: false,
  calls: [] as string[],
}

;(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const method = String(init.method || 'GET').toUpperCase()
  const path = url.pathname
  const json = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } })
  if (path === '/auth/v1/health') return json(200, { name: 'GoTrue' })
  server.calls.push(`${method} ${path}${url.search}`)
  if (path === '/auth/v1/token') {
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url.searchParams.get('grant_type') === 'password' && body.password !== server.password) {
      return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
    }
    return json(200, makeSession())
  }
  if (path === '/auth/v1/logout') {
    if (server.logoutFails) throw new TypeError('Network request failed')
    return new Response(null, { status: 204 })
  }
  if (path === '/rest/v1/rpc/my_profile_status') {
    if (server.statusFails) return json(503, { message: 'Service Unavailable' })
    return json(200, server.status)
  }
  if (path === '/rest/v1/users') return json(200, server.users)
  return json(404, { message: 'not found' })
}

// ── Test plumbing ───────────────────────────────────────────────────────────
let failures = 0
const ok = (name: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'}  ${name}${pass ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const load = () => require(process.env.CLIENT_BUNDLE as string)
const called = (prefix: string) => server.calls.filter(c => c.startsWith(prefix)).length

// The calls App.tsx makes, in its order. `log` interleaves what the login
// screen was told with the auth events App.tsx's listener receives.
async function appSignIn(c: any, password: string) {
  const log: string[] = []
  c.supabase.auth.onAuthStateChange((e: string) => { if (e !== 'INITIAL_SESSION') log.push(`event:${e}`) })
  const { data, error: signInError } = await c.supabase.auth.signInWithPassword({ email: USER.email, password })
  if (signInError) return { signInError, log, refusal: null, profile: null, readError: null }
  return { ...(await appLoadUser(c, data.session.user.id, log)), signInError: null, log }
}

async function appLoadUser(c: any, authId: string, log: string[] = []) {
  const { data: rows, error } = await c.supabase.from('users').select('id, auth_user_id, is_active, tenant_id').or(c.myUsersRowFilter(authId))
  const profile = c.pickMyUsersRow(rows, authId)
  let refusal = null
  if (!profile && !error) {
    // Exactly App.tsx's arguments (the `wiring` scenario holds it to them).
    refusal = await c.refuseSignInWithoutProfile({
      profileStatus: () => c.supabase.rpc('my_profile_status'),
      show: (r: string) => log.push(`show:${r}`),
      signOut: () => c.supabase.auth.signOut({ scope: 'local' }),
    })
  }
  await sleep(20) // let the auth listener's events land
  return { profile, refusal, readError: error, log }
}

async function signedOutCleanly(c: any, what: string) {
  ok(`${what}: the sign-in is gone from the phone`, store.has(SESSION_KEY), false)
  ok(`${what}: getSession() has no session`, (await c.supabase.auth.getSession()).data.session, null)
  ok(`${what}: App.tsx's listener reads it as signed out`, await c.isSignedOut('SIGNED_OUT', null), true)
  ok(`${what}: only this phone is signed out (scope=local)`, server.calls.filter(x => x.startsWith('POST /auth/v1/logout')), ['POST /auth/v1/logout?scope=local'])
}

const read = (p: string) => require('node:fs').readFileSync(require('node:path').join(process.env.REPO, p), 'utf8') as string
// Code only: comment lines out, so a comment can't satisfy a check.
const code = (p: string) => read(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// ── Scenarios ───────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {

  async deactivated() {
    server.users = [] // the inactive row is invisible under RLS
    server.status = 'deactivated'
    const c = load()
    const r = await appSignIn(c, server.password)
    ok('the password is accepted (the bug\'s starting point)', r.signInError, null)
    ok('the users read is clean and empty', [r.profile, r.readError], [null, null])
    ok('the login screen is told: deactivated', r.refusal, 'deactivated')
    ok('told BEFORE the sign-out lands, so the screen it lands on carries it',
      r.log, ['event:SIGNED_IN', 'show:deactivated', 'event:SIGNED_OUT'])
    ok('my_profile_status() asked once', called('POST /rest/v1/rpc/my_profile_status'), 1)
    await signedOutCleanly(c, 'deactivated')
  },

  async removed() {
    server.users = []
    server.status = 'none'
    const c = load()
    const r = await appSignIn(c, server.password)
    ok('no users row at all: the login screen is told no crew profile', r.refusal, 'no_profile')
    ok('told before the sign-out', r.log, ['event:SIGNED_IN', 'show:no_profile', 'event:SIGNED_OUT'])
    await signedOutCleanly(c, 'removed')
  },

  async activeCrew() {
    server.users = [{ id: 'row-1', auth_user_id: AUTH_ID, is_active: true, tenant_id: 't-1' }]
    server.status = 'active'
    const c = load()
    const r = await appSignIn(c, server.password)
    ok('active crew: the profile opens', r.profile?.id ?? null, 'row-1')
    ok('active crew: nothing on the login screen', r.refusal, null)
    ok('active crew: no extra request (my_profile_status not asked)', called('POST /rest/v1/rpc/my_profile_status'), 0)
    ok('active crew: no sign-out', called('POST /auth/v1/logout'), 0)
    ok('active crew: the sign-in stays on the phone', store.has(SESSION_KEY), true)
    ok('active crew: auth events are just the sign-in', r.log, ['event:SIGNED_IN'])
  },

  async wrongPassword() {
    server.users = []
    server.status = 'deactivated'
    const c = load()
    const r = await appSignIn(c, 'wrong-password')
    const msg = r.signInError?.message ?? ''
    ok('wrong password: still the existing error (LoginScreen maps it to login_invalid_credentials)',
      /invalid login credentials/i.test(msg), true)
    ok('wrong password: no profile check, no notice', [called('GET /rest/v1/users'), called('POST /rest/v1/rpc/my_profile_status'), r.log], [0, 0, []])
    ok('wrong password: nothing stored', store.has(SESSION_KEY), false)
  },

  async activeButReadEmpty() {
    // The database says the login IS active, yet the read found nothing.
    // Not a reason to turn anyone away: App.tsx carries on as it did before.
    server.users = []
    server.status = 'active'
    const c = load()
    const r = await appSignIn(c, server.password)
    ok('status active: no notice', [r.refusal, r.log], [null, ['event:SIGNED_IN']])
    ok('status active: no sign-out, the sign-in stays', [called('POST /auth/v1/logout'), store.has(SESSION_KEY)], [0, true])
  },

  async statusUnknown() {
    // The check itself failed: we learned nothing, so we change nothing.
    server.users = []
    server.status = 'deactivated'
    server.statusFails = true
    const c = load()
    const r = await appSignIn(c, server.password)
    ok('check failed: no notice', [r.refusal, r.log], [null, ['event:SIGNED_IN']])
    ok('check failed: no sign-out', [called('POST /auth/v1/logout'), store.has(SESSION_KEY)], [0, true])
  },

  async logoutFailsThenNextLaunch() {
    server.users = []
    server.status = 'deactivated'
    server.logoutFails = true
    let c = load()
    const r = await appSignIn(c, server.password)
    ok('sign-out call fails: the notice still shows', [r.refusal, r.log], ['deactivated', ['event:SIGNED_IN', 'show:deactivated']])
    ok('sign-out call fails: supabase-js keeps the stored sign-in', store.has(SESSION_KEY), true)
    // Next launch, with signal: App.tsx's getSession() → loadUser asks again.
    server.logoutFails = false
    const s = (await c.supabase.auth.getSession()).data.session
    const next = await appLoadUser(c, s.user.id)
    ok('next launch: told again and signed out', next.refusal, 'deactivated')
    ok('next launch: the sign-in is gone', store.has(SESSION_KEY), false)
  },

  async mapping() {
    const c = load()
    ok('refusalFor: deactivated', c.refusalFor('deactivated'), 'deactivated')
    ok('refusalFor: none → no_profile', c.refusalFor('none'), 'no_profile')
    for (const v of ['active', 'anon', null, undefined, '', 'DEACTIVATED', 42]) ok(`refusalFor: ${JSON.stringify(v)} → null`, c.refusalFor(v), null)
    // A thrown check (not just an error answer) is also "unknown".
    let shown = 0, out = 0
    const got = await c.refuseSignInWithoutProfile({
      profileStatus: () => Promise.reject(new Error('boom')), show: () => { shown++ }, signOut: async () => { out++ },
    })
    ok('a check that throws: nothing shown, no sign-out', [got, shown, out], [null, 0, 0])
  },

  async wiring() {
    const app = code('App.tsx')
    // The clean "no row" branch asks, with exactly the scenario's arguments.
    ok('App.tsx: the clean no-row branch clears the copy, then asks why',
      /else\s*\{\s*clearCachedProfile\(authId\)\s*[\s\S]{0,200}?await refuseSignInWithoutProfile\(\{/.test(app), true)
    ok('App.tsx: asks my_profile_status()', /profileStatus:\s*\(\)\s*=>\s*supabase\.rpc\('my_profile_status'\)/.test(app), true)
    ok('App.tsx: shows it on the login screen', /show:\s*setSignInRefusal\b/.test(app), true)
    ok('App.tsx: signs this phone out', /signOut:\s*\(\)\s*=>\s*supabase\.auth\.signOut\(\{\s*scope:\s*'local'\s*\}\)/.test(app), true)
    ok('App.tsx: a read ERROR still uses the offline copy (no check, no sign-out)',
      /if \(error\) effective = await loadCachedProfile\(authId\)\s*\n\s*else \{/.test(app), true)
    ok('App.tsx: the login screen gets the reason', /<LoginScreen refusal=\{signInRefusal\} onClearRefusal=\{\(\) => setSignInRefusal\(null\)\} \/>/.test(app), true)
    ok('App.tsx: an opened profile clears a stale reason', /if \(effective\) setSignInRefusal\(null\)/.test(app), true)
    ok('App.tsx: refuseSignInWithoutProfile called once (loadUser only)', (app.match(/refuseSignInWithoutProfile\(/g) || []).length, 1)

    const login = code('src/screens/LoginScreen.tsx')
    ok('LoginScreen: takes the reason', /export function LoginScreen\(\{ refusal = null, onClearRefusal \}/.test(login), true)
    ok('LoginScreen: shows both reasons through t()',
      ['signin_deactivated_title', 'signin_deactivated_body', 'signin_no_profile_title', 'signin_no_profile_body'].every(k => login.includes(`'${k}'`)), true)
    ok('LoginScreen: a new attempt clears the old reason before signing in',
      /onClearRefusal\?\.\(\)\s*\n\s*setLoading\(true\)\s*\n\s*const \{ error \} = await supabase\.auth\.signInWithPassword/.test(login), true)
    ok('LoginScreen: the wrong-password mapping is untouched',
      /invalid login credentials\/i\.test\(error\.message\) \? t\('login_invalid_credentials'\)/.test(login), true)

    // The words: in all three languages, and never "employee".
    const i18n = read('src/lib/i18n.ts')
    for (const k of ['signin_deactivated_title', 'signin_deactivated_body', 'signin_no_profile_title', 'signin_no_profile_body']) {
      ok(`i18n: ${k} in en, es and pt`, (i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 3)
    }
    const lines = i18n.split('\n').filter(l => /\bsignin_(deactivated|no_profile)_/.test(l))
    ok('i18n: crew, never "employee"', lines.filter(l => /employ|emplead|funcion/i.test(l)), [])

    // The status words the module maps are the ones the database returns
    // (rinsebase-app's migration), when that repo is on this machine.
    const { existsSync, readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const web = process.env.RINSEBASE_WEB_REPO || join(process.env.REPO, '..', 'rinsebase-app')
    const mig = join(web, 'supabase/migrations/20260804224147_my_profile_status.sql')
    if (existsSync(mig)) {
      const sql = readFileSync(mig, 'utf8') as string
      ok('web: my_profile_status() returns \'deactivated\' and \'none\'', [/return 'deactivated';/.test(sql), /return 'none';/.test(sql)], [true, true])
      ok('web: signed-in callers may run it', /grant execute on function public\.my_profile_status\(\) to authenticated;/.test(sql), true)
    } else {
      console.log(`-  web migration not found at ${mig} (set RINSEBASE_WEB_REPO); skipped`)
    }
  },
}

const name = process.argv[2]
const run = scenarios[name]
if (!run) { console.log(`unknown scenario ${name}`); process.exit(2) }
console.log(`\n${name}`)
run().then(() => {
  if (failures) { console.log(`${failures} FAILED`); process.exit(1) }
  process.exit(0)
}, (e) => { console.log(`✗  ${name} threw: ${e?.stack || e}`); process.exit(1) })
