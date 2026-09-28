// The REAL supabase-js client, pointed at the fake network in sos.mocks.ts.
// The runners swap this in for src/lib/supabase.ts. Global fetch is replaced
// too, because sosQueue sends the Expo push with plain fetch.
//
// A signed-in session is seeded into the client's own storage (no network: a
// stored, unexpired session is returned as-is), because the push step refuses
// to run signed out. `session.drop()` / `session.restore()` flip it.
import { createClient } from '@supabase/supabase-js'
import { fakeFetch } from './sos.mocks'

;(globalThis as any).fetch = fakeFetch

const AUTH_KEY = 'sos-test-auth'
const authStore = new Map<string, string>()
const seeded = JSON.stringify({
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
  user: { id: 'u-mia', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
})
authStore.set(AUTH_KEY, seeded)

export const session = {
  drop: () => { authStore.delete(AUTH_KEY) },
  restore: () => { authStore.set(AUTH_KEY, seeded) },
}

export const supabase = createClient('https://sos-test.supabase.co', 'test-anon-key', {
  auth: {
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storageKey: AUTH_KEY,
    storage: {
      getItem: async (k: string) => authStore.get(k) ?? null,
      setItem: async (k: string, v: string) => { authStore.set(k, v) },
      removeItem: async (k: string) => { authStore.delete(k) },
    },
  },
  global: { fetch: fakeFetch as any },
})
