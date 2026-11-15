// A crew member's email change moves their sign-in. Run with: node scripts/test-login-email.mjs
//
// The bug (help-center audit 2026-11-14, troubleshooting §4): Profile → Edit
// wrote users.email only. The crew member kept signing in with the old address
// and wasn't told, and "Forgot your password?" with the new one sent nothing.
//
// Exercises the REAL src/lib/loginEmail.ts, supabase.ts and netFetch.ts on top
// of the REAL supabase-js 2.99.2 that ships in the app, against a mock GoTrue +
// PostgREST that behaves like prod (secure email change off: one code, to the
// NEW address; an address another login holds → 422 email_exists). Each
// scenario makes the calls ProfileScreen makes, through the same EmailChangeIO
// it builds; the `wiring` scenario holds ProfileScreen, LoginScreen and i18n to
// that.
//
// Each scenario runs in its own Node process, started by the runner with the
// scenario name as argv[2].
declare const require: (m: string) => any
declare const process: any
declare const Buffer: any

const h: any = ((globalThis as any).__harness = (globalThis as any).__harness ?? {})
h.store = h.store ?? new Map()
console.error = () => {}

// ── Mock GoTrue + PostgREST ─────────────────────────────────────────────────
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const AUTH_ID = 'auth-crew-1'
const ROW_ID = 'row-1'
const PASSWORD = 'crew-password'
const CODE = '48213077' // prod codes are 8 digits
const server = {
  loginEmail: 'old@example.com',       // auth.users.email
  heldByOthers: new Set(['taken@example.com']),
  pending: null as null | { email: string; token: string },
  calls: [] as string[],               // METHOD path[ body summary]
  contactWrites: [] as any[],          // PATCH bodies for users
  contactFails: false,
  updateUserReply: 'ok' as 'ok' | 'rate' | 'offline',
}
const nowSec = () => Math.floor(Date.now() / 1000)
function session(email: string) {
  const exp = nowSec() + 3600
  const user = { id: AUTH_ID, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
  return { access_token: `${b64({ alg: 'HS256' })}.${b64({ sub: AUTH_ID, exp, role: 'authenticated', n: Math.random() })}.sig`, refresh_token: `rt-${Math.random()}`, token_type: 'bearer', expires_in: 3600, expires_at: exp, user }
}

;(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const method = String(init.method || 'GET').toUpperCase()
  const path = url.pathname
  const body = init.body ? JSON.parse(String(init.body)) : {}
  const json = (status: number, b: any) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } })
  if (path === '/auth/v1/health') return json(200, { name: 'GoTrue' })
  server.calls.push(`${method} ${path}`)
  if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    if (body.email?.toLowerCase() !== server.loginEmail || body.password !== PASSWORD) {
      return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
    }
    return json(200, session(server.loginEmail))
  }
  if (path === '/auth/v1/user' && method === 'PUT') {
    if (server.updateUserReply === 'offline') throw new TypeError('Network request failed')
    if (server.updateUserReply === 'rate') return json(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' })
    const email = String(body.email).toLowerCase()
    if (server.heldByOthers.has(email)) return json(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' })
    server.pending = { email, token: CODE } // emailed to the NEW address only
    return json(200, { ...session(server.loginEmail).user, new_email: email, email_change_sent_at: new Date().toISOString() })
  }
  if (path === '/auth/v1/resend') {
    server.calls[server.calls.length - 1] += ` type=${body.type} email=${body.email}`
    return server.pending && body.type === 'email_change' && server.pending.email === String(body.email).toLowerCase()
      ? json(200, {}) : json(400, { code: 400, error_code: 'validation_failed', msg: 'nothing to resend' })
  }
  if (path === '/auth/v1/verify') {
    const ok = body.type === 'email_change' && server.pending && server.pending.email === String(body.email).toLowerCase() && body.token === server.pending.token
    if (!ok) return json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' })
    server.loginEmail = server.pending!.email
    server.pending = null
    return json(200, session(server.loginEmail))
  }
  if (path === '/auth/v1/logout') return new Response(null, { status: 204 })
  if (path === '/rest/v1/users' && method === 'PATCH') {
    if (server.contactFails) return json(500, { message: 'boom' })
    server.contactWrites.push({ filter: url.searchParams.get('id'), body })
    return new Response(null, { status: 204 })
  }
  return json(404, { message: 'not found' })
}

// ── Plumbing ────────────────────────────────────────────────────────────────
let failures = 0
const ok = (name: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'}  ${name}${pass ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const load = () => require(process.env.CLIENT_BUNDLE as string)
const has = (prefix: string) => server.calls.some(c => c.startsWith(prefix))

// The EmailChangeIO ProfileScreen builds (the `wiring` scenario holds it to these).
function profileIO(c: any) {
  return {
    requestCode: (email: string) => c.supabase.auth.updateUser({ email }),
    resendCode: (email: string) => c.supabase.auth.resend({ type: 'email_change', email }),
    verifyCode: (email: string, code: string) => c.supabase.auth.verifyOtp({ email, token: code, type: 'email_change' }),
    saveContact: (email: string) => c.supabase.from('users').update({ email }).eq('id', ROW_ID),
  }
}
async function signIn(c: any, email = server.loginEmail) {
  const { error } = await c.supabase.auth.signInWithPassword({ email, password: PASSWORD })
  return error
}
const loginEmailNow = async (c: any) => (await c.supabase.auth.getSession()).data.session?.user?.email ?? null

const read = (p: string) => require('node:fs').readFileSync(require('node:path').join(process.env.REPO, p), 'utf8') as string
const code = (p: string) => read(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

// ── Scenarios ───────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {

  async movesLogin() {
    const c = load()
    ok('signed in with the old address', await signIn(c), null)
    const plan = c.planEmailSave(' New@Example.com ', 'old@example.com', await loginEmailNow(c))
    ok('a new address plans a login move', plan, { kind: 'move_login', email: 'New@Example.com' })
    const io = profileIO(c)
    const start = await c.startEmailChange(io, plan.email)
    ok('step 1: the code is sent', start, { ok: true, contactSaved: false })
    ok('step 1: asked GoTrue to change the email (PUT /user)', has('PUT /auth/v1/user'), true)
    ok('step 1: nothing written to users.email yet', server.contactWrites, [])
    ok('step 1: the login has NOT moved yet', server.loginEmail, 'old@example.com')

    const wrong = await c.confirmEmailChange(io, plan.email, '11111111')
    ok('a wrong code: refused as a bad code', [wrong.ok, wrong.failure], [false, 'bad_code'])
    ok('a wrong code: no contact write, login unchanged', [server.contactWrites, server.loginEmail], [[], 'old@example.com'])
    const short = await c.confirmEmailChange(io, plan.email, '123')
    ok('a too-short code: refused without asking the server', [short.failure, server.calls.filter(x => x === 'POST /auth/v1/verify').length], ['bad_code', 1])

    const right = await c.confirmEmailChange(io, plan.email, ` ${CODE.slice(0, 4)} ${CODE.slice(4)} `)
    ok('the right code (spaces ignored): login moved and contact saved', right, { ok: true, contactSaved: true })
    ok('the login is now the new address', server.loginEmail, 'new@example.com')
    ok('users.email written once, to the new address, on this row', server.contactWrites, [{ filter: `eq.${ROW_ID}`, body: { email: 'New@Example.com' } }])
    const order = server.calls.filter(x => x === 'POST /auth/v1/verify' || x === 'PATCH /rest/v1/users')
    ok('users.email written only AFTER the code verified', order.slice(-2), ['POST /auth/v1/verify', 'PATCH /rest/v1/users'])
    ok('the phone\'s session now carries the new address', await loginEmailNow(c), 'new@example.com')

    await c.supabase.auth.signOut({ scope: 'local' })
    ok('next sign-in: the NEW address works', await signIn(c, 'new@example.com'), null)
    await c.supabase.auth.signOut({ scope: 'local' })
    const old = await signIn(c, 'old@example.com')
    ok('next sign-in: the old address no longer does (existing error)', /invalid login credentials/i.test(old?.message ?? ''), true)
  },

  async taken() {
    const c = load()
    await signIn(c)
    const r = await c.startEmailChange(profileIO(c), 'taken@example.com')
    ok('an address another login holds: "taken"', [r.ok, r.failure], [false, 'taken'])
    ok('taken: no code pending, nothing written, login unchanged', [server.pending, server.contactWrites, server.loginEmail], [null, [], 'old@example.com'])
  },

  async sameAsLogin() {
    const c = load()
    await signIn(c)
    const login = await loginEmailNow(c)
    ok('the login address in another case: contact only', c.planEmailSave(' OLD@example.com ', 'stale@example.com', login), { kind: 'contact_only', email: 'OLD@example.com' })
    ok('…which mends a contact email that had drifted from the login', c.planEmailSave('old@example.com', 'drifted@example.com', login).kind, 'contact_only')
    ok('the drifted contact address itself: moves the login (the way to switch)', c.planEmailSave('drifted@example.com', 'drifted@example.com', login), { kind: 'move_login', email: 'drifted@example.com' })
  },

  async contactSaveFails() {
    const c = load()
    await signIn(c)
    const io = profileIO(c)
    await c.startEmailChange(io, 'new@example.com')
    server.contactFails = true
    const r = await c.confirmEmailChange(io, 'new@example.com', CODE)
    ok('code ok but the contact save failed: login moved, contactSaved false', [r.ok, r.contactSaved, server.loginEmail], [true, false, 'new@example.com'])
    ok('saving the same address again is contact-only (mends it, no second code)',
      c.planEmailSave('new@example.com', 'old@example.com', await loginEmailNow(c)), { kind: 'contact_only', email: 'new@example.com' })
  },

  async resend() {
    const c = load()
    await signIn(c)
    const io = profileIO(c)
    await c.startEmailChange(io, 'new@example.com')
    const r = await c.startEmailChange(io, 'new@example.com', true)
    ok('Resend: asks GoTrue to resend the email-change code to the new address', [r.ok, server.calls.find(x => x.startsWith('POST /auth/v1/resend'))],
      [true, 'POST /auth/v1/resend type=email_change email=new@example.com'])
  },

  async rateLimitedAndOffline() {
    const c = load()
    await signIn(c)
    server.updateUserReply = 'rate'
    const rate = await c.startEmailChange(profileIO(c), 'new@example.com')
    ok('email rate limit: "rate_limited"', rate.failure, 'rate_limited')
    server.updateUserReply = 'offline'
    const off = await c.startEmailChange(profileIO(c), 'new@example.com')
    ok('no signal: "network"', off.failure, 'network')
    ok('neither moved the login nor wrote the contact', [server.loginEmail, server.contactWrites], ['old@example.com', []])
  },

  async plans() {
    const c = load()
    ok('empty: clears the contact, login untouched', c.planEmailSave('  ', 'a@b.co', 'a@b.co'), { kind: 'contact_only', email: null })
    for (const bad of ['name', 'name@', 'name@host', 'a b@c.d', '@c.d']) ok(`invalid: ${JSON.stringify(bad)}`, c.planEmailSave(bad, 'a@b.co', 'a@b.co').kind, 'invalid')
    ok('login unknown, contact unchanged: contact only (as before)', c.planEmailSave('a@b.co', 'A@b.co', null).kind, 'contact_only')
    ok('login unknown, contact changed: still goes through the code', c.planEmailSave('z@b.co', 'a@b.co', null), { kind: 'move_login', email: 'z@b.co' })
    ok('sameEmail ignores case and spaces', [c.sameEmail(' A@B.co', 'a@b.CO '), c.sameEmail('', ''), c.sameEmail(null, null)], [true, false, false])
    ok('failure: GoTrue duplicate message without a code', c.emailChangeFailure({ message: 'A user with this email address has already been registered' }, 'start'), 'taken')
    ok('failure: per-user throttle', c.emailChangeFailure({ message: 'For security purposes, you can only request this after 42 seconds.' }, 'start'), 'rate_limited')
    ok('failure: expired code only counts on confirm', [c.emailChangeFailure({ code: 'otp_expired' }, 'confirm'), c.emailChangeFailure({ code: 'otp_expired' }, 'start')], ['bad_code', 'other'])
  },

  async wiring() {
    const profile = code('src/screens/ProfileScreen.tsx')
    ok('Profile: the old save that wrote users.email directly is gone',
      /\.update\(\{\s*email:\s*contactEmail\.trim\(\)/.test(profile), false)
    ok('Profile: Save plans with the shown contact email and the login email', /planEmailSave\(contactEmail, shownEmail, loginEmail\)/.test(profile), true)
    ok('Profile: a new address is not written before the code (email only joins the patch for contact_only)',
      /if \(plan\.kind === 'contact_only'\) patch\.email = plan\.email/.test(profile) && !/patch\.email = contactEmail/.test(profile), true)
    ok('Profile: step 1 sends the code', /requestCode:\s*\(email\)\s*=>\s*supabase\.auth\.updateUser\(\{\s*email\s*\}\)/.test(profile), true)
    ok('Profile: Resend is an email_change resend', /resendCode:\s*\(email\)\s*=>\s*supabase\.auth\.resend\(\{\s*type:\s*'email_change',\s*email\s*\}\)/.test(profile), true)
    ok('Profile: the code is verified as email_change', /verifyCode:\s*\(email, code\)\s*=>\s*supabase\.auth\.verifyOtp\(\{\s*email,\s*token:\s*code,\s*type:\s*'email_change'\s*\}\)/.test(profile), true)
    ok('Profile: the contact follows on this row', /saveContact:\s*\(email\)\s*=>\s*supabase\.from\('users'\)\.update\(\{\s*email\s*\}\)\.eq\('id', user\.id\)/.test(profile), true)
    ok('Profile: confirm goes through confirmEmailChange', /confirmEmailChange\(emailIO, email, emailCode\)/.test(profile), true)
    ok('Profile: shows the sign-in email when it differs', /loginEmail && !sameEmail\(loginEmail, shownEmail\)/.test(profile), true)
    for (const k of ['email_login_note', 'email_code_sent', 'email_code_confirm', 'email_changed', 'email_changed_contact_failed', 'email_taken', 'email_invalid', 'email_rate_limited', 'signin_email', 'signin_email_differs']) {
      ok(`Profile: uses ${k}`, profile.includes(`'${k}'`), true)
    }
    const login = code('src/screens/LoginScreen.tsx')
    ok('Login: Forgot password says which email to use, right under its instructions',
      /\{t\('reset_instructions'\)\}<\/Text>[\s\S]{0,400}?<Text style=\{styles\.formSub\}>\{t\('reset_which_email'\)\}<\/Text>/.test(login), true)

    const i18n = read('src/lib/i18n.ts')
    const keys = ['email_login_note', 'email_code_sent', 'email_code_confirm', 'email_changed', 'email_changed_contact_failed', 'email_taken', 'email_invalid', 'email_rate_limited', 'signin_email', 'signin_email_differs', 'reset_which_email']
    for (const k of keys) ok(`i18n: ${k} in en, es and pt`, (i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 3)
    const lines = i18n.split('\n').filter(l => new RegExp(`\\b(${keys.join('|')}):`).test(l))
    ok('i18n: crew, never "employee"', lines.filter(l => /employ|emplead|funcion/i.test(l)), [])
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
