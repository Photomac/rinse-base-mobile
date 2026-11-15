// Why a sign-in has no crew profile to open, said on the login screen.
//
// A crew member the office deactivated can still sign in: the office's
// Deactivate leaves the login in place (it only revokes sessions), so
// signInWithPassword succeeds. But get_my_tenant_id() skips inactive rows, so
// the users read in App.tsx comes back clean and EMPTY, the same answer as a
// login with no users row at all. App.tsx used to drop to the login screen
// there with no message and the session still on the phone, and the crew
// member assumed a wrong password (help-center audit 2026-11-14).
//
// my_profile_status() (rinsebase-app supabase/migrations/
// 20260804224147_my_profile_status.sql, the RPC the web app asks for the same
// reason) tells the cases apart without widening RLS: it returns 'active',
// 'deactivated', 'none' or 'anon', never row data.
//
// Call this ONLY after a users read that succeeded and found no active row.
// A read that ERRORED (no signal) is not an answer, and App.tsx keeps using
// the offline copy for it.

export type SignInRefusal = 'deactivated' | 'no_profile'

export interface SignInRefusalIO {
  /** supabase.rpc('my_profile_status') */
  profileStatus: () => PromiseLike<{ data: unknown; error: unknown }>
  /** Put the reason on the login screen. Called BEFORE signOut, so the
   *  screen the sign-out lands on already carries it. */
  show: (reason: SignInRefusal) => void
  /** Sign this phone out (the SIGNED_OUT handler in App.tsx clears the
   *  offline copies). */
  signOut: () => PromiseLike<unknown>
}

/** What a my_profile_status() answer means for the login screen. Null for
 *  'active', 'anon' or anything unexpected: no reason to refuse. */
export function refusalFor(status: unknown): SignInRefusal | null {
  if (status === 'deactivated') return 'deactivated'
  if (status === 'none') return 'no_profile'
  return null
}

/**
 * Ask the database why this login has no profile. When it is deactivated or
 * has no users row, show the reason and sign out; returns the reason. Returns
 * null and does nothing when the answer is unknown (the check failed) or says
 * the login is active: App.tsx then behaves exactly as it did before.
 */
export async function refuseSignInWithoutProfile(io: SignInRefusalIO): Promise<SignInRefusal | null> {
  let status: unknown
  try {
    const { data, error } = await io.profileStatus()
    if (error) return null
    status = data
  } catch { return null }
  const reason = refusalFor(status)
  if (!reason) return null
  io.show(reason)
  try {
    // supabase-js keeps the stored sign-in when the logout call itself fails
    // (no signal). The notice still shows, and the next launch asks again.
    await io.signOut()
  } catch (e) { console.warn('Sign-out after a refused sign-in failed:', e) }
  return reason
}
