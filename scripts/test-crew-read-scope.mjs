#!/usr/bin/env node
// Crew phones ask for their own cleans, not the company's (crew read scope,
// stage 1; rinse-base-app docs/crew-read-scope-plan.md section 5.4).
//
// Until stage 1, Home's day, Home's "Needs closing" and Schedule read every
// clean in the company and filtered on the phone, so every property's lockbox
// code and every client's phone sat on every crew phone and in its saved
// copy. This keeps it from coming back:
//
//   1. lib/crewScope.ts, run as is (Node type stripping): the crew select
//      drops the clients embed and makes job_assignments(user_id) !inner,
//      the crew filter is on that embed, crew_job_context's answer lands on
//      each row as `clients` (and a dead network fails the read so the saved
//      copy answers), and the place label says "Address shows from the day
//      before" for a crew clean with no property.
//   2. Source: every jobs read in App.tsx and src/ that asks for a lockbox
//      code or a clients embed is either one clean (by id), the viewer's own
//      (job_assignments.user_id / driver_user_id), built through
//      jobSelectFor() + onlyMine(), or listed below as office-only with why.
//   3. Source: Home and Schedule read through the shared builders, which go
//      through crewScope for crew.
//   4. Source: no `client_addresses.x` / `clients.x` without `?.` in App.tsx
//      or src/: once scope is on, a crew clean outside the window comes back
//      with no property, and an unguarded read of it throws.
//
// No package.json script on purpose (scripts are an OTA fingerprint input):
// CI runs it (.github/workflows/crew-read-scope.yml).
//
// Usage: node scripts/test-crew-read-scope.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
let failures = 0
const ok = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? '✓' : '✗'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`)
}

// ── 1. lib/crewScope.ts ─────────────────────────────────────────────────────
const { crewJobSelect, jobSelectFor, onlyMine, withJobContext, placeLabel, CONTEXT_CHUNK } =
  await import(join(repo, 'src/lib/crewScope.ts'))

const HOME = /export const HOME_DAY_SELECT = '([^']+)'/.exec(read('src/lib/jobReads.ts'))?.[1] ?? ''
const SCHED = /export const SCHEDULE_JOB_SELECT = '([^']+)'/.exec(read('src/lib/pushTap.ts'))?.[1] ?? ''
ok('Home\'s and Schedule\'s office selects are found', HOME.length > 0 && SCHED.length > 0)
for (const [name, sel] of [['Home', HOME], ['Schedule', SCHED]]) {
  const crew = crewJobSelect(sel)
  ok(`${name}: the office select keeps its clients embed`, /clients!jobs_client_id_fkey\(/.test(jobSelectFor(true, sel)) && jobSelectFor(true, sel) === sel)
  ok(`${name}: the crew select has no clients embed`, !/clients[!(]/.test(crew), crew)
  ok(`${name}: the crew select filters on job_assignments!inner(user_id)`, crew.includes('job_assignments!inner(user_id)') && !/(^|,\s*)job_assignments\(user_id\)/.test(crew))
  ok(`${name}: the crew line (crew:job_assignments) stays whole`, crew.includes('crew:job_assignments!job_assignments_job_id_fkey(user_id, is_lead, users!job_assignments_user_id_fkey(full_name))'))
  ok(`${name}: nothing else changes`, crew === sel.replace(/,\s*clients!jobs_client_id_fkey\([^)]*\)/, '').replace('job_assignments(user_id)', 'job_assignments!inner(user_id)'))
}
let threw = false
try { crewJobSelect('id, status') } catch { threw = true }
ok('a select with no job_assignments(user_id) to filter on is refused, not sent company-wide', threw)

const calls = []
const fakeQ = { eq(col, val) { calls.push([col, val]); return this } }
ok('office: the query is not filtered', onlyMine(fakeQ, true, 'U') === fakeQ && calls.length === 0)
onlyMine(fakeQ, false, 'U')
ok('crew: filtered to their own job_assignments row', JSON.stringify(calls) === JSON.stringify([['job_assignments.user_id', 'U']]))

const ctxRow = (id, extra = {}) => ({ job_id: id, client_type: 'str', display_name: 'Casa', client_name: null, client_phone: null, ...extra })
// (A block right after an arrow function's body: TypeScript's parser, which tsc
// runs over scripts/ too, needs the statement ended first.)
;{
  const rpcCalls = []
  const rpc = async (ids) => { rpcCalls.push(ids); return { data: ids.filter(i => i !== 'gone').map(i => ctxRow(i, i === 'b' ? { client_name: 'Ann', client_phone: '555' } : {})), error: null, status: 200 } }
  const res = await withJobContext({ data: [{ id: 'a' }, { id: 'b' }, { id: 'gone' }], error: null, status: 200 }, rpc)
  ok('context: each row gets `clients` from crew_job_context',
    JSON.stringify(res.data.map(r => r.clients)) === JSON.stringify([
      { full_name: null, phone: null, client_type: 'str' },
      { full_name: 'Ann', phone: '555', client_type: 'str' },
      null,
    ]))
  ok('context: one call for a short list', rpcCalls.length === 1)
  const many = Array.from({ length: CONTEXT_CHUNK * 2 + 5 }, (_, i) => ({ id: `j${i}` }))
  rpcCalls.length = 0
  await withJobContext({ data: many, error: null, status: 200 }, rpc)
  ok(`context: a long list goes in chunks of ${CONTEXT_CHUNK}`, rpcCalls.length === 3 && rpcCalls.every(c => c.length <= CONTEXT_CHUNK))
  const one = await withJobContext({ data: { seam_access_code: null }, error: null, status: 200 }, rpc, 'b')
  ok('context: one row without an id column, by the id passed', one.data.clients?.client_type === 'str' && one.data.clients?.phone === '555')
}
{
  const dead = async () => ({ data: null, error: { message: 'Network request failed' }, status: 0 })
  const res = await withJobContext({ data: [{ id: 'a' }], error: null, status: 200 }, dead)
  ok('context: no network fails the read the network way (the saved copy answers)', res.status === 0 && res.error && res.data === null)
  const refused = async () => ({ data: null, error: { code: 'PGRST202' }, status: 404 })
  const kept = await withJobContext({ data: [{ id: 'a' }], error: null, status: 200 }, refused)
  ok('context: any other failure keeps the rows, with no client', !kept.error && kept.data.length === 1 && kept.data[0].clients === null)
  let asked = false
  const failed = await withJobContext({ data: null, error: { message: 'x' }, status: 500 }, async () => { asked = true; return { data: [], error: null } })
  ok('context: a failed jobs read is passed through, unasked', failed.error && !asked)
}

const DAY = 'Address shows from the day before'
const job = (addr, client) => ({ client_addresses: addr, clients: client })
ok('place: the nickname first', placeLabel(job({ nickname: 'Casa', street: '1 Main' }, { full_name: 'Ann' }), false, DAY) === 'Casa')
ok('place: crew get the street, never the client', placeLabel(job({ street: '1 Main' }, { full_name: 'Ann' }), false, DAY) === '1 Main')
ok('place: the office gets the client', placeLabel(job({ street: '1 Main' }, { full_name: 'Ann' }), true, DAY) === 'Ann')
ok('place: a crew clean with no property says when it will show', placeLabel(job(null, null), false, DAY) === DAY)
ok('place: the office never sees that line', placeLabel(job(null, null), true, DAY) === '')

// ── 2–4. Source ─────────────────────────────────────────────────────────────
function files(dir) {
  return readdirSync(join(repo, dir)).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(join(repo, p)).isDirectory()) return f === '__tests__' ? [] : files(p)
    return /\.(ts|tsx)$/.test(f) ? [p] : []
  })
}
// Whole-line comments blanked (line numbers hold): they quote reads as examples.
const code = (p) => read(p).split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n')
const SRC = ['App.tsx', ...files('src')].map((file) => ({ file, text: code(file) }))
const lineOf = (text, i) => text.slice(0, i).split('\n').length

// Company-wide jobs reads that stay so, and why. Each must be office-only.
const OFFICE_ONLY = {
  'src/lib/teamReads.ts': 'Team today: office phones only (App.tsx shows the Team tab to the office)',
  'src/lib/officeEdit.ts': 'Edit time: the office fixing a clean, by id',
  // Removed by the RPC-adoption PR (open_board_jobs()): until then the board
  // still reads open cleans with their lockbox code.
  'src/screens/OpenJobsScreen.tsx': 'Open jobs board: moves to open_board_jobs() in the RPC-adoption PR',
}
const OWN = /job_assignments\.user_id|driver_user_id|\.eq\('id',|\.in\('id',|onlyMine\(/
const bad = []
for (const { file, text } of SRC) {
  for (const m of text.matchAll(/\.from\('jobs'\)/g)) {
    // The statement this read belongs to: back to the line it starts on, on
    // until its chain ends (a line that doesn't continue it).
    const start = text.lastIndexOf('\n', text.lastIndexOf('\n', m.index) - 1)
    const lines = text.slice(m.index).split('\n')
    let n = 1
    while (n < lines.length && n < 20 && /^\s*(\.|\)|,|\?|:)/.test(lines[n])) n++
    const stmt = text.slice(Math.max(0, start), m.index) + lines.slice(0, n).join('\n')
    const sel = /\.select\(([^)]*\)?[^)]*)\)/.exec(stmt)?.[0] ?? ''
    const usesShared = /\.select\((jobSelectFor\(|SCHEDULE_JOB_SELECT|HOME_\w+_SELECT|BASE_SELECT|JOB_FIELDS)/.test(stmt)
    const sensitive = /lockbox_code|clients[!(]/.test(stmt)
    if (/\.(update|insert|upsert|delete)\(/.test(lines.slice(0, n).join('\n')) && !/\.select\(/.test(lines.slice(0, 2).join('\n'))) continue
    if (usesShared && !/jobSelectFor\(/.test(stmt) && !OWN.test(stmt) && !OFFICE_ONLY[file]) {
      bad.push(`${file}:${lineOf(text, m.index)} reads a shared select without jobSelectFor()/onlyMine() or an own-rows filter`)
      continue
    }
    if (/jobSelectFor\(/.test(stmt) && !/onlyMine\(/.test(stmt)) {
      bad.push(`${file}:${lineOf(text, m.index)} uses jobSelectFor() without onlyMine(): crew would get every clean with an assignment`)
      continue
    }
    if (sensitive && !OWN.test(stmt) && !OFFICE_ONLY[file]) bad.push(`${file}:${lineOf(text, m.index)} reads ${sel.slice(0, 60)}… company-wide`)
  }
}
ok('no jobs read hands crew another clean\'s lockbox code or client', bad.length === 0, bad.join('; '))

const jobReads = read('src/lib/jobReads.ts')
const fnBody = (src, name) => { const i = src.indexOf(`export function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)) }
for (const name of ['dashTodayRead', 'dashStrandedRead', 'scheduleRead', 'scheduleJobById']) {
  const b = fnBody(jobReads, name)
  ok(`${name}: crew through jobSelectFor() + onlyMine(), client from crew_job_context`,
    b.includes('jobSelectFor(office,') && b.includes('onlyMine(') && b.includes('withJobContext(') && b.includes('const office = isOfficeRole(user.role)'))
}
ok('jobMetaRead: the client type from crew_job_context, not a clients embed', (() => {
  const i = jobReads.indexOf('export const jobMetaRead'); const b = jobReads.slice(i, jobReads.indexOf('\n})', i))
  return i > 0 && !/clients[!(]/.test(b) && b.includes('withJobContext(')
})())
const dash = read('src/screens/DashboardScreen.tsx')
ok('Home reads its day and "Needs closing" through the shared builders',
  dash.includes('cachedRead(dashTodayRead(user, now))') && dash.includes('cachedRead(dashStrandedRead(user, todayStart))') && !dash.includes('`dash:stranded:'))
ok('Schedule reads through scheduleRead()', read('src/screens/ScheduleScreen.tsx').includes('cachedRead(scheduleRead(user, start, end))'))
ok('a push tap and "Inspections to review" open a job through scheduleJobById()',
  /live: \(jobId\) => scheduleJobById\(user, jobId\)/.test(read('App.tsx')) && read('src/components/InspectionsToReviewCard.tsx').includes('await scheduleJobById(user, item.jobId)'))

// Unguarded embed reads. String literals are dropped first: PostgREST filter
// names ('client_addresses.address_id') are not reads.
const unguarded = []
for (const { file, text } of SRC) {
  const noStrings = text.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''")
  for (const m of noStrings.matchAll(/\b(client_addresses|clients)(\s+as\s+any\))?\.(?=[A-Za-z_])/g)) {
    unguarded.push(`${file}:${lineOf(noStrings, m.index)} ${m[0]}`)
  }
}
ok('no client_addresses./clients. read without ?.', unguarded.length === 0, unguarded.join('; '))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
