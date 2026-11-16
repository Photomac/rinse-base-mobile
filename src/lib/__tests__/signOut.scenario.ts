// Profile's Sign out signs out this phone only, and says what it costs first.
// Run with: node scripts/test-sign-out.mjs
//
// The bug (CKS Perfections, 2026-11-16): a cleaner was signed out one morning
// and her iPhone then hid the saved password behind a Face ID check that
// failed, so she couldn't clock in for her first cleans. The server log showed
// `POST /auth/v1/logout?scope=global` from the crew app: the Profile Sign out
// button, which called supabase.auth.signOut() with supabase-js's default
// scope (global: every device's sign-in ends), behind "Are you sure?". The
// owner asked for a warning before crew get signed out.
//
// Exercises the REAL src/lib/signOutWarning.ts, supabase.ts, dataCache.ts,
// outbox.ts, jobReads.ts, i18n.ts and locationTracker's openPunchesRead on top
// of the REAL supabase-js 2.99.2 that ships in the app, with the network
// replaced by a mock Supabase server (native modules are the offline-auth
// stubs). `factsFromTheAppsReads` runs the exact reads ProfileScreen passes;
// the `wiring` scenario holds ProfileScreen, App.tsx, locationTracker and
// i18n to them.
//
// Each scenario runs in its own Node process (the auth client is per process),
// started by the runner with the scenario name as argv[2].
declare const require: (m: string) => any
declare const process: any
declare const Buffer: any

const h: any = ((globalThis as any).__harness = (globalThis as any).__harness ?? {})
const store: Map<string, string> = (h.store = h.store ?? new Map())
// auth-js and the outbox log failed fetches; that is a condition under test.
console.error = () => {}
console.warn = () => {}

// ── Tokens ──────────────────────────────────────────────────────────────────
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const AUTH_ID = 'auth-crew-1'
const U = 'user-row-1' // the users row (job_assignments.user_id, job_time_entries.user_id)
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
  mode: 'online' as 'online' | 'offline' | 'hang',
  punches: [] as any[], // job_time_entries rows the open-punch read returns
  calls: [] as string[],
}
const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

;(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const signal: AbortSignal | undefined = init.signal
  if (signal?.aborted) throw abortError()
  if (server.mode === 'offline') throw new TypeError('Network request failed')
  if (server.mode === 'hang') return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(abortError())))
  const method = String(init.method || 'GET').toUpperCase()
  const path = url.pathname
  const json = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } })
  if (path === '/auth/v1/health') return json(200, { name: 'GoTrue' })
  server.calls.push(`${method} ${path}${url.search}`)
  if (path === '/auth/v1/token') return json(200, makeSession())
  if (path === '/auth/v1/logout') return new Response(null, { status: 204 })
  if (path === '/rest/v1/job_time_entries' && method === 'GET') return json(200, server.punches)
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
const logouts = () => server.calls.filter(c => c.startsWith('POST /auth/v1/logout'))

async function signIn(c: any) {
  const events: string[] = []
  c.supabase.auth.onAuthStateChange((e: string) => { if (e !== 'INITIAL_SESSION') events.push(e) })
  const { error } = await c.supabase.auth.signInWithPassword({ email: USER.email, password: 'pw' })
  if (error) throw error
  return events
}

const read = (p: string) => require('node:fs').readFileSync(require('node:path').join(process.env.REPO, p), 'utf8') as string
// Code only: comment lines out, so a comment can't satisfy a check.
const code = (p: string) => read(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// Days around today in the company's zone (UTC here).
const dayShift = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10)
const clean = (id: string, ymd: string, status: string, crew: string[] = [U]) =>
  ({ id, status, scheduled_start: `${ymd}T15:00:00Z`, job_assignments: crew.map(user_id => ({ user_id })) })

// ── Scenarios ───────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {

  async thisPhoneOnly() {
    const c = load()
    const events = await signIn(c)
    ok('signed in: the sign-in is on the phone', store.has(SESSION_KEY), true)
    await c.signOutThisPhone(c.supabase.auth)
    await sleep(20)
    ok('the server is asked to end THIS session only (scope=local)', logouts(), ['POST /auth/v1/logout?scope=local'])
    ok('the sign-in is gone from the phone', store.has(SESSION_KEY), false)
    ok('getSession() has no session', (await c.supabase.auth.getSession()).data.session, null)
    ok('SIGNED_OUT still fires (App.tsx clears the offline copies on it)', events, ['SIGNED_IN', 'SIGNED_OUT'])
    ok('App.tsx\'s listener reads it as signed out', await c.isSignedOut('SIGNED_OUT', null), true)
  },

  async defaultScopeIsGlobal() {
    // Why the button can't call signOut() bare: supabase-js's default ends
    // the person's sign-in on EVERY device. This is the request the server
    // logged from the cleaner's phone on 2026-11-16.
    const c = load()
    await signIn(c)
    await c.supabase.auth.signOut()
    ok('supabase-js signOut() with no scope = global', logouts(), ['POST /auth/v1/logout?scope=global'])
  },

  async confirmWords() {
    const c = load()
    for (const lang of ['en', 'es', 'pt'] as const) {
      const t = (k: string) => c.t(lang, k)
      const T = c.translations[lang]
      const pw = T.sign_out_password
      const tail = `\n\n${pw} ${T.sign_out_until}`
      const say = (f: any) => c.signOutConfirm(f, t)
      ok(`${lang}: title says this phone`, say(null).title, T.sign_out_title)
      ok(`${lang}: nothing known → just the password line`, say(null).body, pw)
      ok(`${lang}: both unknown → just the password line`, say({ clockedIn: null, cleansLeft: null }).body, pw)
      ok(`${lang}: off the clock, no cleans left → just the password line`, say({ clockedIn: false, cleansLeft: 0 }).body, pw)
      ok(`${lang}: clocked in`, say({ clockedIn: true, cleansLeft: 0 }).body, `${T.sign_out_clocked_in}${tail}`)
      ok(`${lang}: one clean left`, say({ clockedIn: false, cleansLeft: 1 }).body, `${T.sign_out_cleans_one}${tail}`)
      ok(`${lang}: 3 cleans left`, say({ clockedIn: null, cleansLeft: 3 }).body, `${T.sign_out_cleans_many.replace('{n}', '3')}${tail}`)
      ok(`${lang}: clocked in with 2 left: both lines, clock first`, say({ clockedIn: true, cleansLeft: 2 }).body,
        `${T.sign_out_clocked_in}\n${T.sign_out_cleans_many.replace('{n}', '2')}${tail}`)
      ok(`${lang}: no {n} left unfilled`, /\{n\}/.test(say({ clockedIn: true, cleansLeft: 7 }).body), false)
    }
    const en = (f: any) => c.signOutConfirm(f, (k: string) => c.t('en', k))
    ok('en, exact words: nothing to warn about', en(null), { title: 'Sign out of this phone?', body: "You'll need your password to sign back in." })
    ok('en, exact words: clocked in with 3 cleans left', en({ clockedIn: true, cleansLeft: 3 }).body,
      "You're clocked in right now.\nYou have 3 cleans left today.\n\nYou'll need your password to sign back in. Until you do, you can't clock in or out.")
    ok('es, exact words: 3 cleans left', c.signOutConfirm({ clockedIn: false, cleansLeft: 3 }, (k: string) => c.t('es', k)).body,
      'Te quedan 3 limpiezas hoy.\n\nVas a necesitar tu contraseña para volver a entrar. Mientras tanto, no puedes registrar tu entrada ni tu salida.')
  },

  async facts() {
    const c = load()
    c.setCurrentTz('UTC')
    const today = c.todayKey()
    const same = async (_t: string, rows: any[]) => rows
    const io = (over: any) => ({ userId: U, today, openPunches: async () => [], dayRows: async () => [], overlay: same, deadlineMs: 500, ...over })

    ok('an open punch: clocked in', (await c.loadSignOutFacts(io({ openPunches: async () => [{ user_id: U, clocked_out_at: null }] }))).clockedIn, true)
    ok('a day shift counts too (any open punch)', (await c.loadSignOutFacts(io({ openPunches: async () => [{ user_id: U, job_id: null, entry_type: 'shift', clocked_out_at: null }] }))).clockedIn, true)
    ok('no open punch: not clocked in', (await c.loadSignOutFacts(io({}))).clockedIn, false)
    ok('nothing to go on: unknown', (await c.loadSignOutFacts(io({ openPunches: async () => null }))).clockedIn, null)
    ok('a failed read: unknown', (await c.loadSignOutFacts(io({ openPunches: async () => { throw new Error('boom') } }))).clockedIn, null)
    ok('a queued clock-out lands on the saved punch: not clocked in',
      (await c.loadSignOutFacts(io({
        openPunches: async () => [{ id: 'e1', user_id: U, clocked_out_at: null }],
        overlay: async (t: string, rows: any[]) => t === 'job_time_entries' ? rows.map(r => ({ ...r, clocked_out_at: '2026-11-16T15:00:00Z' })) : rows,
      }))).clockedIn, false)
    let include: any = null
    const queuedIns = [{ id: 'q1', user_id: 'someone-else', clocked_out_at: null }, { id: 'q2', user_id: U, clocked_out_at: null }]
    const withQueued = (who: string[]) => async (t: string, rows: any[], inc?: any) => {
      if (t !== 'job_time_entries') return rows
      include = inc
      return [...rows, ...queuedIns.filter(v => who.includes(v.user_id)).filter(v => !inc || inc(v))]
    }
    ok('a clock-in queued offline counts', (await c.loadSignOutFacts(io({ overlay: withQueued([U, 'someone-else']) }))).clockedIn, true)
    ok('only their own queued clock-ins are laid over', [include?.({ user_id: U }), include?.({ user_id: 'someone-else' })], [true, false])
    ok('someone else\'s queued clock-in doesn\'t count', (await c.loadSignOutFacts(io({ overlay: withQueued(['someone-else']) }))).clockedIn, false)

    const rows = [
      clean('a', today, 'scheduled'),
      clean('b', today, 'en_route'),
      clean('c', today, 'in_progress'),
      clean('d', today, 'completed'),
      clean('e', today, 'cancelled'),
      clean('f', today, 'pending_approval'),
      clean('g', today, 'no_show'),
      clean('h', dayShift(today, 1), 'scheduled'), // tomorrow: Home's read carries it
      clean('i', dayShift(today, -1), 'scheduled'), // a saved copy from an earlier day
      clean('j', today, 'scheduled', ['someone-else']), // the office sees Everyone
      clean('k', today, 'scheduled', []), // nobody's
      clean('l', today, 'scheduled', ['someone-else', U]),
    ]
    ok('cleans left today: own, today, scheduled / en route / in progress', (await c.loadSignOutFacts(io({ dayRows: async () => rows }))).cleansLeft, 4)
    ok('cleansLeftToday agrees', c.cleansLeftToday(rows, U, today), 4)
    ok('a queued Complete lands on the saved copy', (await c.loadSignOutFacts(io({
      dayRows: async () => rows,
      overlay: async (t: string, r: any[]) => t === 'jobs' ? r.map(j => (j.id === 'c' ? { ...j, status: 'completed' } : j)) : r,
    }))).cleansLeft, 3)
    ok('no saved day: unknown', (await c.loadSignOutFacts(io({ dayRows: async () => null }))).cleansLeft, null)
    ok('nothing today: 0', (await c.loadSignOutFacts(io({ dayRows: async () => [clean('h', dayShift(today, 1), 'scheduled')] }))).cleansLeft, 0)

    // A read that never answers can't hold the confirm.
    const t0 = Date.now()
    const slow = await c.loadSignOutFacts(io({ openPunches: () => new Promise(() => {}), dayRows: () => new Promise(() => {}), deadlineMs: 300 }))
    const took = Date.now() - t0
    ok('a read that never answers: unknown, not waited for', slow, { clockedIn: null, cleansLeft: null })
    ok('…and the confirm comes up at the deadline', took >= 280 && took < 1000, true)
  },

  async factsFromTheAppsReads() {
    // The exact IO ProfileScreen passes (the `wiring` scenario holds it to
    // these calls), on the real cache, outbox and supabase-js.
    const c = load()
    c.setCurrentTz('UTC')
    const user = { id: U, tenant_id: 't-1', role: 'cleaner' }
    const today = c.todayKey()
    const facts = (deadlineMs = 2500) => c.loadSignOutFacts({
      userId: user.id,
      today: c.todayKey(),
      openPunches: async () => (await c.readSoon(c.openPunchesRead(user.id), 1500)).data ?? null,
      dayRows: () => c.readCacheEntry(c.dashTodayRead(user, new Date()).key),
      overlay: c.overlayPending,
      deadlineMs,
    })
    await signIn(c)

    // Nothing saved yet, no signal: nothing to say about either.
    server.mode = 'offline'
    ok('no signal, nothing saved: both unknown', await facts(), { clockedIn: null, cleansLeft: null })

    // Home saved its day (it carries tomorrow, so last night's copy holds today).
    store.set(`dataCache:dash:today:${U}`, JSON.stringify([
      clean('a', today, 'scheduled'), clean('b', today, 'in_progress'), clean('c', today, 'completed'), clean('d', dayShift(today, 1), 'scheduled'),
    ]))
    ok('Home\'s saved day: 2 cleans left, offline', (await facts()).cleansLeft, 2)

    // Online: the tracker's open-punch read, live.
    server.mode = 'online'
    server.punches = [{ id: 'e1', user_id: U, job_id: 'b', entry_type: 'work', clocked_in_at: `${today}T14:00:00Z`, clocked_out_at: null, jobs: { id: 'b' } }]
    ok('online with an open punch: clocked in, 2 cleans left', await facts(), { clockedIn: true, cleansLeft: 2 })
    ok('it asked for this person\'s open punches only', server.calls.filter(x => x.startsWith('GET /rest/v1/job_time_entries')).every(x => /user_id=eq\.user-row-1/.test(x) && /clocked_out_at=is\.null/.test(x)), true)
    ok('…and saved them under the tracker\'s key (checkWork reads the same copy)', JSON.parse(store.get(`dataCache:track:open:${U}`) || 'null')?.[0]?.id ?? null, 'e1')

    // Signal gone: the saved copy still says clocked in.
    server.mode = 'offline'
    ok('offline: the saved punch still says clocked in', (await facts()).clockedIn, true)

    // A clock-out queued offline (the outbox) lands on the saved punch.
    const w = await c.writeThrough({ table: 'job_time_entries', op: 'update', match: { id: 'e1' }, values: { clocked_out_at: `${today}T16:00:00Z` } })
    ok('the clock-out is queued', w.queued, true)
    ok('offline after a queued clock-out: not clocked in', (await facts()).clockedIn, false)

    // A link that swallows requests: the saved copy, quickly.
    server.mode = 'hang'
    const t0 = Date.now()
    const f = await facts()
    ok('a swallowing link: answered from the saved copies', f, { clockedIn: false, cleansLeft: 2 })
    ok('…within the wait, not the 15 s read deadline', Date.now() - t0 < 2400, true)

    // Nothing saved and a swallowing link: the deadline, then unknown.
    store.delete(`dataCache:track:open:${U}`)
    const t1 = Date.now()
    ok('nothing saved, swallowing link: clock unknown', (await facts(600)).clockedIn, null)
    ok('…at the deadline', Date.now() - t1 < 1200, true)
  },

  async wiring() {
    const profile = code('src/screens/ProfileScreen.tsx')
    ok('Profile: Sign out goes through signOutThisPhone(supabase.auth)',
      /text:\s*t\('sign_out'\),\s*style:\s*'destructive',\s*onPress:\s*\(\)\s*=>\s*\{\s*signOutThisPhone\(supabase\.auth\)/.test(profile), true)
    ok('Profile: never calls supabase.auth.signOut directly', /supabase\.auth\.signOut\(/.test(profile), false)
    ok('Profile: the button opens the confirm', /onPress=\{confirmSignOut\}/.test(profile), true)
    ok('Profile: the confirm is signOutConfirm(), Cancel first',
      /const \{ title, body \} = signOutConfirm\(facts, t\)\s*\n\s*Alert\.alert\(title, body, \[\s*\n\s*\{ text: t\('cancel'\), style: 'cancel' \}/.test(profile), true)
    ok('Profile: the clock from the tracker\'s open-punch read, live within the wait',
      /openPunches:\s*async \(\) => \(await readSoon<any\[\]>\(openPunchesRead\(user\.id\), SIGN_OUT_FACTS_WAIT_MS\)\)\.data \?\? null,/.test(profile), true)
    ok('Profile: cleans left from Home\'s saved day only',
      /dayRows:\s*\(\) => readCacheEntry<any\[\]>\(dashTodayRead\(user, new Date\(\)\)\.key\),/.test(profile), true)
    ok('Profile: queued writes laid over (the outbox)', /overlay:\s*overlayPending,/.test(profile), true)
    ok('Profile: today in the company\'s zone', /today:\s*todayKey\(\),/.test(profile), true)
    ok('Profile: a deadline on the facts', /deadlineMs:\s*SIGN_OUT_FACTS_DEADLINE_MS,/.test(profile), true)

    const lib = code('src/lib/signOutWarning.ts')
    ok('signOutThisPhone: scope local', /return auth\.signOut\(\{ scope: 'local' \}\)/.test(lib), true)

    // No sign-out anywhere in the app with the default (global) scope.
    const { readdirSync, statSync } = require('node:fs')
    const { join } = require('node:path')
    const files: string[] = ['App.tsx']
    const walk = (d: string) => {
      for (const n of readdirSync(join(process.env.REPO, d))) {
        const p = `${d}/${n}`
        if (n === '__tests__') continue
        if (statSync(join(process.env.REPO, p)).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n)) files.push(p)
      }
    }
    walk('src')
    // (lib/signInRefusal's `io.signOut()` is the function App.tsx hands it,
    // which the check above holds to scope local.)
    const bare = files.filter(f => /auth\.signOut\(\s*\)/.test(code(f)) || /\.signOut\(\s*\{\s*scope:\s*'global'/.test(code(f)))
    ok('no signOut() with the default or global scope anywhere in the app', bare, [])

    // Nothing else about sign-out changes: SIGNED_OUT still clears the copies.
    const app = code('App.tsx')
    ok('App.tsx: SIGNED_OUT still drops the offline copies',
      /if \(_event === 'SIGNED_OUT' && lastAuthId\.current\) \{ clearCachedProfile\(lastAuthId\.current\); clearDataCache\(\); clearCarriedPhotos\(\) \}/.test(app), true)
    ok('App.tsx: the refusal path still signs this phone out', /signOut:\s*\(\)\s*=>\s*supabase\.auth\.signOut\(\{\s*scope:\s*'local'\s*\}\)/.test(app), true)

    // The tracker and the confirm share one read (one key, one shape).
    const tracker = code('src/lib/locationTracker.ts')
    ok('locationTracker: checkWork reads openPunchesRead', /cachedRead\(openPunchesRead\(userId\)\)/.test(tracker), true)
    ok('locationTracker: openPunchesRead keeps the tracker\'s key', /key:\s*`track:open:\$\{userId\}`/.test(tracker), true)
    ok('locationTracker: track:open built in one place', (tracker.match(/track:open:/g) || []).length, 1)

    // The words: in all three languages; the old "Are you sure?" is gone.
    const i18n = read('src/lib/i18n.ts')
    const KEYS = ['sign_out_title', 'sign_out_password', 'sign_out_until', 'sign_out_clocked_in', 'sign_out_cleans_one', 'sign_out_cleans_many']
    for (const k of KEYS) ok(`i18n: ${k} in en, es and pt`, (i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 3)
    ok('i18n: sign_out_confirm ("Are you sure?") removed', /\bsign_out_confirm\b/.test(i18n), false)
    ok('i18n: sign_out_confirm used nowhere', files.filter(f => /sign_out_confirm/.test(read(f))), [])
    const c = load()
    for (const L of ['en', 'es', 'pt'] as const) {
      ok(`${L}: the cleans count has its {n}`, /\{n\}/.test(c.translations[L].sign_out_cleans_many), true)
    }
    ok('the password line names the password', [
      /password/i.test(c.translations.en.sign_out_password), /contraseña/i.test(c.translations.es.sign_out_password), /senha/i.test(c.translations.pt.sign_out_password),
    ], [true, true, true])
    ok('the title says this phone', [
      /this phone/i.test(c.translations.en.sign_out_title), /este teléfono/i.test(c.translations.es.sign_out_title), /neste telefone/i.test(c.translations.pt.sign_out_title),
    ], [true, true, true])
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
