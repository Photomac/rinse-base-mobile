#!/usr/bin/env node
// Signed-in users can't SELECT a users row's private columns (web repo,
// 20261014170000_users_private_columns_office_only): pay, SSN, bank, date of
// birth, licence, tax, home address, emergency contact, notes, payroll ids.
// A users read that names one of them, or '*', fails with 42501: App.tsx's
// own-row read did (select('*')), which on a phone with no cached profile is
// the login screen.
//
// Checks, on the source as it is (no build, nothing to mock):
//   1. USERS_READABLE_COLUMNS (src/lib/userPrivateDetails.ts) is the list the
//      migration grants, as the web app's copy holds it.
//   2. Every .from('users') read and every users embed in App.tsx and src/
//      names readable columns only, filters included. No '*'.
//   3. Own pay comes from user_private_details() through fetchMyPay() only,
//      and App.tsx keeps nothing private but the three pay fields.
//
// Usage: node scripts/test-users-private-columns.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
let failures = 0
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'}  ${name}${pass ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

// The grant (web repo: supabase/tests/users_private_columns_office_only.test.sql's
// upc_readable(), src/lib/userPrivateDetails.ts's USERS_READABLE_COLUMNS).
const GRANTED = ['id', 'tenant_id', 'full_name', 'email', 'phone', 'role', 'is_active', 'preferred_language',
  'sos_enabled', 'vehicle_type', 'certifications', 'avatar_url', 'invited_at', 'invite_accepted_at',
  'created_at', 'updated_at', 'auth_user_id', 'hire_date', 'end_date', 'shirt_size',
  'stripe_connect_onboarded', 'is_demo', 'invite_expires_at', 'nickname', 'removed_at', 'email_self_set_at']

const lib = read('src/lib/userPrivateDetails.ts')
const READABLE = (/export const USERS_READABLE_COLUMNS = '([^']*)'/.exec(lib)?.[1] ?? '').split(',').map((c) => c.trim())
ok('USERS_READABLE_COLUMNS is the granted list, in order', READABLE, GRANTED)

function files(dir) {
  return readdirSync(join(repo, dir)).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(join(repo, p)).isDirectory()) return f === '__tests__' ? [] : files(p)
    return /\.(ts|tsx)$/.test(f) ? [p] : []
  })
}
// Whole-line comments blanked (kept as empty lines, so line numbers hold):
// they quote reads as examples.
const code = (p) => read(p).split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n')
const SRC = ['App.tsx', ...files('src')].map((file) => ({ file, text: code(file) }))
const LIB = 'src/lib/userPrivateDetails.ts'

// "a, b, rel(x), alias:c" -> top-level names (embeds dropped, aliases and casts stripped)
function topLevel(list) {
  const cols = []
  let depth = 0, cur = ''
  for (const ch of list + ',') {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      const t = cur.trim()
      if (t && !t.includes('(')) cols.push(t.replace(/^\w+:/, '').replace(/::\w+$/, ''))
      cur = ''
      continue
    }
    cur += ch
  }
  return cols
}

let chains = 0, embeds = 0
const bad = []
for (const { file, text } of SRC) {
  if (file === LIB) continue
  for (const m of text.matchAll(/\.from\('users'\)/g)) {
    chains++
    const at = m.index + m[0].length
    const rest = text.slice(at, at + 700)
    const stop = rest.search(/\bsupabase\.|\bawait\b|\.from\(|;\s*\n/)
    const chain = stop >= 0 ? rest.slice(0, stop) : rest
    const where = `${file}:${text.slice(0, m.index).split('\n').length}`
    const sel = /\.select\(\s*(?:'([^']*)'|(USERS_READABLE_COLUMNS))/.exec(chain)
    if (/\.select\(/.test(chain) && !sel) bad.push(`${where}: a select this test can't read`)
    if (sel) {
      const list = sel[2] ? READABLE.join(', ') : sel[1]
      if (list.trim() === '*') bad.push(`${where}: select('*')`)
      else for (const c of topLevel(list)) if (!READABLE.includes(c)) bad.push(`${where}: selects ${c}`)
    }
    for (const f of chain.matchAll(/\.(?:eq|neq|is|in|not|gt|gte|lt|lte|like|ilike|order|contains)\('([a-z0-9_]+)'/g)) {
      if (!READABLE.includes(f[1])) bad.push(`${where}: filters or sorts on ${f[1]}`)
    }
  }
  for (const m of text.matchAll(/\busers(?:!\w+)*\(([^()]*)\)|\busers:\w+\(([^()]*)\)/g)) {
    embeds++
    const where = `${file}:${text.slice(0, m.index).split('\n').length}`
    const cols = topLevel(m[1] ?? m[2] ?? '')
    if (cols.includes('*')) bad.push(`${where}: users(*) embed`)
    else for (const c of cols) if (!READABLE.includes(c)) bad.push(`${where}: embeds users.${c}`)
  }
}
ok(`every users read names readable columns only (${chains} .from('users') reads, ${embeds} embeds)`, bad, [])
ok('the scan found the reads (not a broken regex)', chains >= 8 && embeds >= 6, true)

const app = read('App.tsx')
ok("App.tsx: the signed-in row names its columns", /\.from\('users'\)\.select\(USERS_READABLE_COLUMNS\)\.or\(myUsersRowFilter\(authId\)\)/.test(app), true)
ok('App.tsx: own pay comes from fetchMyPay()', /const pay = await fetchMyPay\(data\.id\)/.test(app), true)
ok('fetchMyPay keeps only pay_type, hourly_rate, per_job_rate',
  /return r \? \{ pay_type: r\.pay_type, hourly_rate: r\.hourly_rate, per_job_rate: r\.per_job_rate \} : null/.test(lib), true)
ok('fetchMyPay reads the columns directly only when the function is missing (PGRST202)',
  /if \(error\.code !== 'PGRST202'\) throw error\s+const old = await supabase\.from\('users'\)\.select\('pay_type, hourly_rate, per_job_rate'\)/.test(lib), true)
ok('fetchMyPay is the only caller of user_private_details',
  SRC.filter((s) => s.file !== LIB && /rpc\(\s*'user_private_details'/.test(s.text)).map((s) => s.file), [])
ok('Profile: the pay card shows only when pay loaded', /\{user\.pay_type \? \(\s*<View style=\{styles\.card\}>\s*<Text style=\{styles\.sectionTitle\}>\{t\('pay_structure'\)\}/.test(read('src/screens/ProfileScreen.tsx')), true)

console.log(failures ? `\n${failures} FAILED` : `\nall passed (${relative(process.cwd(), repo) || '.'})`)
if (failures) process.exit(1)
