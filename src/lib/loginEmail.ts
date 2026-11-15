// The email a crew member signs in with, and changing it from the crew app.
//
// users.email is the contact address the company sees; auth.users.email is the
// login. Profile → Edit used to write users.email only, so a crew member who
// changed it kept signing in with the old address and wasn't told, and
// "Forgot your password?" with the new one sent nothing (GoTrue answers success
// for an unknown email). Help-center audit 2026-11-14, troubleshooting §4.
//
// Now a NEW address moves the login first, the GoTrue way:
//   1. supabase.auth.updateUser({ email }) emails a code to the new address.
//      Prod has secure email change OFF, so only the new address confirms, and
//      autoconfirm never skips this for a real (non-anonymous) user
//      (supabase/auth internal/api/user.go, GoTrue v2.197 on prod 2026-11-15).
//   2. verifyOtp({ email, token, type: 'email_change' }) with that code moves
//      the login.
//   3. Only then is users.email saved, so this screen never splits the two.
// The code is the proof the crew member owns the mailbox (auto-confirm proves
// nothing on this project). An address another login already holds is refused
// by GoTrue (422 email_exists), the same rule accept-crew-invite applies.
//
// Needs the "Confirm Email Change" template to carry {{ .Token }}: the code
// this screen asks for (Supabase Auth settings, changed 2026-11-15).

export type EmailSavePlan =
  | { kind: 'invalid' }
  /** Nothing for the login to do: save users.email as typed. */
  | { kind: 'contact_only'; email: string | null }
  /** A new address: move the login by a code first. */
  | { kind: 'move_login'; email: string }

const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase()

export function looksLikeEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
}

/** Same address, ignoring case and spaces (GoTrue compares lower-cased). */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!norm(a) && norm(a) === norm(b)
}

/**
 * What saving the contact card means for the login.
 * - Empty: clears the contact address (as before); the login is untouched.
 * - The login's own address (any case): contact only. This also mends a row
 *   whose contact email had drifted from the login.
 * - Anything else: the login moves first, by a code.
 * When the login address can't be read, an unchanged contact email saves as
 * before and a changed one still goes through the code.
 */
export function planEmailSave(typed: string, contactEmail: string | null | undefined, loginEmail: string | null | undefined): EmailSavePlan {
  const email = typed.trim()
  if (!email) return { kind: 'contact_only', email: null }
  if (!looksLikeEmail(email)) return { kind: 'invalid' }
  if (loginEmail ? sameEmail(email, loginEmail) : sameEmail(email, contactEmail)) return { kind: 'contact_only', email }
  return { kind: 'move_login', email }
}

export type EmailChangeFailure = 'taken' | 'rate_limited' | 'network' | 'bad_code' | 'other'

/** Sort a GoTrue error into something the crew member can act on. */
export function emailChangeFailure(err: any, step: 'start' | 'confirm'): EmailChangeFailure {
  const code = String(err?.code ?? '')
  const msg = String(err?.message ?? err ?? '')
  if (code === 'email_exists' || /already (been )?registered|email_exists|already in use/i.test(msg)) return 'taken'
  if (/rate_limit/.test(code) || /rate limit|too many|for security purposes/i.test(msg)) return 'rate_limited'
  if (err?.name === 'AuthRetryableFetchError' || /network|failed to fetch|timed? ?out/i.test(msg)) return 'network'
  if (step === 'confirm' && (code === 'otp_expired' || /expired|invalid|not found/i.test(msg))) return 'bad_code'
  return 'other'
}

export interface EmailChangeIO {
  /** supabase.auth.updateUser({ email }): sends the code to the new address. */
  requestCode: (email: string) => PromiseLike<{ error: any }>
  /** supabase.auth.resend({ type: 'email_change', email }) */
  resendCode: (email: string) => PromiseLike<{ error: any }>
  /** supabase.auth.verifyOtp({ email, token, type: 'email_change' }) */
  verifyCode: (email: string, code: string) => PromiseLike<{ error: any }>
  /** users.email = email on this person's row. */
  saveContact: (email: string) => PromiseLike<{ error: any }>
}

export type EmailChangeResult =
  | { ok: true; contactSaved: boolean }
  | { ok: false; failure: EmailChangeFailure; message: string }

const failed = (err: any, step: 'start' | 'confirm'): EmailChangeResult =>
  ({ ok: false, failure: emailChangeFailure(err, step), message: String(err?.message ?? err ?? '') })

/** Step 1 (or Resend): email a code to the new address. Nothing moves yet. */
export async function startEmailChange(io: EmailChangeIO, email: string, resend = false): Promise<EmailChangeResult> {
  try {
    const { error } = await (resend ? io.resendCode(email) : io.requestCode(email))
    return error ? failed(error, 'start') : { ok: true, contactSaved: false }
  } catch (e) { return failed(e, 'start') }
}

/**
 * Step 2: the code moves the login; then the contact email follows. A wrong
 * or expired code changes nothing. If the login moved but the contact save
 * failed, `contactSaved` is false: saving the same address again is then a
 * contact-only save (planEmailSave), which mends it.
 */
export async function confirmEmailChange(io: EmailChangeIO, email: string, code: string): Promise<EmailChangeResult> {
  const token = code.replace(/\s+/g, '')
  if (token.length < 6) return { ok: false, failure: 'bad_code', message: '' }
  try {
    const { error } = await io.verifyCode(email, token)
    if (error) return failed(error, 'confirm')
  } catch (e) { return failed(e, 'confirm') }
  try {
    const { error } = await io.saveContact(email)
    return { ok: true, contactSaved: !error }
  } catch { return { ok: true, contactSaved: false } }
}
