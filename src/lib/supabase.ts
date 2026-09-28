import { createClient } from '@supabase/supabase-js'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { configureNet, netFetch, isReachable, tokenLapsed } from './netFetch'

const supabaseUrl = 'https://cbnbhwclbtowfbjylnph.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNibmJod2NsYnRvd2ZianlsbnBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNjg1OTksImV4cCI6MjA4ODc0NDU5OX0.pfQFy21RkWCUBjCNFK1C_Z9clT2zE6wIv8qSKL4KYaM'

// supabase-js's default storage key for this project (`sb-<ref>-auth-token`).
// readStoredSession() must read exactly what the library writes; changing the
// key would sign every crew member out.
const SESSION_KEY = `sb-${supabaseUrl.split('//')[1].split('.')[0]}-auth-token`

const storage = Platform.OS === 'web' ? {
  getItem: (key: string) => Promise.resolve(localStorage.getItem(key)),
  setItem: (key: string, value: string) => Promise.resolve(localStorage.setItem(key, value)),
  removeItem: (key: string) => Promise.resolve(localStorage.removeItem(key)),
} : {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
}

configureNet(supabaseUrl, supabaseAnonKey)

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  // Deadlines, reachability and the lapsed-token guard — see netFetch.ts.
  global: { fetch: netFetch },
})

/** The sign-in saved on this phone, read straight from storage: no network,
 *  no refresh. Null when signed out. */
export async function readStoredSession(): Promise<Session | null> {
  try {
    const raw = await storage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    return s && typeof s === 'object' && s.access_token && s.refresh_token && s.expires_at ? s as Session : null
  } catch { return null }
}

// ── Sign-in that survives the one-hour token lapse offline ──────────────────
//
// Access tokens last an hour and renew only with signal. supabase-js calls
// auth.getSession() before EVERY request, and once the token is inside 90 s
// of expiry getSession() insists on renewing it: with no signal it retries
// for ~25 s and then returns NO session. Measured against this app's
// supabase-js 2.99.2 with the token expired and the network dead: the first
// getSession() answered null after 50.8 s, three parallel reads finished one
// after another at 76 / 102 / 127 s, and App.tsx routed the null session to
// the login screen, where nothing can be queued. The stored sign-in was
// intact the whole time; only the renewal needed signal.
//
// So getSession() is wrapped. With plenty of time left on the token, the
// library answers as before. When it needs renewing and the server can't be
// reached, the stored sign-in is handed back at once: requests that would
// present the lapsed token fail locally as network failures (netFetch.ts), so
// reads come from the saved copy and writes queue in the outbox, exactly as
// in the first hour offline. The renewal keeps retrying in the background and
// lands as TOKEN_REFRESHED when signal returns.
//
// A sign-in the SERVER rejects (revoked, user removed) is still dropped: the
// library deletes it from storage, and a stored sign-in that has gone away is
// never handed back.

// auth-js renews inside 90 s of expiry on getSession() and inside 120 s on
// its 30-second ticker. Past this line, a getSession() may need the network.
const RENEW_WINDOW_MS = 150_000
// With the server reachable, how long a request waits for a renewal before
// going ahead on the stored sign-in (weak signal).
export const AUTH_WAIT = { ms: 8_000 }

type GetSessionResult = Awaited<ReturnType<typeof supabase.auth.getSession>>
const libraryGetSession = supabase.auth.getSession.bind(supabase.auth)
let libraryCall: Promise<GetSessionResult> | null = null
// Last session seen, so the everyday case skips the storage read.
let known: Session | null = null

// One renewal attempt at a time: every caller while it runs shares it.
function askLibrary(): Promise<GetSessionResult> {
  if (!libraryCall) libraryCall = libraryGetSession().finally(() => { libraryCall = null })
  return libraryCall
}

function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: any
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms) }),
  ])
}

const msLeft = (s: Session) => (s.expires_at ?? 0) * 1000 - Date.now()
const stored = (s: Session): GetSessionResult => ({ data: { session: s }, error: null })

supabase.auth.getSession = async (): Promise<GetSessionResult> => {
  if (!known || msLeft(known) < RENEW_WINDOW_MS) known = await readStoredSession()
  if (!known) return libraryGetSession()

  if (msLeft(known) >= RENEW_WINDOW_MS) {
    // No renewal due: the library answers from storage without the network.
    const r = await within(libraryGetSession(), 3_000)
    if (!r) return stored(known)
    known = r.data.session
    return r
  }

  // Renewal due. Start it (or join the one running), then decide how long
  // to wait for it.
  const renewal = askLibrary()
  if (!(await isReachable())) return stored(known)
  const r = await within(renewal, AUTH_WAIT.ms)
  if (!r) return stored(known)
  if (r.data.session) { known = r.data.session; return r }
  // No session back. The library only deletes the stored sign-in when the
  // server refused the renewal; a network failure leaves it in place.
  known = await readStoredSession()
  return known ? stored(known) : r
}

/** Does this auth event mean the crew member is really signed out?
 *  SIGNED_OUT always does. An event with no session for any other reason
 *  (INITIAL_SESSION after a renewal that couldn't reach the server) only
 *  does when no sign-in is left on the phone. */
export async function isSignedOut(event: AuthChangeEvent, session: Session | null): Promise<boolean> {
  if (session) return false
  if (event === 'SIGNED_OUT') { known = null; return true }
  return !(await readStoredSession())
}

/** Access token for a request made outside the client (the photo and video
 *  queues upload with their own fetch). Null when there is none, or when it
 *  has lapsed and couldn't be renewed — treat that as "no signal yet". */
export async function usableAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token ?? null
  return token && !tokenLapsed(token) ? token : null
}
