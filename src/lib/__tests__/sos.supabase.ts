// The REAL supabase-js client, pointed at the fake network in sos.mocks.ts.
// scripts/test-sos.mjs swaps this in for src/lib/supabase.ts. Global fetch is
// replaced too, because sosQueue sends the Expo push with plain fetch.
import { createClient } from '@supabase/supabase-js'
import { fakeFetch } from './sos.mocks'

;(globalThis as any).fetch = fakeFetch

export const supabase = createClient('https://sos-test.supabase.co', 'test-anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: fakeFetch as any },
})
