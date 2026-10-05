// Which users row the app acts as. Run with: node scripts/test-my-users-row.mjs
//
// Exercises the REAL src/lib/myUsersRow.ts (pure, nothing to mock) on every
// shape of login, and checks that App.tsx, locationTracker.ts and
// arrivalGeofence.ts use it instead of `.or(...).maybeSingle()`.
//
// The database (get_my_tenant_id(), get_my_user_id(), get_user_role()) takes
// the ACTIVE row whose id is the login, else the ACTIVE row linked by
// auth_user_id. The app asked for either row with .maybeSingle(), which errors
// when both are readable: App.tsx then showed the offline copy (or the login
// screen with none), and the background handlers returned early.
import { myUsersRowFilter, pickMyUsersRow } from '../myUsersRow'

declare const require: (m: string) => any
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

let failures = 0
const ok = (name: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'}  ${name}${pass ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

type Row = { id: string; auth_user_id: string | null; is_active?: boolean }
const L = 'login-L'
const shapes: { what: string; rows: Row[]; want: string | null }[] = [
  { what: 'id row only', want: L, rows: [{ id: L, auth_user_id: null, is_active: true }] },
  { what: 'linked row only', want: 'r-link', rows: [{ id: 'r-link', auth_user_id: L, is_active: true }] },
  { what: 'both readable and active (one company): the id row', want: L,
    rows: [{ id: 'r-link', auth_user_id: L, is_active: true }, { id: L, auth_user_id: null, is_active: true }] },
  { what: 'linked row deactivated: the id row', want: L,
    rows: [{ id: 'r-link', auth_user_id: L, is_active: false }, { id: L, auth_user_id: null, is_active: true }] },
  { what: 'id row deactivated: the linked row', want: 'r-link',
    rows: [{ id: L, auth_user_id: null, is_active: false }, { id: 'r-link', auth_user_id: L, is_active: true }] },
  { what: 'every row deactivated: none', want: null, rows: [{ id: L, auth_user_id: null, is_active: false }] },
  { what: 'no row: none', want: null, rows: [] },
]
console.log('\npickMyUsersRow: the database\'s row')
for (const s of shapes) ok(s.what, pickMyUsersRow(s.rows, L)?.id ?? null, s.want)
ok('is_active left out counts as active', pickMyUsersRow([{ id: 'r-link', auth_user_id: L }], L)?.id ?? null, 'r-link')
ok('null rows (a failed read)', pickMyUsersRow(null, L), null)
ok('the or= filter names both columns', myUsersRowFilter('a1b2'), 'id.eq.a1b2,auth_user_id.eq.a1b2')

console.log('\nThe app\'s three lookups use it')
const repo = process.env.REPO as string
const code = (p: string) => (readFileSync(join(repo, p), 'utf8') as string).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
for (const p of ['App.tsx', 'src/lib/locationTracker.ts', 'src/lib/arrivalGeofence.ts']) {
  const src = code(p)
  ok(`${p}: reads both candidates with myUsersRowFilter`, /\.or\(myUsersRowFilter\(authId\)\)/.test(src), true)
  ok(`${p}: picks with pickMyUsersRow`, /pickMyUsersRow\(rows, authId\)/.test(src), true)
  ok(`${p}: no .or(auth_user_id…/id…) lookup left`, /\.or\(`auth_user_id\.eq\./.test(src), false)
}
for (const p of ['src/lib/locationTracker.ts', 'src/lib/arrivalGeofence.ts']) {
  ok(`${p}: selects auth_user_id and is_active for the pick`, /select\('id, tenant_id, auth_user_id, is_active'\)/.test(code(p)), true)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
if (failures) process.exit(1)
