// Signed-in users can't SELECT a users row's private columns: pay, SSN, bank,
// date of birth, licence, tax, home address, emergency contact, notes,
// payroll ids (web repo, 20261014170000_users_private_columns_office_only).
// Every crew member used to be able to read every colleague's SSN and bank
// account from the REST API.
//
// A users read that names one of them, or '*', now fails with 42501, so the
// app names its columns from USERS_READABLE_COLUMNS (the same list as the web
// app's src/lib/userPrivateDetails.ts and the migration's grant). A crew
// member's own pay comes from user_private_details(), which gives anyone their
// own row (owners: everyone in their company).
import { supabase } from './supabase'

/** Every users column a signed-in user may SELECT, in table order. One literal, so supabase-js can type the rows. */
export const USERS_READABLE_COLUMNS = 'id, tenant_id, full_name, email, phone, role, is_active, preferred_language, sos_enabled, vehicle_type, certifications, avatar_url, invited_at, invite_accepted_at, created_at, updated_at, auth_user_id, hire_date, end_date, shirt_size, stripe_connect_onboarded, is_demo, invite_expires_at, nickname, removed_at, email_self_set_at'

/** The pay fields the Profile tab shows. Nothing else private is kept on the phone. */
export type MyPay = { pay_type: string | null; hourly_rate: number | null; per_job_rate: number | null }

/** The signed-in person's own pay (userId = their users.id). Throws the database's error. */
export async function fetchMyPay(userId: string): Promise<MyPay | null> {
  const { data, error } = await supabase.rpc('user_private_details', { p_user_id: userId })
  if (!error) {
    const r = ((data ?? []) as any[])[0]
    return r ? { pay_type: r.pay_type, hourly_rate: r.hourly_rate, per_job_rate: r.per_job_rate } : null
  }
  // Until the migration is applied the function doesn't exist (PostgREST
  // PGRST202) and the columns are still readable: read them as before, so this
  // update can reach phones first. Once it's applied this never runs.
  if (error.code !== 'PGRST202') throw error
  const old = await supabase.from('users').select('pay_type, hourly_rate, per_job_rate').eq('id', userId).maybeSingle()
  if (old.error) throw old.error
  return (old.data as MyPay | null) ?? null
}
