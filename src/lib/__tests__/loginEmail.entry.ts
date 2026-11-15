// Bundle entry for the email-change scenarios: the real modules under test,
// bundled with the real supabase-js by scripts/test-login-email.mjs.
export { supabase } from '../supabase'
export { planEmailSave, sameEmail, looksLikeEmail, emailChangeFailure, startEmailChange, confirmEmailChange } from '../loginEmail'
