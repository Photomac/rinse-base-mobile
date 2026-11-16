// Bundle entry for the profile-load scenarios: the real modules under test,
// bundled with the real supabase-js by scripts/test-profile-loads.mjs.
export { supabase, isSignedOut } from '../supabase'
export { createProfileLoads, sameProfile, PROFILE_FRESH_MS } from '../profileLoads'
