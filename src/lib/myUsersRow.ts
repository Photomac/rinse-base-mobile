// Which public.users row a login acts as: the one the database resolves.
//
// A login reaches public.users two ways: through a row whose id IS the login
// (owners created at signup, older rows) and through a row linked by
// auth_user_id (invited crew). get_my_tenant_id(), get_my_user_id() and
// get_user_role() take the ACTIVE row whose id is the login, else the ACTIVE
// row linked by auth_user_id, and every RLS policy follows that row. The app
// used to ask for either row with `.maybeSingle()`, which errors when both are
// readable (a crew member with two rows in one company): App.tsx then fell back
// to the offline copy, and the background handlers gave up.
//
// Fetch both candidates in one query and pass them here:
//   .from('users').select(...).or(myUsersRowFilter(authId))
// Include id, auth_user_id and is_active in the select. Under RLS the app sees
// at most these two rows, both in its company.
//
// Mirror of rinsebase-app supabase/functions/_shared/my-users-row.ts (the web
// app and the edge functions): change both, and the SQL helpers, together.

export interface MyUsersRowCandidate {
  id: string
  auth_user_id?: string | null
  is_active?: boolean | null
}

/** The `or=` filter that fetches both candidate rows for this login. */
export function myUsersRowFilter(authId: string): string {
  return `id.eq.${authId},auth_user_id.eq.${authId}`
}

/**
 * The active row whose id is the login, else the active row linked by
 * auth_user_id, else null. A missing is_active (a select that left it out)
 * counts as active, as `is_active is not false` does in SQL.
 */
export function pickMyUsersRow<T extends MyUsersRowCandidate>(rows: readonly T[] | null | undefined, authId: string): T | null {
  if (!authId) return null
  const active = (rows ?? []).filter((r) => r && r.is_active !== false)
  return active.find((r) => r.id === authId) ?? active.find((r) => r.auth_user_id === authId) ?? null
}
