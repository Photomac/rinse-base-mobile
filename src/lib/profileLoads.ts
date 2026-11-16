// When App.tsx loads the signed-in person's profile, and when it doesn't.
// Pure: no React Native, no supabase (scripts/test-profile-loads.mjs runs it,
// with the app's real supabase-js for the launch).
//
// THE BUG (CKS, 2026-11-16). App.tsx loaded the profile from getSession() AND
// from every auth event that carries a session. For a phone that is already
// signed in, supabase-js 2.99.2 sends three of those at launch, a few
// milliseconds apart: SIGNED_IN (or TOKEN_REFRESHED when the hour-long token
// had lapsed) while it reads the stored sign-in, the getSession() answer, and
// INITIAL_SESSION to the new listener. So the whole profile load ran three
// times, and each run handed the screens a new profile object, which re-ran
// everything keyed on it (the offline catch-up, the open-jobs count, Home's
// reads). Krystal's 14:01Z launch: users read 6 times, user_private_details,
// push_tokens, crew_locations, record_client_version, record_location_setting
// and open_board_jobs 3 times each. Fleet, 24 h to 2026-11-16 18:00Z: 1,308
// profile loads from the crew app, about 609 of them repeats. The token
// renewal while the app is open (about hourly) also reloaded it, unchanged.
//
// THE RULES.
//   - One load at a time: a request for the login already loading waits for
//     that load instead of starting its own (the launch's three become one).
//   - A load happens only when the profile on screen isn't current: none
//     shown, another login, it came from the offline copy (or part of it
//     did), or the last full load is PROFILE_FRESH_MS old. So a token renewal
//     still picks up office changes (clock mode, time zone, role) about as
//     often as before, and a phone that opened with no signal reloads the
//     moment a renewal gets through. USER_UPDATED (an email change) always
//     loads.
//   - Sign out forgets everything, and a load still out may no longer apply
//     its answer (isCurrent).
//   - The startup chores (push token, location tracking, SOS resume) run once
//     per login per sign-in, and again only if the company or role changed.
// App.tsx keeps the same profile object when a reload finds nothing changed
// (sameProfile), so nothing keyed on it runs again.

/** How old the last full load may get before a token renewal reloads it. */
export const PROFILE_FRESH_MS = 30 * 60_000

/** What a load ended with, for the next request's decision. */
export interface ProfileOutcome {
  /** A profile is on screen (false: none found, or no copy to fall back on). */
  shown: boolean
  /** Some of it came from the offline copy or a default, not the server. */
  stale: boolean
}

export interface ProfileLoads {
  /** Load for this auth event unless the profile on screen is current, or a
   *  load for this login is already out (then wait for that one). Never rejects. */
  request(event: string, authId: string, load: (gen: number) => Promise<void>): Promise<void>
  /** May the load started with this generation still apply its answer? False
   *  once the phone signed out or another login began. */
  isCurrent(gen: number): boolean
  /** What the load with this generation ended with. */
  settle(gen: number, authId: string, outcome: ProfileOutcome): void
  /** Should the startup chores run for this profile now? Once per login per
   *  sign-in, and again when its company or role changed. */
  choresDue(authId: string, profile: { tenant_id?: unknown; role?: unknown }): boolean
  /** Signed out: forget everything. */
  reset(): void
}

export function createProfileLoads(now: () => number = Date.now): ProfileLoads {
  let gen = 0
  let inflight: { authId: string; gen: number; p: Promise<void> } | null = null
  let again = false
  let state: { authId: string; shown: boolean; stale: boolean; at: number } | null = null
  let chores: string | null = null

  const wants = (event: string, authId: string): boolean => {
    if (event === 'USER_UPDATED') return true
    if (!state || state.authId !== authId) return true
    if (!state.shown || state.stale) return true
    return now() - state.at >= PROFILE_FRESH_MS
  }

  return {
    request(event, authId, load) {
      if (inflight && inflight.gen === gen && inflight.authId === authId) {
        // An email change while a load is out: its answer may predate it.
        if (event === 'USER_UPDATED') again = true
        return inflight.p
      }
      // Another login than the one loading or shown: the older load's answer
      // must not land on top of this one.
      if ((inflight && inflight.authId !== authId) || (state && state.authId !== authId)) gen++
      if (!wants(event, authId)) return Promise.resolve()
      const mine = gen
      const entry = { authId, gen: mine, p: Promise.resolve() }
      inflight = entry
      entry.p = (async () => {
        try {
          do {
            again = false
            try { await load(mine) } catch (e) { console.warn('Profile load failed:', e) }
          } while (again && mine === gen)
        } finally {
          if (inflight === entry) inflight = null
        }
      })()
      return entry.p
    },
    isCurrent(g) { return g === gen },
    settle(g, authId, outcome) {
      if (g !== gen) return
      state = { authId, shown: outcome.shown, stale: outcome.stale, at: now() }
    },
    choresDue(authId, profile) {
      const key = `${authId}|${String(profile?.tenant_id ?? '')}|${String(profile?.role ?? '')}`
      if (chores === key) return false
      chores = key
      return true
    },
    reset() {
      gen++
      inflight = null
      again = false
      state = null
      chores = null
    },
  }
}

/** Same profile, field for field (key order doesn't matter)? A reload that
 *  answers this keeps the object already on screen. */
export function sameProfile(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  try { return stable(a) === stable(b) } catch { return false }
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
}
