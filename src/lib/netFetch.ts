// Network layer for every call the Supabase client makes (auth, PostgREST,
// storage, functions). Passed to createClient as `global.fetch`.
//
// Three jobs, each one a field failure:
//
// 1. DEADLINES. React Native's fetch has no timeout of its own: iOS gives up
//    after ~60 s, Android (OkHttp under RN 0.81) never does. On one bar of
//    signal a screen waited minutes, one request after another. Every request
//    now aborts on a deadline, and a timeout surfaces as a network failure —
//    postgrest-js turns that into status 0, which is exactly what dataCache
//    (read from the saved copy) and the outbox (queue the write) key on.
//
// 2. REACHABILITY WITHOUT NetInfo. NetInfo is a native module this build does
//    not have (adding it would move the OTA fingerprint lane), so the app
//    learns about the network from its own traffic: any HTTP answer from our
//    Supabase host means "reachable" (TLS guarantees it really was Supabase,
//    not a captive portal), a thrown fetch means "not". isReachable() answers
//    from that, or with a small probe when the last answer is old.
//
// 3. NO REQUEST WITH A LAPSED SIGN-IN. Access tokens last an hour and renew
//    only with signal. When a renewal can't happen, the app carries on with
//    the stored sign-in (see supabase.ts), and any request that would present
//    the expired token fails HERE as a network failure instead of reaching
//    the server for a certain 401 — which dataCache would not fall back on
//    and the outbox would count toward parking somebody's pay.
//
// Also: while the last round trip failed, the token-renewal request is held
// for up to a few seconds and released the moment anything gets through.
// Without the hold, auth-js's retry loop sleeps up to 12.8 s between
// attempts, so a crew member back in signal could wait that long for the
// renewal; with it the loop polls every few seconds and fires as soon as a
// probe or any other request reaches the server.

export const NET_TIMEOUTS = {
  /** GET/HEAD — the reads screens wait on. */
  read: 15_000,
  /** Inserts, updates, RPCs, edge functions. */
  write: 30_000,
  /** Sign-in, token renewal, password reset. */
  auth: 20_000,
  /** The reachability probe. */
  probe: 4_000,
  /** How long a token renewal waits for signal before trying anyway. */
  refreshHold: 3_000,
  /** How long a reachability answer is trusted before probing again. */
  fresh: 1_500,
}

let base = ''
let apiKey = ''

/** Called once from supabase.ts, before the client makes any request. */
export function configureNet(url: string, anonKey: string) {
  base = url.replace(/\/+$/, '')
  apiKey = anonKey
}

// ── Reachability ────────────────────────────────────────────────────────────
let last: { ok: boolean; at: number } | null = null
// Server clock minus phone clock, from the Date header of the last answer.
// Lets the lapsed-token check below use the server's idea of "now", so a
// phone whose clock runs fast doesn't refuse tokens the server still honours.
let serverOffsetMs: number | null = null
const onReach = new Set<() => void>()

function observe(ok: boolean, res?: Response) {
  last = { ok, at: Date.now() }
  if (!ok) return
  const date = res?.headers?.get?.('date')
  const t = date ? Date.parse(date) : NaN
  if (!Number.isNaN(t)) serverOffsetMs = t - Date.now()
  const waiting = Array.from(onReach)
  onReach.clear()
  waiting.forEach(release => release())
}

let probing: Promise<boolean> | null = null

async function probe(): Promise<boolean> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), NET_TIMEOUTS.probe)
  try {
    // GoTrue's health check: ~100 bytes, no sign-in involved.
    const res = await fetch(`${base}/auth/v1/health`, { headers: { apikey: apiKey }, signal: ac.signal })
    observe(true, res)
    return true
  } catch {
    observe(false)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Can the Supabase host be reached right now? Answers from the last round
 *  trip if it is recent, otherwise probes (one probe at a time). */
export async function isReachable(): Promise<boolean> {
  if (last && Date.now() - last.at < NET_TIMEOUTS.fresh) return last.ok
  if (!probing) probing = probe().finally(() => { probing = null })
  return probing
}

function holdForSignal(maxMs: number): Promise<void> {
  return new Promise(resolve => {
    const release = () => { clearTimeout(timer); onReach.delete(release); resolve() }
    const timer = setTimeout(release, maxMs)
    onReach.add(release)
  })
}

// ── Lapsed-token check ──────────────────────────────────────────────────────
// Base64url decode without atob: the payload is ASCII JSON, a few hundred bytes.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
function b64urlToString(s: string): string {
  let bits = 0
  let acc = 0
  let out = ''
  for (const ch of s.replace(/=+$/, '')) {
    const v = B64.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 0xff)
    }
  }
  return out
}

let lastToken = ''
let lastExpMs: number | null = null
function tokenExpiryMs(token: string): number | null {
  if (token === lastToken) return lastExpMs
  let exp: number | null = null
  try {
    const payload = JSON.parse(b64urlToString(token.split('.')[1] || ''))
    exp = typeof payload?.exp === 'number' ? payload.exp * 1000 : null
  } catch { exp = null }
  lastToken = token
  lastExpMs = exp
  return exp
}

/** Has this JWT expired, by the phone's clock AND by the server's (when an
 *  answer has told us the server's time)? Both must agree: a phone clock that
 *  runs fast must not make the app refuse a token the server still accepts. */
export function tokenLapsed(token: string | null | undefined): boolean {
  if (!token) return false
  const exp = tokenExpiryMs(token)
  if (exp == null) return false
  const now = Date.now()
  if (exp > now) return false
  if (serverOffsetMs != null && exp > now + serverOffsetMs) return false
  return true
}

function bearerOf(headers: any): string | null {
  if (!headers) return null
  const raw = typeof headers.get === 'function'
    ? headers.get('authorization')
    : headers.Authorization ?? headers.authorization
  return typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : null
}

// ── The fetch ───────────────────────────────────────────────────────────────
function deadlineFor(url: string, method: string): number | null {
  if (url.startsWith(`${base}/auth/v1/`)) return NET_TIMEOUTS.auth
  // Storage object uploads carry their own, much longer deadline (a photo on
  // one bar takes minutes). Nothing uploads through the client today — the
  // queues use their own fetch — but a future .upload() must not be cut at 30 s.
  if (url.startsWith(`${base}/storage/v1/object/`) && method !== 'GET' && method !== 'HEAD') return null
  return method === 'GET' || method === 'HEAD' ? NET_TIMEOUTS.read : NET_TIMEOUTS.write
}

export async function netFetch(input: any, init: any = {}): Promise<Response> {
  const url: string = typeof input === 'string' ? input : input?.url ?? String(input)
  if (!base || !url.startsWith(base)) return fetch(input, init)
  const method = String(init?.method || input?.method || 'GET').toUpperCase()
  const isAuth = url.startsWith(`${base}/auth/v1/`)

  if (!isAuth && tokenLapsed(bearerOf(init?.headers))) {
    throw new TypeError('Network request failed (sign-in needs signal to renew)')
  }
  if (isAuth && url.includes('grant_type=refresh_token') && last && !last.ok) {
    await holdForSignal(NET_TIMEOUTS.refreshHold)
  }

  const ac = new AbortController()
  let timedOut = false
  const deadline = deadlineFor(url, method)
  const timer = deadline ? setTimeout(() => { timedOut = true; ac.abort() }, deadline) : null
  const callerSignal: AbortSignal | undefined = init?.signal ?? undefined
  const onCallerAbort = () => ac.abort()
  if (callerSignal) {
    if (callerSignal.aborted) ac.abort()
    else callerSignal.addEventListener?.('abort', onCallerAbort)
  }
  try {
    const res = await fetch(input, { ...init, signal: ac.signal })
    observe(true, res)
    return res
  } catch (e) {
    // A caller cancelling its own request says nothing about the network.
    if (!callerSignal?.aborted) observe(false)
    // "Network request …" so every existing network-failure check matches.
    if (timedOut) throw new TypeError(`Network request timed out after ${Math.round(deadline! / 1000)}s`)
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    callerSignal?.removeEventListener?.('abort', onCallerAbort)
  }
}
