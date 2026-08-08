// Offline profile cache — Phase 1 of offline support.
//
// The app gates rendering on the crew profile row (App.tsx loadUser), which is
// a LIVE Supabase query. With no connectivity that query fails, user stays
// null, and a crew member with a perfectly valid cached session gets bounced
// to the login screen (confirmed in the field 2026-07-26, Airplane Mode).
//
// Fix: persist the fully-decorated profile (including the _contact/_timeMode/
// _laundryBonus tenant decorations) after every successful load, keyed by auth
// user id, and fall back to it when the live fetch errors. Keyed per-user so a
// device shared between crew members can never resurrect someone else's
// profile. Cleared when the server says the profile genuinely no longer
// exists, and on sign-out.
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY_PREFIX = 'cachedProfile:'

export async function saveCachedProfile(authId: string, user: any): Promise<void> {
  try { await AsyncStorage.setItem(KEY_PREFIX + authId, JSON.stringify(user)) } catch { /* best effort */ }
}

export async function loadCachedProfile(authId: string): Promise<any | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + authId)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export async function clearCachedProfile(authId: string): Promise<void> {
  try { await AsyncStorage.removeItem(KEY_PREFIX + authId) } catch { /* best effort */ }
}
