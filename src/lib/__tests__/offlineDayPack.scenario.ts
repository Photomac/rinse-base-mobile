// Offline day-pack scenario test. Run with: node scripts/test-offline-day-pack.mjs
//
// Exercises the REAL src/lib/offlinePrefetch.ts, jobReads.ts, dataCache.ts,
// timezone.ts, jobScope.ts, outbox.ts and supabase.ts/netFetch.ts on top of the
// REAL supabase-js 2.99.2 that ships in the app. The network is a mock
// Supabase server that answers PostgREST reads the way the real one does —
// filters, embeds, column lists, ordering — so a read window or a select that
// is wrong returns the wrong rows here too. Native modules are stubs
// (offlineAuth.mocks.ts). The clock is faked so a scenario can save the pack
// in the evening and cold-start the app the next morning.
//
// The failure this guards against (CKS Perfections, 2026-10-13): Home's copy
// saved at night held that day, so the next morning in a dead zone Home was
// EMPTY, and a stop never opened online had no door code or checklist.
//
// Each scenario runs in its own Node process, started by the runner with the
// scenario name as argv[2].

const h: any = ((globalThis as any).__harness = (globalThis as any).__harness ?? {})
const store: Map<string, string> = (h.store = h.store ?? new Map())
console.error = () => {}

// ── Clock ───────────────────────────────────────────────────────────────────
// Every `new Date()` / Date.now() in the app reads this. Timers stay real.
const RealDate = Date
let skewMs = 0
class FakeDate extends RealDate {
  constructor(...a: any[]) {
    if (a.length === 0) super(RealDate.now() + skewMs)
    else super(...(a as [string | number | Date]))
  }
  static now() { return RealDate.now() + skewMs }
}
;(globalThis as any).Date = FakeDate
const setClock = (iso: string) => { skewMs = RealDate.parse(iso) - RealDate.now() }

// The company's zone (CKS is in Sedona; Arizona keeps no DST). The runner also
// starts this process with TZ=America/Phoenix, so the phone agrees.
const TZ = 'America/Phoenix'
const D0 = '2026-10-13'   // the evening the office dispatches
const D1 = '2026-10-14'   // the next morning, at a stop with no signal
const D2 = '2026-10-15'
const EVENING = '2026-10-14T03:30:00.000Z'  // Oct 13, 8:30 PM in Sedona
const MORNING = '2026-10-14T14:00:00.000Z'  // Oct 14, 7:00 AM
const at = (iso: string) => new RealDate(iso).toISOString()

// ── Tokens ──────────────────────────────────────────────────────────────────
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const AUTH_USER = { id: 'auth-u1', aud: 'authenticated', role: 'authenticated', email: 'crew@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
const jwt = (expSec: number) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: AUTH_USER.id, exp: expSec, role: 'authenticated', aud: 'authenticated' })}.sig`
const makeSession = (expSec: number) => ({ access_token: jwt(expSec), refresh_token: 'rt-0', token_type: 'bearer', expires_in: 3600, expires_at: expSec, user: AUTH_USER })
const SESSION_KEY = 'sb-cbnbhwclbtowfbjylnph-auth-token'
const nowSec = () => Math.floor(Date.now() / 1000)
/** A sign-in made this evening: good for the usual hour. */
const seedSession = () => store.set(SESSION_KEY, JSON.stringify(makeSession(nowSec() + 3600)))

// ── The company's book ──────────────────────────────────────────────────────
const T = 't-cks'
const U = 'u-nichole'   // crew, daily time tracking (CKS)
const V = 'u-other'     // another cleaner
const O = 'u-owner'     // the owner, who also cleans
const NAMES: Record<string, string> = { [U]: 'Nichole', [V]: 'Ali', [O]: 'Catherine' }
const CREW = { id: U, tenant_id: T, role: 'cleaner', full_name: 'Nichole', _timeMode: 'daily' }
const OWNER = { id: O, tenant_id: T, role: 'owner', full_name: 'Catherine', _timeMode: 'per_job' }
/** Nichole at a company that tracks time per clean (the timer and Clock in). */
const PJ = { ...CREW, _timeMode: 'per_job' }

const ADDR: Record<string, any> = {
  A1: { id: 'A1', street: '1 Uptown Rd', nickname: 'Uptown', lockbox_code: '1111', arrival_instructions: null },
  // The dead-zone home: crew join the house WiFi there (CKS, 2026-10-19)
  A2: { id: 'A2', street: '20 Red Rock Ln', nickname: 'Red Rock Casita', lockbox_code: '4321', arrival_instructions: 'Side gate, gate code 1122. Key in the lockbox by the hose.',
        wifi_name: 'RedRockCasita-Guest', wifi_password: 'desert sky 22!' },
  A3: { id: 'A3', street: '3 Chapel Rd', nickname: 'Chapel View', lockbox_code: '7777', arrival_instructions: 'Front door keypad.' },
  A4: { id: 'A4', street: '4 Oak Creek Dr', nickname: 'Oak Creek', lockbox_code: '9999', arrival_instructions: 'Owner on site.' },
  A5: { id: 'A5', street: '5 Bell Rock Blvd', nickname: 'Bell Rock', lockbox_code: '5555', arrival_instructions: null },
}
const addressRow = (a: any) => ({
  wifi_name: null, wifi_password: null,
  ...a, tenant_id: T, city: 'Sedona', lat: 34.87, lng: -111.76,
  photo_url: `https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/public/job-photos/${a.id}.jpg`,
  bedrooms: 2, bathrooms: 2, sqft: 1400, beds: 3, sleeps: 6, crew_notes: 'Hot tub cover stays on.',
  laundry_bag_color: 'Blue bags', staging_photos: [{ url: 'https://example.com/stage.jpg' }],
  pet_friendly: false, pet_fee: 0, default_checkin_time: '16:00', trash_pickup_days: [2],
  checklist_execution_mode: null,
})

let jobNo = 100
function jobRow(id: string, start: string, status: string, crew: string[], addr: string, extra: any = {}) {
  const a = ADDR[addr]
  return {
    id, job_number: ++jobNo, tenant_id: T, status, address_id: addr, client_id: 'c-1',
    scheduled_start: at(start), scheduled_end: at(new RealDate(RealDate.parse(start) + 3 * 3600_000).toISOString()),
    is_turnover: true, route_order: null, window_minutes: null, job_type: 'clean', internal_notes: '',
    seam_access_code: null, laundry_done_onsite: false, pet_fee_applied: false, checkout_time: null, checkin_time: null, urgency: null,
    crew_note: null, crew_note_at_clock_in: false, started_at: null,
    clients: { full_name: 'Red Rock Rentals', phone: '555-0100', client_type: 'property_manager' },
    client_addresses: { id: a.id, street: a.street, city: 'Sedona', nickname: a.nickname, lockbox_code: a.lockbox_code, lat: 34.87, lng: -111.76, photo_url: addressRow(a).photo_url },
    job_assignments: crew.map(u => ({ user_id: u })),
    crew: crew.map((u, i) => ({ user_id: u, is_lead: i === 0, users: { full_name: NAMES[u] } })),
    property_reservations: { guest_count: 4, pet_count: 0 },
    ...extra,
  }
}

const JOBS = {
  done:   jobRow('J-done',   '2026-10-13T17:00:00Z', 'completed', [U], 'A1'),                      // today, finished
  late:   jobRow('J-late',   '2026-10-14T04:30:00Z', 'scheduled', [U], 'A1'),                      // today 9:30 PM
  red:    jobRow('J-red',    '2026-10-14T16:00:00Z', 'scheduled', [U], 'A2', { route_order: 1, crew_note: 'Guest left early — check the patio.' }), // tomorrow 9 AM
  chapel: jobRow('J-chapel', '2026-10-14T20:00:00Z', 'scheduled', [U, V], 'A3', { route_order: 2 }), // tomorrow 1 PM, a walkthrough clean
  oak:    jobRow('J-oak',    '2026-10-14T18:00:00Z', 'scheduled', [V, O], 'A4'),                   // tomorrow, not Nichole's
  off:    jobRow('J-off',    '2026-10-14T22:00:00Z', 'cancelled', [U], 'A2'),                      // tomorrow, called off
  night:  jobRow('J-night',  '2026-10-15T06:30:00Z', 'scheduled', [U], 'A5'),                      // tomorrow 11:30 PM — last minutes of the window
  after:  jobRow('J-after',  '2026-10-15T16:00:00Z', 'scheduled', [U], 'A5'),                      // the day after: outside
}

function seedServer() {
  const jobs = Object.values(JOBS)
  server.tables = {
    jobs,
    client_addresses: Object.values(ADDR).map(addressRow),
    tenants: [{ id: T, video_walkthroughs_enabled: false, default_checkin_time: '16:00', default_checklist_seed: 'generated', checklist_execution_mode: 'detailed', crew_prep_linens: true, check_first_required: true, enforce_photo_requirements: true }],
    job_assignments: jobs.flatMap(j => j.crew.map((c: any) => ({ job_id: j.id, user_id: c.user_id, is_lead: c.is_lead, users: { id: c.user_id, full_name: NAMES[c.user_id] } }))),
    address_checklist_templates: [
      { id: 'tp1', address_id: 'A2', room: 'Kitchen', title: 'Wipe counters', sort_order: 1, requires_photo: false },
      { id: 'tp2', address_id: 'A2', room: 'Bath', title: 'Scrub tub', sort_order: 2, requires_photo: true },
    ],
    job_checklist_items: [
      { id: 'ci1', job_id: 'J-red', room: 'Kitchen', task: 'Wipe counters', sort_order: 1, completed: false, photo_required: false, room_id: null, item_kind: 'task', level: 'guidance', result: null, issue_note: null },
      { id: 'ci2', job_id: 'J-red', room: 'Bath', task: 'Scrub tub', sort_order: 2, completed: false, photo_required: true, room_id: null, item_kind: 'task', level: 'guidance', result: null, issue_note: null },
      { id: 'ci3', job_id: 'J-red', room: 'Bedroom', task: 'Make beds', sort_order: 3, completed: false, photo_required: false, room_id: null, item_kind: 'task', level: 'guidance', result: null, issue_note: null },
      { id: 'wt1', job_id: 'J-chapel', room: 'Living', task: 'Windows streak-free', sort_order: 20001, completed: false, photo_required: false, room_id: null, item_kind: 'verify', level: 'guidance', result: null, issue_note: null, follow_up: null, info_key: null },
      { id: 'wt2', job_id: 'J-chapel', room: 'Patio', task: 'Grill clean', sort_order: 20002, completed: false, photo_required: true, room_id: null, item_kind: 'verify', level: 'guidance', result: null, issue_note: null, follow_up: null, info_key: null },
      { id: 'ci9', job_id: 'J-oak', room: 'Kitchen', task: 'Oak task', sort_order: 1, completed: false, photo_required: false, room_id: null, item_kind: 'task', level: 'guidance', result: null, issue_note: null },
    ],
    property_reservations: [
      { id: 'r1', address_id: 'A2', platform: 'airbnb', guest_name: 'Rivera', calendar_id: 'cal-1', checkin_date: D1, checkout_date: '2026-10-17', checkin_time: '16:00', status: 'confirmed' },
      { id: 'r9', address_id: 'A4', platform: 'vrbo', guest_name: 'Kim', calendar_id: 'cal-4', checkin_date: D1, checkout_date: '2026-10-16', checkin_time: null, status: 'confirmed' },
    ],
    property_rooms: [
      { id: 'pr1', address_id: 'A2', room_type: 'kitchen', instance_no: 1, name: 'Kitchen', sort_order: 1, execution_mode: null, archived_at: null },
    ],
    property_photo_requirements: [
      { id: 'rq1', address_id: 'A2', room_id: 'pr1', required: true, area_name: 'Kitchen wide', sort_order: 1, created_at: at('2026-09-01T00:00:00Z') },
    ],
    address_inventory: [
      { id: 'inv-towel', address_id: 'A2', item_name: 'Bath towel', category: 'Linens', par_level: 4, unit: 'each', room_id: null, sort_order: 1 },
      { id: 'inv-tp', address_id: 'A2', item_name: 'Toilet paper', category: 'Bathroom', par_level: 6, unit: 'roll', room_id: null, sort_order: 2 },
    ],
    job_inventory_log: [
      { id: 'lg1', job_id: 'J-prev', inventory_id: 'inv-tp', item_name: 'Toilet paper', qty_used: 4, qty_remaining: 1, needs_restock: true, notes: null, incident_id: null, restocked_at: null, client_notified_at: null, created_at: at('2026-10-10T00:00:00Z'), jobs: { address_id: 'A2' } },
    ],
    turnover_linen_extras: [{ job_id: 'J-red', inventory_id: 'inv-towel', extra_qty: 2 }],
    // Check first at Red Rock Casita (rinse-base-app 20261015130534): two lines,
    // one archived, and the plants already ticked on J-red.
    property_check_first_lines: [
      { id: 'cf1', tenant_id: T, address_id: 'A2', body: 'Water all the plants', photo_required: false, sort_order: 1, created_at: at('2026-10-01T00:00:00Z'), updated_at: at('2026-10-01T00:00:00Z'), archived_at: null },
      { id: 'cf2', tenant_id: T, address_id: 'A2', body: 'Spa photo', photo_required: true, sort_order: 2, created_at: at('2026-10-01T00:00:00Z'), updated_at: at('2026-10-01T00:00:00Z'), archived_at: null },
      { id: 'cf0', tenant_id: T, address_id: 'A2', body: 'Old line', photo_required: false, sort_order: 0, created_at: at('2026-09-01T00:00:00Z'), updated_at: at('2026-09-02T00:00:00Z'), archived_at: at('2026-09-02T00:00:00Z') },
    ],
    job_check_first_ticks: [
      { id: 'tk1', tenant_id: T, job_id: 'J-red', line_id: 'cf1', user_id: U, line_text: 'Water all the plants', ticked_at: at('2026-10-13T20:00:00Z'), created_at: at('2026-10-13T20:00:00Z'), users: { full_name: 'Nichole' } },
    ],
    job_time_entries: [], job_room_signoffs: [], job_photos: [], job_crew_note_acks: [],
  }
}

// ── Mock Supabase server ────────────────────────────────────────────────────
const server = {
  /** hang: requests go out and nothing ever comes back (one bar, no data),
   *  until the app gives up on them. */
  mode: 'online' as 'online' | 'offline' | 'hang',
  /** Tables whose reads hang while the rest answer (a trickle). */
  hang: new Set<string>(),
  /** Extra ms before a table's reads answer. */
  slow: {} as Record<string, number>,
  tables: {} as Record<string, any[]>,
  rest: [] as { method: string; table: string; params: URLSearchParams }[],
  /** ms each answer takes, so concurrency is observable. */
  delayMs: 5,
  inflight: 0,
  maxInflight: 0,
  /** Go offline after this many REST answers (signal lost mid-run). */
  failAfter: null as number | null,
  other: [] as string[],
  /** Every REST request sent, answered or not, and when (performance.now()). */
  asked: [] as { table: string; params: URLSearchParams; at: number }[],
  /** RPC answers by function name: rows, or { status, body } for a refusal.
   *  A function not listed answers 404, as an older database would. */
  rpc: {} as Record<string, (args: any) => any>,
}

function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** PostgREST's column list: plain columns, `*`, and embeds (alias:table!hint(cols)). */
function project(row: any, select: string): any {
  if (row == null) return null
  if (Array.isArray(row)) return row.map(r => project(r, select))
  const out: any = {}
  for (const item of splitTop(select)) {
    if (item === '*') {
      for (const [k, v] of Object.entries(row)) if (v === null || typeof v !== 'object') out[k] = v
      continue
    }
    const m = /^(?:(\w+):)?(\w+)(?:!\w+)?(?:\(([\s\S]*)\))?$/.exec(item)
    if (!m) throw new Error(`mock: can't read select item ${item}`)
    const [, alias, name, inner] = m
    if (inner !== undefined) {
      const src = alias && alias in row ? row[alias] : row[name]
      out[alias || name] = project(src ?? null, inner)
    } else {
      if (!(name in row)) throw new Error(`mock: column ${name} is not on the row`)
      out[name] = row[name]
    }
  }
  return out
}

function test(v: any, op: string, arg: string): boolean {
  switch (op) {
    case 'eq': return String(v) === arg
    case 'neq': return String(v) !== arg
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (v == null) return false
      const c = typeof v === 'number' ? v - Number(arg) : String(v) < arg ? -1 : String(v) > arg ? 1 : 0
      return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0
    }
    case 'in': return arg.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).includes(String(v))
    case 'is': return arg === 'null' ? v == null : String(v) === arg
  }
  throw new Error(`mock: filter op ${op}`)
}

function keep(row: any, key: string, raw: string): boolean {
  let rest = raw, neg = false
  if (rest.startsWith('not.')) { neg = true; rest = rest.slice(4) }
  const dot = rest.indexOf('.')
  const op = rest.slice(0, dot), arg = rest.slice(dot + 1)
  const path = key.split('.')
  let hit: boolean
  if (path.length === 2) {
    // A filter on an embed: the parent row stays only if the embed matches
    // (the !inner reads this app makes).
    const emb = row[path[0]]
    const list = Array.isArray(emb) ? emb : emb ? [emb] : []
    hit = list.some((e: any) => test(e[path[1]], op, arg))
  } else hit = test(row[key], op, arg)
  return neg ? !hit : hit
}

function order(rows: any[], spec: string): any[] {
  const keys = spec.split(',').map(s => { const [col, dir, nulls] = s.split('.'); return { col, desc: dir === 'desc', nullsFirst: nulls === 'nullsfirst' } })
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const x = a[k.col], y = b[k.col]
      if (x == null || y == null) { if (x == null && y == null) continue; return (x == null) === k.nullsFirst ? -1 : 1 }
      const c = typeof x === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0
      if (c) return k.desc ? -c : c
    }
    return 0
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** No answer, ever: only the app's own deadline (netFetch) ends it. */
const noAnswer = (init: any) => new Promise<Response>((_, reject) => {
  const signal: AbortSignal | undefined = init?.signal
  const abort = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort)
})
;(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (server.mode === 'offline') throw new TypeError('Network request failed')
  if (url.pathname.startsWith('/rest/v1/')) server.asked.push({ table: url.pathname.slice('/rest/v1/'.length), params: url.searchParams, at: performance.now() })
  if (server.mode === 'hang') return noAnswer(init)
  if (server.hang.has(url.pathname.slice('/rest/v1/'.length))) return noAnswer(init)
  const date = new Date().toUTCString()
  const json = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date } })
  const path = url.pathname
  if (path === '/auth/v1/health') return json(200, { name: 'GoTrue' })
  if (path === '/auth/v1/token') return json(200, makeSession(nowSec() + 3600))
  if (!path.startsWith('/rest/v1/')) { server.other.push(path); return json(404, { message: 'not found' }) }
  const method = String(init.method || 'GET').toUpperCase()
  const table = path.slice('/rest/v1/'.length)
  server.rest.push({ method, table, params: url.searchParams })
  server.inflight++
  server.maxInflight = Math.max(server.maxInflight, server.inflight)
  try {
    await sleep(server.delayMs + (server.slow[table] ?? 0))
    if (server.failAfter != null && server.rest.length > server.failAfter) {
      server.mode = 'offline'
      throw new TypeError('Network request failed')
    }
    if (table.startsWith('rpc/')) {
      const fn = server.rpc[table.slice(4)]
      if (!fn) return json(404, { code: 'PGRST202', message: `function ${table.slice(4)} not found` })
      // A read-only function is called with GET (args in the query), as supabase-js does for { get: true }.
      const out = fn(method === 'GET' ? Object.fromEntries(url.searchParams) : JSON.parse(init.body || '{}'))
      return out && typeof out === 'object' && 'status' in out ? json(out.status, out.body) : json(200, out)
    }
    if (method !== 'GET') { write(method, table, url.searchParams, init); return new Response('', { status: 201, headers: { date } }) }
    let rows = (server.tables[table] ?? []).slice()
    for (const [k, v] of url.searchParams) {
      if (k === 'select' || k === 'order' || k === 'limit' || k === 'offset') continue
      rows = rows.filter(r => keep(r, k, v))
    }
    const ord = url.searchParams.get('order')
    if (ord) rows = order(rows, ord)
    const lim = url.searchParams.get('limit')
    if (lim) rows = rows.slice(0, Number(lim))
    return json(200, project(rows, url.searchParams.get('select') || '*'))
  } finally { server.inflight-- }
}

/** Writes land in the tables, as PostgREST would apply them: an upsert on its
 *  conflict columns (merge, or leave the stored row with ignore-duplicates),
 *  an update or delete on its filters. */
function write(method: string, table: string, params: URLSearchParams, init: any) {
  const rows = (server.tables[table] = server.tables[table] ?? [])
  const filtered = () => rows.filter(r => [...params].every(([k, v]) => ['select', 'on_conflict', 'columns'].includes(k) || keep(r, k, v)))
  const body = init.body ? JSON.parse(init.body) : null
  if (method === 'POST') {
    const keys = (params.get('on_conflict') || 'id').split(',')
    const ignore = /ignore-duplicates/.test(String(init.headers?.Prefer ?? init.headers?.prefer ?? (typeof init.headers?.get === 'function' ? init.headers.get('prefer') : '')))
    for (const v of Array.isArray(body) ? body : [body]) {
      const i = rows.findIndex(r => keys.every(k => r[k] === v[k]))
      if (i < 0) rows.push({ ...v })
      else if (!ignore) rows[i] = { ...rows[i], ...v }
    }
  } else if (method === 'PATCH') {
    for (const r of filtered()) Object.assign(r, body)
  } else if (method === 'DELETE') {
    const gone = new Set(filtered())
    server.tables[table] = rows.filter(r => !gone.has(r))
  }
}

// ── Test plumbing ───────────────────────────────────────────────────────────
let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!cond) failures++
}
const cached = (key: string) => store.has(`dataCache:${key}`)
const cachedVal = (key: string) => JSON.parse(store.get(`dataCache:${key}`) ?? 'null')
const ids = (rows: any[]) => rows.map((r: any) => r.id).join(',')
/** Home's day read, as DashboardScreen sends it. */
const isDayRead = (r: { table: string; params: URLSearchParams }) =>
  r.table === 'jobs' && (r.params.get('select') || '').includes('job_number')

function load() {
  const c = require(process.env.CLIENT_BUNDLE as string)
  c.setCurrentTz(TZ)  // App.tsx sets the company zone from the profile on launch
  return c
}
/** Kill the app and open it again: fresh module state, same phone storage. */
function relaunch() {
  delete require.cache[require.resolve(process.env.CLIENT_BUNDLE as string)]
  return load()
}

// ── Scenarios ───────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {
  // CKS, 2026-10-19: "the crew and I see 'this is what got missed last time,
  // here's the photo'". The lines missed at the last inspection of a stop's
  // home ride along with the day's stops, and so does their photo, as a file:
  // the one image the pack saves. A file no stop needs any more goes.
  async carriedLinesRideAlong() {
    setClock(EVENING); seedServer(); seedSession()
    const PHOTO = 'https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/public/job-photos/t-cks/J-insp/sink.jpg'
    const line = { room: 'Kitchen', task: 'Sink scrubbed', sort_order: 20005, issue_note: 'Dirty sponge', photo_urls: [PHOTO],
      missed_at: '2026-10-12T23:01:11Z', missed_job_id: 'J-insp', missed_item_id: 'i-1', times_missed: 1,
      inspector_name: 'Catherine', this_item_id: null, this_result: null }
    let carried: Record<string, any[]> = { 'J-red': [line] }
    server.rpc.walkthrough_carried_lines = (args: any) => carried[args?.p_job_id] ?? []
    h.downloads = []
    let c = load()
    ok('evening: the pack saves', (await c.prefetchDays(CREW)).status === 'saved')
    ok('the missed lines are saved with the stop', cachedVal('wtcarry:J-red')?.[0]?.task === 'Sink scrubbed')
    ok('…for every one of her stops, none at all for a stop not hers', cached('wtcarry:J-chapel') && !cached('wtcarry:J-oak'))
    ok('the photo comes down once, as a file', h.downloads.filter((u: string) => u === PHOTO).length === 1, JSON.stringify(h.downloads))

    setClock(MORNING)
    server.mode = 'offline'
    c = relaunch()
    let shown: any = null
    await c.loadCarried(JOBS.red, (v: any) => { shown = v })
    ok('next morning with no signal: the card shows her words', shown?.lines?.[0]?.issue_note === 'Dirty sponge')
    ok('…and the photo from the file on the phone', typeof shown?.files?.[PHOTO] === 'string' && shown.files[PHOTO].startsWith('file:///harness-cache/carried-photos/'),
      JSON.stringify(shown?.files))

    // An inspection marks it OK: the next pack has nothing for the stop, and the file goes.
    server.mode = 'online'
    carried = {}
    setClock('2026-10-15T03:30:00.000Z')
    c = relaunch()
    ok('next evening: the pack saves', (await c.prefetchDays(CREW, { force: true })).status === 'saved')
    ok('the file no stop needs is deleted', ![...h.files.keys()].some((k: string) => k.startsWith('file:///harness-cache/carried-photos/')),
      [...h.files.keys()].join(','))
  },

  // A stop's photo that fails to come down stops the photos, never the pack.
  async carriedPhotoFailureNeverFailsThePack() {
    setClock(EVENING); seedServer(); seedSession()
    const P1 = 'https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/public/job-photos/t-cks/J-insp/a.jpg'
    const P2 = 'https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/public/job-photos/t-cks/J-insp/b.jpg'
    const row = (task: string, url: string, so: number) => ({ room: 'Kitchen', task, sort_order: so, issue_note: null, photo_urls: [url],
      missed_at: '2026-10-12T23:01:11Z', missed_job_id: 'J-insp', missed_item_id: `i-${task}`, times_missed: 1,
      inspector_name: null, this_item_id: null, this_result: null })
    server.rpc.walkthrough_carried_lines = (args: any) => (args?.p_job_id === 'J-red' ? [row('a', P1, 1), row('b', P2, 2)] : [])
    h.downloads = []
    h.download = async () => 0   // the signal drops: no answer at all
    const c = load()
    const res = await c.prefetchDays(CREW)
    ok('the pack still saves', res.status === 'saved', res.status)
    ok('the first failure stops the photos (one bar must not queue a dozen)', h.downloads.length === 1, JSON.stringify(h.downloads))
    h.download = undefined
  },


  // The CKS morning: the office dispatches tonight, the phone is on home Wi-Fi
  // with the app open, and tomorrow the first stop has no signal at all.
  async tomorrowFromTheNightBefore() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    ok('evening: the company day is Oct 13, tomorrow Oct 14', c.todayKey() === D0 && c.tomorrowKey() === D1, `${c.todayKey()} / ${c.tomorrowKey()}`)

    const res = await c.prefetchDays(CREW)
    ok('the pack saves', res.status === 'saved', res.status)
    ok('it counts her own open stops per day: 1 tonight, 3 tomorrow',
      res.pack?.stops?.[D0] === 1 && res.pack?.stops?.[D1] === 3, JSON.stringify(res.pack?.stops))
    ok('Home\'s day read runs to the END of tomorrow (11:30 PM stop in, the day after out)',
      cached(`dash:today:${U}`) && ids(cachedVal(`dash:today:${U}`)).includes('J-night') && !ids(cachedVal(`dash:today:${U}`)).includes('J-after'),
      ids(cachedVal(`dash:today:${U}`)))
    ok('never more than 4 reads in flight', server.maxInflight <= 4, String(server.maxInflight))
    ok('no image or file downloads', server.other.every(p => !p.startsWith('/storage/')), server.other.join(' '))
    ok('nothing for a stop that is not hers', !cached('chkrows:J-oak') && !cached('propmeta:A4') && !cached('jobmeta:J-oak'))
    ok('nothing for the day after tomorrow', !cached('chkrows:J-after') && !cached('jobmeta:J-after'))
    ok('nothing for a cancelled or finished stop', !cached('chkrows:J-off') && !cached('jobmeta:J-done'))
    ok('daily time tracking: no per-job crew clock read (the screen makes none)', !cached('crewclock:J-red'))
    ok('the walkthrough is saved only for the walkthrough clean',
      cached('wtlines:J-chapel') && cached('wttrash:A3') && !cached('wtlines:J-red'))
    ok('tomorrow\'s prep card is saved under tomorrow', cached(`prep:addr:${U}:${D1}`) && cached(`prep:linen:${U}:${D1}`))

    // ── Next morning. No signal. The app was killed overnight. ──
    setClock(MORNING)
    server.mode = 'offline'
    server.rest = []
    c = relaunch()
    ok('morning: the company day is Oct 14', c.todayKey() === D1, c.todayKey())

    // Home (DashboardScreen.load): the day read, then today's rows only.
    const t0 = Date.now()
    const home = await c.cachedRead(c.reads.dashTodayRead(CREW, new Date()))
    ok('Home answers from the phone, fast', home.fromCache === true && Date.now() - t0 < 5000, `${Date.now() - t0} ms`)
    const day = c.dayView(c.reads.homeDayRows(home.data, CREW, c.todayKey()), U, 'everyone')
    ok('Home shows this morning\'s stops — not empty, not yesterday\'s, not someone else\'s',
      ids(day.jobs) === 'J-red,J-chapel,J-night', ids(day.jobs))
    ok('the cancelled stop shows as cancelled', ids(day.cancelled) === 'J-off', ids(day.cancelled))
    const pack = await c.loadDayPack(U)
    ok('"Saved for offline" counts the 3 stops ahead', c.stopsAhead(pack, c.todayKey()) === 3, String(c.stopsAhead(pack, c.todayKey())))

    // The stop's screen (JobDetailScreen), opened from the Home row. Every
    // cached read it makes on open is written out here, NOT taken from
    // jobPackReads(), so a read the pack forgets to save fails below.
    const job = day.jobs.find((j: any) => j.id === 'J-red')
    const R = c.reads
    const addrId = R.jobAddressId(job)
    const na = R.nextArrivalReads(job, job.client_addresses.id, T)
    const screen: Record<string, any> = {
      tenvideo: R.tenantVideoRead(T),
      tmpl: R.checklistTemplateRead(addrId), chkrows: R.checklistRowsRead(job.id), tenseed: R.tenantSeedRead(T),
      rooms: R.roomsRead(addrId), signoffs: R.roomSignoffsRead(job.id), addrmode: R.addressModeRead(addrId),
      tenmode: R.tenantModeRead(T), preq: R.photoRequirementsRead(addrId), pshot: R.requirementShotsRead(job.id),
      photos: R.itemPhotosRead(job.id),
      time: R.timeEntriesRead(job.id, U, false),
      jobmeta: R.jobMetaRead(job.id), crew: R.jobCrewRead(job.id), propmeta: R.propMetaRead(addrId),
      crewnote: R.crewNoteRead(job.id), crewnoteack: R.crewNoteAckRead(job.id, U),
      nextarr: na.stays, nextarrAddr: na.property, nextarrTen: na.company,
      route: R.routeStopRead(job, CREW),
      // Its Supplies screen (JobInventoryScreen)
      invItems: R.inventoryItemsRead(addrId), invLog: R.inventoryLogRead(job.id),
      invRooms: R.inventoryRoomsRead(addrId), invExtras: R.linenExtrasRead(job.id),
      // Its Check first card and the local check before Complete
      cften: R.checkFirstTenantRead(T), cflines: R.checkFirstLinesRead(addrId),
      cfticks: R.checkFirstTicksRead(job.id), cfphotos: R.checkFirstPhotosRead(job.id), cfstart: R.checkFirstStartRead(job.id),
    }
    const got: Record<string, any> = {}
    const missing: string[] = []
    for (const [name, r] of Object.entries(screen)) {
      got[name] = await c.cachedRead(r)
      if (!got[name].fromCache) missing.push(`${name} (${r.key})`)
    }
    ok('every read the stop\'s screen makes comes back from the phone', missing.length === 0, missing.join(', ') || `${Object.keys(screen).length} reads`)
    ok('the door code', got.propmeta.data?.lockbox_code === '4321', String(got.propmeta.data?.lockbox_code))
    ok('the WiFi, name and password exactly as stored', got.propmeta.data?.wifi_name === 'RedRockCasita-Guest' && got.propmeta.data?.wifi_password === 'desert sky 22!',
      `${got.propmeta.data?.wifi_name} / ${got.propmeta.data?.wifi_password}`)
    ok('the arrival instructions', /gate code 1122/.test(got.propmeta.data?.arrival_instructions || ''), String(got.propmeta.data?.arrival_instructions))
    ok('the checklist, in room order', (got.chkrows.data || []).map((r: any) => r.task).join('|') === 'Scrub tub|Make beds|Wipe counters',
      (got.chkrows.data || []).map((r: any) => r.task).join('|'))
    ok('the checklist template behind it', (got.tmpl.data || []).length === 2)
    ok('the office\'s note', got.crewnote.data?.crew_note === 'Guest left early — check the patio.')
    ok('who is on it', (got.crew.data || []).some((a: any) => a.users?.full_name === 'Nichole'))
    ok('the next arrival', (got.nextarr.data || []).some((r: any) => r.guest_name === 'Rivera'))
    ok('"Stop 1 of 2"', (got.route.data || []).length === 2, ids(got.route.data || []))
    ok('supplies, with the office\'s extra linen', (got.invItems.data || []).length === 2 && got.invExtras.data?.[0]?.extra_qty === 2)
    ok('Check first: the lines in the office\'s order, not the archived one, the tick and who made it, the company\'s switch',
      (got.cflines.data || []).map((l: any) => l.body).join('|') === 'Water all the plants|Spa photo' &&
      got.cfticks.data?.[0]?.line_id === 'cf1' && got.cfticks.data?.[0]?.users?.full_name === 'Nichole' &&
      got.cften.data?.check_first_required === true && got.cfstart.data?.started_at === null,
      (got.cflines.data || []).map((l: any) => l.body).join('|'))
    ok('Check first: a clean at a property with no lines saves no ticks, photos or start',
      cached('cflines:A3') && !cached('cfticks:J-chapel') && !cached('cfphotos:J-chapel') && !cached('cfstart:J-chapel'))

    // The walkthrough clean's walkthrough (WalkthroughChecklist).
    const chapel = day.jobs.find((j: any) => j.id === 'J-chapel')
    const wt = await c.cachedRead(R.walkthroughLinesRead(chapel.id))
    ok('the walkthrough clean: its lines', wt.fromCache && (wt.data || []).length === 2, String((wt.data || []).length))

    // "Get ready for today" (PrepCard), over Home's day.
    const prep = R.prepReads(CREW, R.prepJobs(day.jobs), c.todayKey())
    const [pa, pl, pr, pc] = [await c.cachedRead(prep.addresses), await c.cachedRead(prep.linen), await c.cachedRead(prep.stays), await c.cachedRead(prep.checkFirst)]
    ok('the prep card: door codes, linens, arrivals',
      pa.fromCache && (pa.data || []).some((a: any) => a.lockbox_code === '4321') && pl.fromCache && (pl.data || []).length === 1 && pr.fromCache,
      `addr ${pa.fromCache}/${(pa.data || []).length} linen ${pl.fromCache}/${(pl.data || []).length} stays ${pr.fromCache}`)
    ok('the prep card: today\'s Check first lines', pc.fromCache && (pc.data || []).map((l: any) => l.body).sort().join('|') === 'Spa photo|Water all the plants',
      `${pc.fromCache}/${(pc.data || []).length}`)
  },

  // Live, Home still shows ONLY today, though the read now carries tomorrow.
  async homeShowsOnlyToday() {
    setClock(EVENING); seedServer(); seedSession()
    const c = load()
    const live = await c.cachedRead(c.reads.dashTodayRead(CREW, new Date()))
    ok('live read', live.fromCache === false && !live.error)
    ok('it carries tomorrow', ids(live.data).includes('J-red'))
    const day = c.dayView(c.reads.homeDayRows(live.data, CREW, c.todayKey()), U, 'everyone')
    ok('Home: today only', ids(day.jobs) === 'J-done,J-late', ids(day.jobs))
    ok('Done / Remaining count today only', day.done === 1 && day.remaining === 1, `${day.done}/${day.remaining}`)
    const office = c.dayView(c.reads.homeDayRows(live.data, OWNER, c.todayKey()), O, 'everyone')
    ok('the office\'s Everyone: today only', ids(office.jobs) === 'J-done,J-late', ids(office.jobs))
  },

  // The owner who also cleans: details for her own stops, never the company's.
  async officeGetsOwnStopsOnly() {
    setClock(EVENING); seedServer(); seedSession()
    const c = load()
    const res = await c.prefetchDays(OWNER)
    ok('saved', res.status === 'saved', res.status)
    ok('her own stop is saved (crew clock too: per-job tracking)', cached('chkrows:J-oak') && cached('propmeta:A4') && cached('crewclock:J-oak'))
    ok('the crew\'s stops are not', !cached('chkrows:J-red') && !cached('propmeta:A2') && !cached('chkrows:J-chapel'))
    ok('stops counted: hers only', res.pack?.stops?.[D1] === 1, JSON.stringify(res.pack?.stops))
    const addrIds = (k: string) => (cachedVal(k) || []).map((a: any) => a.id).sort().join(',')
    ok('her prep card on Everyone covers the day Home shows her', addrIds(`prep:addr:${O}:${D1}`) === 'A2,A3,A4,A5', addrIds(`prep:addr:${O}:${D1}`))
    store.set(`jobScope:${O}`, 'mine')
    await c.prefetchDays(OWNER, { force: true })
    ok('...and on Mine, only hers', addrIds(`prep:addr:${O}:${D1}`) === 'A4', addrIds(`prep:addr:${O}:${D1}`))
  },

  // One bar, then nothing: the run stops instead of timing out a hundred reads.
  async stopsAtFirstNetworkFailure() {
    setClock(EVENING); seedServer(); seedSession()
    const c = load()
    server.failAfter = 6
    const res = await c.prefetchDays(CREW)
    ok('reports offline', res.status === 'offline', res.status)
    ok('stops starting reads at the first failure', server.rest.length <= 6 + 4, `${server.rest.length} requests`)
    ok('no "saved" claim', (await c.loadDayPack(U)) === null)
    server.failAfter = null; server.mode = 'online'
    const again = await c.prefetchDays(CREW)
    ok('signal back: the next trigger saves (a failed run does not start the 10 minutes)', again.status === 'saved', again.status)
  },

  // Overlapping triggers share one run; a quiet trigger waits out 10 minutes;
  // an assignment push does not.
  async joinsAndThrottles() {
    setClock(EVENING); seedServer(); seedSession()
    const c = load()
    const dayReads = () => server.rest.filter(isDayRead).length
    const a = c.prefetchDays(CREW)
    const b = c.prefetchDays(CREW)
    ok('two triggers at once: one run', a === b)
    await a
    ok('one day read', dayReads() === 1, String(dayReads()))
    const n = server.rest.length
    const t = await c.prefetchDays(CREW)
    ok('again within 10 minutes: skipped, nothing sent', t.status === 'throttled' && server.rest.length === n, t.status)
    const p = c.prefetchDays(CREW, { force: true })
    const q = c.prefetchDays(CREW, { force: true })
    await p; await q
    ok('forced (a push): runs, and a push during it runs once more after', dayReads() === 3, String(dayReads()))
    setClock(new RealDate(RealDate.parse(EVENING) + 11 * 60_000).toISOString())
    const later = await c.prefetchDays(CREW)
    ok('11 minutes later: runs', later.status === 'saved', later.status)
  },

  // Signing out mid-run must not leave the account's rows on the phone.
  async signOutMidRunWritesNothing() {
    setClock(EVENING); seedServer(); seedSession()
    const c = load()
    server.delayMs = 30
    const p = c.prefetchDays(CREW)
    await sleep(45)
    await c.clearDataCache()
    await p
    const left = Array.from(store.keys()).filter(k => k.startsWith('dataCache:'))
    ok('nothing cached after sign-out', left.length === 0, left.join(' '))
  },

  // The outbox says when queued writes have synced (a pack trigger).
  async outboxDrainedSignal() {
    setClock(EVENING); seedServer(); seedSession()
    const c = load()
    let told = 0
    c.onOutboxDrained(() => { told++ })
    server.mode = 'offline'
    const w = await c.writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: { id: 'te-1', user_id: U, entry_type: 'shift', clocked_in_at: new Date().toISOString() } })
    ok('offline Start my day queues', w.queued === true)
    await c.flushOutbox()
    ok('a flush that sends nothing says nothing', told === 0)
    server.mode = 'online'
    await c.flushOutbox()
    ok('signal back: the queued write lands and the outbox says so once', told === 1, String(told))
    await c.flushOutbox()
    ok('an empty flush says nothing', told === 1, String(told))
  },

  // A saved run also drops stops nobody will need offline (lib/cachePrune):
  // a week gone and done. Today's, tomorrow's and an old clean still open stay.
  async packPrunesStopsNobodyNeeds() {
    seedServer(); seedSession()
    let c = load()
    // Opened on Oct 1: a finished stop at its own property, and one left open.
    setClock('2026-10-01T16:00:00.000Z')
    const gone = jobRow('J-gone', '2026-10-01T16:00:00Z', 'completed', [U], 'A4')
    const stuck = jobRow('J-stuck', '2026-10-01T18:00:00Z', 'in_progress', [U], 'A5')
    await c.noteCachedJobs([gone, stuck])
    const stopKeys = (j: string) => [`chkrows:${j}`, `jobmeta:${j}`, `crew:${j}`, `time:${j}:${U}`, `nextarr:${j}`, `inv:log:${j}`]
    for (const k of [...stopKeys('J-gone'), ...stopKeys('J-stuck'), 'propmeta:A4', 'tmpl:A4', 'propmeta:A5']) {
      store.set(`dataCache:${k}`, '"saved Oct 1"')
    }
    setClock(EVENING)
    c = relaunch()
    // Home's last load saved Needs closing: the Oct 1 clean is still open.
    store.set(`dataCache:dash:stranded:${U}`, JSON.stringify([{ id: 'J-stuck', status: 'in_progress', scheduled_start: stuck.scheduled_start, client_addresses: { id: 'A5' }, job_assignments: [{ user_id: U }] }]))
    const res = await c.prefetchDays(CREW)
    ok('saved', res.status === 'saved', res.status)
    ok('the finished stop from Oct 1 is gone, with its property', stopKeys('J-gone').every(k => !cached(k)) && !cached('propmeta:A4') && !cached('tmpl:A4'),
      [...stopKeys('J-gone'), 'propmeta:A4'].filter(cached).join(','))
    ok('the Oct 1 clean still open stays, with its property', stopKeys('J-stuck').every(cached) && cached('propmeta:A5'))
    ok('tonight\'s and tomorrow\'s stops stay', cached('chkrows:J-red') && cached('propmeta:A2') && cached('chkrows:J-chapel') && cached('jobmeta:J-late'))
    ok('Home\'s day and the pack line stay', cached(`dash:today:${U}`) && cached(`daypack:${U}`))
  },

  // CKS #1612, 2026-10-15: one bar, no data, a sign-in renewed minutes before.
  // Requests go out and nothing comes back. The card used to read in three
  // rounds, each waiting out the read deadline: "0/20" over a spinner for 45 s
  // and more, on every open, with the whole list saved on the phone.
  async checklistOnAHangingLink() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    ok('evening: the pack saves', (await c.prefetchDays(CREW)).status === 'saved')

    setClock(MORNING)
    seedSession()  // renewed on the road a few minutes ago: requests really go out
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const o = open(c, JOBS.red, 'A2')
    const doneAt = await o.done
    ok('the spinner gives way within the card\'s wait, not after a read deadline (let alone three)',
      o.offAt() != null && o.offAt()! < CARD_WAIT + 400, `${fmt(o.offAt())} (deadline ${READ_DEADLINE} ms)`)
    const v = o.log.shows[0]?.v
    ok('...showing the saved list: the job\'s own rows, in room order',
      (v?.items || []).map((i: any) => i.label).join('|') === 'Bath — Scrub tub|Bedroom — Make beds|Kitchen — Wipe counters',
      (v?.items || []).map((i: any) => i.label).join('|'))
    ok('...with its room and its photo shot', v?.rooms?.meta?.length === 1 && v?.rooms?.evidence?.[0]?.id === 'rq1')
    ok('...and photo counts per item', v?.itemPhotos?.ci2 === 0)
    ok('the load ends once the live reads give up (one deadline, not three), with nothing newer to show',
      doneAt < 2 * READ_DEADLINE && o.log.shows.length === 1, `${fmt(doneAt)}, ${o.log.shows.length} show(s)`)
    ok('the spinner is down at the end', !o.spinnerOn())

    // She backs out and opens it again: the last request failed, so the card
    // doesn't wait for a live answer at all.
    const again = open(c, JOBS.red, 'A2')
    await again.done
    ok('opened again: the saved list at once', again.offAt() != null && again.offAt()! < 150 && again.log.shows[0]?.v?.items?.length === 3,
      fmt(again.offAt()))
  },

  // A stop the pack never saved, same dead link: the card waits for the live
  // answer (nothing else to show), but once, not round after round.
  async checklistNothingSavedWaitsOnce() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    ok('J-after (the day after tomorrow) is not in the pack', !cached('chkrows:J-after'))
    setClock(MORNING); seedSession()
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const o = open(c, JOBS.after, 'A5')
    await o.done
    ok('the spinner gives way after ONE read deadline', o.offAt() != null && o.offAt()! < 2 * READ_DEADLINE, `${fmt(o.offAt())} (deadline ${READ_DEADLINE} ms)`)
    ok('...with the company default list (no rows, no template, seed from the saved copy)',
      (o.log.shows[0]?.v?.items || []).map((i: any) => i.id).join(',') === '1,2')
  },

  // A trickle: the checklist rows are slow, the rest answer. The saved list
  // shows within the card's wait, and the live rows refresh it when they come.
  async checklistOnATrickle() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    // A teammate ticked "Make beds" after the pack saved.
    server.tables.job_checklist_items.find((r: any) => r.id === 'ci3').completed = true
    server.slow.job_checklist_items = 700  // past the card's wait, inside the deadline
    c = relaunch(); scaleDeadlines(c)
    const o = open(c, JOBS.red, 'A2')
    await o.done
    ok('the list shows within the card\'s wait', o.offAt() != null && o.offAt()! < CARD_WAIT + 200, fmt(o.offAt()))
    ok('...from the saved copy at first (no teammate tick yet)', o.log.shows[0]?.v?.items?.length === 3 && !o.log.shows[0]?.v?.checked?.ci3)
    ok('the live rows refresh it: the teammate\'s tick shows', o.log.shows.length === 2 && o.log.shows[1].v.checked.ci3 === true,
      `${o.log.shows.length} show(s)`)

    // Her own tick while the live rows are still on their way: their answer
    // may predate it, so it must not overwrite the card.
    const o2 = open(c, JOBS.red, 'A2')
    while (!o2.log.shows.length) await sleep(10)
    o2.card.edited()
    await o2.done
    ok('a late answer never overwrites a tick made since the load began', o2.log.shows.length === 1, `${o2.log.shows.length} show(s)`)
  },

  // Whatever goes wrong inside a load, the spinner goes.
  async checklistSpinnerAlwaysClears() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    server.mode = 'offline'
    const settle = (o: ReturnType<typeof open>) => Promise.race([
      o.done.then(() => 'done', (e: any) => `threw: ${e?.message || e}`),
      sleep(3 * READ_DEADLINE).then(() => 'still loading'),
    ])

    // A saved copy that isn't a list of rows: read as no rows.
    store.set('dataCache:chkrows:J-red', JSON.stringify({ not: 'rows' }))
    c = relaunch(); scaleDeadlines(c)
    const o = open(c, JOBS.red, 'A2')
    const end = await settle(o)
    ok('an unreadable saved copy: the load ends', end === 'done', end)
    ok('...the spinner is down', o.log.spinner.length > 0 && !o.spinnerOn(), JSON.stringify(o.log.spinner.map(s => s.on)))
    ok('...and the card shows the template behind the clean', (o.log.shows.at(-1)?.v?.items || []).length === 2)

    // Something that throws: a queued write with no values (no code path
    // queues one; it stands for any bug in the load).
    store.set('writeOutbox', JSON.stringify([{ id: 'bad', table: 'job_checklist_items', op: 'upsert', values: null, created_at: 0 }]))
    c = relaunch(); scaleDeadlines(c)
    const o2 = open(c, JOBS.red, 'A2')
    const end2 = await settle(o2)
    ok('a load that throws still ends', end2 === 'done', end2)
    ok('...the spinner is down', o2.log.spinner.length > 0 && !o2.spinnerOn(), JSON.stringify(o2.log.spinner.map(s => s.on)))
    ok('...and the card offers no invented list to tick', o2.log.shows.length === 1 && o2.log.shows[0].v.items.length === 0,
      `${o2.log.shows.length} show(s)`)
    store.delete('writeOutbox')
  },

  // A reload of the checklist (the realtime echo of her own tick, back from
  // Photos) on a slow link: the saved copy predates the tick she just made,
  // which went through live. It must not take the tick off the card while the
  // live answer is on its way, nor for good if that never comes.
  async checklistReloadKeepsLiveTick() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    c = relaunch(); scaleDeadlines(c)
    const o = open(c, JOBS.red, 'A2')
    await o.done
    ok('opened with signal: Make beds not ticked yet', o.log.shows.length === 1 && o.log.shows[0].v.checked.ci3 !== true)
    o.card.edited()
    server.tables.job_checklist_items.find((r: any) => r.id === 'ci3').completed = true
    server.slow.job_checklist_items = 700
    o.log.shows.length = 0; o.log.spinner.length = 0
    await o.card.load(JOBS.red, CREW, 'A2', DEFAULTS, true)
    ok('the echo of her tick: never shown undone, and the live rows come', o.log.shows.length === 1 && o.log.shows[0].v.checked.ci3 === true,
      o.log.shows.map(x => `${fmt(x.at)} ci3=${!!x.v.checked.ci3}`).join(' → '))

    // Back from Photos as the link dies: nothing live comes. The card keeps
    // the tick (it holds what went through), and the spinner still goes.
    server.mode = 'hang'
    store.set('dataCache:chkrows:J-red', JSON.stringify(cachedVal('chkrows:J-red').map((r: any) => ({ ...r, completed: false }))))
    o.log.shows.length = 0; o.log.spinner.length = 0
    await o.card.load(JOBS.red, CREW, 'A2', DEFAULTS)
    ok('back from Photos on a dead link: the card is left as it was (no older copy shown)', o.log.shows.length === 0, `${o.log.shows.length} show(s)`)
    const up = o.log.spinner.find(x => x.on)?.at ?? NaN, down = o.offAt() ?? Infinity
    ok('...and the spinner is down within the wait', !o.spinnerOn() && down - up < CARD_WAIT + 200, fmt(down - up))
  },

  // The rest of the stop's screen on the same dead link: the job's extras,
  // who is on it, and the property's notes (lib/stopDetails). These were read
  // one after another, a read deadline each: the arrival instructions came
  // three deadlines after the screen opened.
  async stopDetailsOnAHangingLink() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    ok('evening: the pack saves', (await c.prefetchDays(CREW)).status === 'saved')

    setClock(MORNING); seedSession()
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const d = openDetails(c, JOBS.red)
    const doneAt = await d.done
    const prop = d.first('property'), job = d.first('job'), crew = d.first('crew'), roster = d.first('roster')
    ok('the property (arrival instructions, crew notes, bag colour) shows within the wait, not after three read deadlines',
      !!prop && prop.at < CARD_WAIT + 400 && prop.v.arrival_instructions === ADDR.A2.arrival_instructions && prop.v.laundry_bag_color === 'Blue bags',
      `${fmt(prop?.at)} (deadline ${READ_DEADLINE} ms)`)
    ok('the job\'s extras (guests on the booking) show within the wait', !!job && job.at < CARD_WAIT + 400 && job.v.property_reservations?.guest_count === 4, fmt(job?.at))
    ok('the crew line shows within the wait', !!crew && crew.at < CARD_WAIT + 400 && names(crew.v) === 'Nichole', `${fmt(crew?.at)} ${names(crew?.v)}`)
    ok('Clock in: the saved roster is handed over once the live read has given up (as before), marked saved',
      d.shows('roster').length === 1 && !!roster && roster.at >= READ_DEADLINE - 50 && roster.v.live === false && roster.v.ids.join() === U,
      `${fmt(roster?.at)} ${JSON.stringify(roster?.v)}`)
    ok('...and it leaves her Clock in', !!roster && !c.notAssignedHere(JOBS.red, U, { office: false, roster: roster.v }))
    ok('the load ends after one read deadline, not three', doneAt < 2 * READ_DEADLINE, fmt(doneAt))

    // Opened again: the last request failed, so nothing waits for a live answer.
    const again = openDetails(c, JOBS.red)
    await again.done
    ok('opened again: the property at once', (again.first('property')?.at ?? Infinity) < 150, fmt(again.first('property')?.at))
  },

  // A trickle: all three reads are slow, past the wait but inside the read
  // deadline. The saved copies show within the wait; the live answers
  // replace them.
  async stopDetailsOnATrickle() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    // This morning the office put Ali on the clean too and changed the gate
    // code in the arrival instructions, and somebody marked the laundry done
    // on site.
    server.tables.job_assignments.push({ job_id: 'J-red', user_id: V, is_lead: false, users: { id: V, full_name: 'Ali' } })
    server.tables.client_addresses.find((a: any) => a.id === 'A2').arrival_instructions = 'Side gate, gate code 3344.'
    server.tables.jobs.find((j: any) => j.id === 'J-red').laundry_done_onsite = true
    server.slow.job_assignments = 700  // past the wait, inside the deadline
    server.slow.jobs = 700
    server.slow.client_addresses = 700
    c = relaunch(); scaleDeadlines(c)
    const d = openDetails(c, JOBS.red)
    await d.done
    const crews = d.shows('crew'), rosters = d.shows('roster'), jobs = d.shows('job'), props = d.shows('property')
    ok('the crew line: the saved copy within the wait, then the live one with Ali',
      crews.length === 2 && crews[0].at < CARD_WAIT + 200 && names(crews[0].v) === 'Nichole' && names(crews[1].v) === 'Nichole,Ali',
      crews.map(x => `${fmt(x.at)} ${names(x.v)}`).join(' → '))
    ok('Clock in: one roster, the live one (never the saved copy first)',
      rosters.length === 1 && rosters[0].v.live === true && rosters[0].v.ids.join() === `${U},${V}` && rosters[0].at >= 700,
      rosters.map(x => `${fmt(x.at)} ${JSON.stringify(x.v)}`).join(' → '))
    ok('the job\'s extras: saved, then live (laundry now done on site)',
      jobs.length === 2 && jobs[0].at < CARD_WAIT + 200 && jobs[0].v.laundry_done_onsite === false && jobs[1].v.laundry_done_onsite === true && jobs[1].flags === true,
      jobs.map(x => `${fmt(x.at)} laundry=${x.v.laundry_done_onsite} flags=${x.flags}`).join(' → '))
    ok('the property: the saved notes within the wait, then the new gate code',
      props.length === 2 && props[0].at < CARD_WAIT + 200 && props[0].v.arrival_instructions === ADDR.A2.arrival_instructions && props[1].v.arrival_instructions === 'Side gate, gate code 3344.',
      props.map(x => `${fmt(x.at)} ${x.v.arrival_instructions}`).join(' → '))

    // She taps "laundry done on site" while the job's live answer is still on
    // its way: that answer may predate her tap, so it must leave the flags alone.
    const d2 = openDetails(c, JOBS.red)
    while (!d2.first('job')) await sleep(10)
    d2.details.flagEdited()
    await d2.done
    const j2 = d2.shows('job')
    ok('a late answer never overwrites a flag she changed since the load began',
      j2.length === 2 && j2[0].flags === true && j2[1].flags === false,
      j2.map(x => `flags=${x.flags}`).join(' → '))
  },

  // jobScope.notAssignedHere: a SAVED roster says "not on it" only when the
  // job's own assignments agree, and a live one decides. Here both the saved
  // roster and the job row she opened are from before she was added (she saw
  // the clean on the open job board last night, then took it). A saved roster
  // handed over ahead of the live one would take her Clock in away until the
  // live answer came, or for good if it never did.
  async stopDetailsSavedRosterKeepsClockIn() {
    setClock(EVENING); seedServer(); seedSession()
    server.tables.job_assignments = server.tables.job_assignments.filter((a: any) => a.job_id !== 'J-red')
      .concat({ job_id: 'J-red', user_id: V, is_lead: true, users: { id: V, full_name: 'Ali' } })
    let c = load()
    await c.cachedRead(c.reads.jobCrewRead('J-red'))
    ok('evening: the phone saved J-red\'s crew without her', cachedVal('crew:J-red').map((a: any) => a.user_id).join() === V)

    setClock(MORNING); seedSession()
    server.tables.job_assignments.push({ job_id: 'J-red', user_id: U, is_lead: false, users: { id: U, full_name: 'Nichole' } })
    server.slow.job_assignments = 700
    c = relaunch(); scaleDeadlines(c)
    const stale = { ...JOBS.red, job_assignments: [{ user_id: V }] }
    const d = openDetails(c, stale)
    await d.done
    const hidden = d.shows('roster').filter(r => c.notAssignedHere(stale, U, { office: false, roster: r.v }))
    ok('no roster ever takes her Clock in away', hidden.length === 0, d.shows('roster').map(r => `${fmt(r.at)} ${JSON.stringify(r.v)}`).join(' → '))
    ok('...the live roster, with her, is the one handed over', d.shows('roster').length === 1 && d.shows('roster')[0].v.live === true && d.shows('roster')[0].v.ids.includes(U))
    ok('...while the crew line showed the saved names at once', names(d.first('crew')?.v) === 'Ali' && (d.first('crew')?.at ?? Infinity) < CARD_WAIT + 200)

    // The live read never answers: the saved roster becomes final once the
    // read gives up, as it always did, and only then can it count (and here
    // it does: her job row lacks her too). The live answer above replaced the
    // saved copy, so put last night's back.
    store.set('dataCache:crew:J-red', JSON.stringify([{ user_id: V, is_lead: true, users: { id: V, full_name: 'Ali' } }]))
    server.slow = {}
    server.hang.add('job_assignments')
    const d2 = openDetails(c, stale)
    await d2.done
    const r2 = d2.shows('roster')
    ok('no answer at all: the saved roster only once the read gives up', r2.length === 1 && r2[0].at >= READ_DEADLINE - 50 && r2[0].v.live === false && r2[0].v.ids.join() === V,
      r2.map(r => `${fmt(r.at)} ${JSON.stringify(r.v)}`).join(' → '))
    server.hang.clear()
  },

  // The Check first card on the same dead link (lib/checkFirstCard): the
  // property's lines and the company's switch, then the clean's ticks, line
  // photos and start, used to be two rounds of a read deadline each.
  async checkFirstOnAHangingLink() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    ok('evening: the pack saves', (await c.prefetchDays(CREW)).status === 'saved')
    setClock(MORNING); seedSession()
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    server.asked = []
    const o = openCheckFirst(c, JOBS.red, { soon: true })
    await o.first
    const v = o.log[0]?.v
    ok('the card shows within the wait, not after two read deadlines', (o.log[0]?.at ?? Infinity) < CARD_WAIT + 400, `${fmt(o.log[0]?.at)} (deadline ${READ_DEADLINE} ms)`)
    ok('...the saved lines, the plants ticked, the company\'s switch on',
      (v?.lines || []).map((l: any) => l.id).join() === 'cf1,cf2' && (v?.ticks || []).map((k: any) => k.line_id).join() === 'cf1' && v?.required === true,
      JSON.stringify({ lines: (v?.lines || []).map((l: any) => l.id), ticks: (v?.ticks || []).map((k: any) => k.line_id), required: v?.required }))
    const sent = (t: string) => server.asked.find(a => a.table === t)?.at
    ok('the clean\'s reads went out with the lines (the saved copy says the property has some)',
      sent('job_check_first_ticks') != null && sent('property_check_first_lines') != null && sent('job_check_first_ticks')! - sent('property_check_first_lines')! < 50)
    await sleep(READ_DEADLINE + 300)
    ok('the live reads give up: nothing newer, one show', o.log.length === 1, `${o.log.length} show(s)`)

    // A property with no lines (most of them): no card, and the clean's own
    // reads never go out.
    server.asked = []
    const n = openCheckFirst(c, JOBS.late, { soon: true })
    await n.first
    ok('no lines: no card, at once (the last request failed)', o.log.length > 0 && n.log[0]?.v === null && (n.log[0]?.at ?? Infinity) < 150, fmt(n.log[0]?.at))
    ok('...and nothing asked for the clean\'s ticks, photos or start',
      !server.asked.some(a => ['job_check_first_ticks', 'job_photos', 'jobs'].includes(a.table)), server.asked.map(a => a.table).join())
  },

  // A trickle: a teammate ticked the spa photo line this morning and the
  // ticks are slow. The saved card shows within the wait and the live ticks
  // refresh it; her own tick in between keeps the late answer off the card.
  // A load after a tick (or at Complete) waits for the live answer.
  async checkFirstOnATrickle() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    server.tables.job_check_first_ticks.push({ id: 'tk2', tenant_id: T, job_id: 'J-red', line_id: 'cf2', user_id: V, line_text: 'Spa photo', ticked_at: at('2026-10-14T13:30:00Z'), created_at: at('2026-10-14T13:30:00Z'), users: { full_name: 'Ali' } })
    server.slow.job_check_first_ticks = 700
    c = relaunch(); scaleDeadlines(c)
    const o = openCheckFirst(c, JOBS.red, { soon: true })
    await sleep(700 + 400)
    const ticks = (x: any) => (x?.v?.ticks || []).map((k: any) => k.line_id).join()
    ok('saved card within the wait, then the live ticks with the teammate\'s',
      o.log.length === 2 && o.log[0].at < CARD_WAIT + 200 && ticks(o.log[0]) === 'cf1' && ticks(o.log[1]) === 'cf1,cf2',
      o.log.map(x => `${fmt(x.at)} ${ticks(x)}`).join(' → '))

    const o2 = openCheckFirst(c, JOBS.red, { soon: true })
    await o2.first
    o2.card.edited()
    await sleep(700 + 400)
    ok('a late answer never overwrites a tick made since the load began', o2.log.length === 1, `${o2.log.length} show(s)`)

    const o3 = openCheckFirst(c, JOBS.red)
    const v3 = await o3.first
    ok('a load after a tick waits for the live answer', ticks({ v: v3 }) === 'cf1,cf2' && o3.log.length === 1 && o3.log[0].at >= 700, fmt(o3.log[0]?.at))

    // Uptown had no lines when the pack saved; the office adds one this
    // morning and the lines are slow: no card at first, then the line.
    server.tables.property_check_first_lines.push({ id: 'cf9', tenant_id: T, address_id: 'A1', body: 'Lock the side gate', photo_required: false, sort_order: 1, created_at: at('2026-10-14T13:00:00Z'), updated_at: at('2026-10-14T13:00:00Z'), archived_at: null })
    server.slow = { property_check_first_lines: 700 }
    const u = openCheckFirst(c, JOBS.late, { soon: true })
    await sleep(700 + 400)
    ok('a property with no saved lines: no card within the wait, then the new line',
      u.log.length === 2 && u.log[0].v === null && u.log[0].at < CARD_WAIT + 200 && (u.log[1].v?.lines || []).map((l: any) => l.id).join() === 'cf9',
      u.log.map(x => `${fmt(x.at)} ${(x.v?.lines || []).map((l: any) => l.id).join() || 'none'}`).join(' → '))
  },
  // ── The time tracker (lib/timeTracker) ──────────────────────────────────
  // The timer and Clock in / Pause / Resume came from one read with a read
  // deadline: on a link that swallows requests, Clock in showed for 15 s on a
  // clean she was already clocked into. She clocked in at 7:05 with signal
  // (the phone saved it); at the next stop's door, one bar.
  async timerOnAHangingLink() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    ok('evening: the pack saves', (await c.prefetchDays(PJ)).status === 'saved')
    setClock(MORNING); seedSession()
    server.tables.job_time_entries.push(timeEntry('te-1', U, '2026-10-14T14:05:00Z'))
    await c.cachedRead(c.reads.timeEntriesRead('J-red', U, false))  // the screen, opened with signal at 7:05
    ok('the phone saved her running entry', runningIds(cachedVal(`time:J-red:${U}`)) === 'te-1')
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const s = tracking(c)
    const doneAt = await s.tr.load(JOBS.red, PJ, false, { soon: true }).then(() => s.now())
    const first = s.log[0]
    ok('her running entry shows within the wait, not after a read deadline (Pause, not Clock in)',
      !!first && first.at < CARD_WAIT + 400 && runningIds(first.rows) === 'te-1', `${fmt(first?.at)} ${runningIds(first?.rows)} (deadline ${READ_DEADLINE} ms)`)
    ok('the load ends once the live read gives up, with nothing newer to show', doneAt < 2 * READ_DEADLINE && s.log.length === 1, `${fmt(doneAt)}, ${s.log.length} show(s)`)
    const again = tracking(c)
    await again.tr.load(JOBS.red, PJ, false, { soon: true })
    ok('opened again: at once (the last request failed)', (again.log[0]?.at ?? Infinity) < 150 && runningIds(again.log[0]?.rows) === 'te-1', fmt(again.log[0]?.at))
  },

  // A trickle: the clock was started from somewhere else (the web, another
  // phone) after the phone saved its copy. The saved copy shows within the
  // wait; the live answer, when it comes, replaces it.
  async timerLiveAnswerReplacesSaved() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(PJ)
    setClock(MORNING); seedSession()
    server.tables.job_time_entries.push(timeEntry('te-web', U, '2026-10-14T13:55:00Z', null, { source: 'manual' }))
    server.slow.job_time_entries = 700
    c = relaunch(); scaleDeadlines(c)
    const s = tracking(c)
    await s.tr.load(JOBS.red, PJ, false, { soon: true })
    ok('the saved copy within the wait, then the live entry',
      s.log.length === 2 && s.log[0].at < CARD_WAIT + 200 && s.log[0].rows.length === 0 && runningIds(s.log[1].rows) === 'te-web',
      s.log.map(x => `${fmt(x.at)} [${runningIds(x.rows)}]`).join(' → '))
  },

  // Her own punch while the live answer is on its way: that answer may
  // predate it, so it must not take the punch off the screen.
  async timerLateAnswerNeverUndoesAPunch() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(PJ)
    setClock(MORNING); seedSession()
    server.slow.job_time_entries = 700
    c = relaunch(); scaleDeadlines(c)
    const s = tracking(c)
    const p = s.tr.load(JOBS.red, PJ, false, { soon: true })
    while (!s.log.length) await sleep(10)
    ok('the saved copy within the wait: not started', s.log[0].at < CARD_WAIT + 200 && s.log[0].rows.length === 0, fmt(s.log[0].at))
    await s.tr.punched(timeEntry('te-in', U, new Date().toISOString()), PJ)
    ok('her clock-in shows at once', runningIds(s.last()) === 'te-in')
    await p
    ok('the live answer from before it never takes it off', s.log.slice(1).every(x => runningIds(x.rows) === 'te-in'),
      s.log.map(x => `${fmt(x.at)} [${runningIds(x.rows)}]`).join(' → '))
  },

  // A clock-in that lands live is written into the phone's saved copy, so a
  // screen opened later on a link too weak to answer shows it. And a reload
  // after it, falling back to a copy from before it, leaves it on screen.
  async timerPunchSurvivesTheSavedCopy() {
    setClock(MORNING); seedServer(); seedSession()
    let c = load(); scaleDeadlines(c)
    const s = tracking(c)
    await s.tr.load(JOBS.red, PJ, false, { soon: true })
    ok('opened with signal: not started', s.log.length === 1 && s.log[0].rows.length === 0)
    const e = timeEntry('te-in', U, new Date().toISOString())
    const w = await c.writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: e })
    ok('the clock-in lands live', !w.error && !w.queued && server.tables.job_time_entries.some((r: any) => r.id === 'te-in'))
    await s.tr.punched(e, PJ)
    ok('on screen at once', runningIds(s.last()) === 'te-in')
    ok('and in the phone\'s saved copy', runningIds(cachedVal(`time:J-red:${U}`)) === 'te-in', JSON.stringify(cachedVal(`time:J-red:${U}`)))

    // The reload after the punch: the live read hangs, and the copy it falls
    // back to is from before the punch (an older answer stored late).
    store.set(`dataCache:time:J-red:${U}`, '[]')
    server.hang.add('job_time_entries')
    const n = s.log.length
    await s.tr.load(JOBS.red, PJ, false)
    ok('a reload that falls back to an older saved copy never takes the running entry off',
      s.log.slice(n).every(x => runningIds(x.rows) === 'te-in') && runningIds(s.last()) === 'te-in',
      s.log.slice(n).map(x => `[${runningIds(x.rows)}]`).join(' → ') || 'no show')
    server.hang.clear()

    // The arrival auto clock-in (a background task, no screen) saves its
    // entry the same way.
    store.set(`dataCache:time:J-red:${U}`, '[]')
    await c.savePunch(timeEntry('te-auto', U, '2026-10-14T13:58:00Z', null, { source: 'auto' }), U)
    ok('the arrival auto clock-in is written into the saved copy', runningIds(cachedVal(`time:J-red:${U}`)) === 'te-auto')
    ok('...and not into a whole-job copy the phone never saved', !cached('time:J-red:job'))
    await c.savePunch(timeEntry('te-px', V, '2026-10-14T13:59:00Z'), O)
    ok('a punch desk staff record for a cleaner starts the whole job\'s copy (Complete must close it)',
      runningIds(cachedVal('time:J-red:job')) === 'te-px' && runningIds(cachedVal(`time:J-red:${O}`)) === '')

    // Opened again later, every request hanging: the saved clock-in.
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const r = tracking(c)
    await r.tr.load(JOBS.red, PJ, false, { soon: true })
    ok('reopened on a dead link: the clock-in within the wait', (r.log[0]?.at ?? Infinity) < CARD_WAIT + 400 && runningIds(r.log[0]?.rows) === 'te-auto',
      `${fmt(r.log[0]?.at)} [${runningIds(r.log[0]?.rows)}]`)
  },

  // A pause that lands live, then the link dies and the phone's copy is from
  // before the pause: the clean never shows as running again.
  async timerPauseNeverRunsAgain() {
    setClock(MORNING); seedServer(); seedSession()
    server.tables.job_time_entries.push(timeEntry('te-1', U, '2026-10-14T13:05:00Z'))
    const c = load(); scaleDeadlines(c)
    const s = tracking(c)
    await s.tr.load(JOBS.red, PJ, false, { soon: true })
    ok('running', runningIds(s.last()) === 'te-1')
    const paused = { clocked_out_at: new Date().toISOString(), pause_reason: 'Supply run', duration_minutes: 55 }
    const w = await c.writeThrough({ table: 'job_time_entries', op: 'update', match: { id: 'te-1' }, values: paused })
    await s.tr.punched({ ...s.last()[0], ...paused }, PJ)
    ok('paused on screen at once (Resume)', !w.queued && runningIds(s.last()) === '' && s.last()[0]?.pause_reason === 'Supply run')
    ok('the saved copy says paused too', cachedVal(`time:J-red:${U}`)?.[0]?.clocked_out_at != null)
    store.set(`dataCache:time:J-red:${U}`, JSON.stringify([timeEntry('te-1', U, '2026-10-14T13:05:00Z')]))
    server.mode = 'hang'
    const n = s.log.length
    await s.tr.load(JOBS.red, PJ, false)
    ok('a reload that falls back to a copy from before the pause: still paused, never running',
      s.log.slice(n).every(x => runningIds(x.rows) === '') && s.last()[0]?.pause_reason === 'Supply run',
      s.log.slice(n).map(x => `[${runningIds(x.rows)}]`).join(' → ') || 'no show')
  },

  // No signal at all (instant failures): punches queue in the outbox, the
  // overlay shows them, and once the outbox delivers them the saved copy
  // still has them (the outbox no longer does).
  async timerQueuedPunchesOffline() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(PJ)
    setClock(MORNING)
    server.mode = 'offline'
    c = relaunch(); scaleDeadlines(c)
    const s = tracking(c)
    await s.tr.load(JOBS.red, PJ, false, { soon: true })
    ok('offline: the saved copy at once, not started', (s.log[0]?.at ?? Infinity) < 150 && s.log[0].rows.length === 0)
    const e = timeEntry('te-q', U, new Date().toISOString())
    const w1 = await c.writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: e })
    await s.tr.punched(e, PJ)
    await s.tr.load(JOBS.red, PJ, false)
    ok('a queued clock-in: running, after the reload too', w1.queued && runningIds(s.last()) === 'te-q')
    const paused = { clocked_out_at: new Date().toISOString(), pause_reason: 'Break', duration_minutes: 20 }
    const w2 = await c.writeThrough({ table: 'job_time_entries', op: 'update', match: { id: 'te-q' }, values: paused })
    await s.tr.punched({ ...e, ...paused }, PJ)
    await s.tr.load(JOBS.red, PJ, false)
    ok('a queued pause: paused, after the reload too', w2.queued && runningIds(s.last()) === '' && s.last()[0]?.pause_reason === 'Break')
    // Signal for a moment: the outbox delivers both. Then nothing again.
    seedSession(); server.mode = 'online'
    await c.flushOutbox()
    ok('delivered', server.tables.job_time_entries.some((r: any) => r.id === 'te-q' && r.pause_reason === 'Break'))
    seedSession(); server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const r = tracking(c)
    await r.tr.load(JOBS.red, PJ, false, { soon: true })
    ok('reopened on a dead link after the outbox delivered: the paused session within the wait (no Clock in)',
      (r.log[0]?.at ?? Infinity) < CARD_WAIT + 400 && r.log[0].rows.length === 1 && r.log[0].rows[0].pause_reason === 'Break',
      `${fmt(r.log[0]?.at)} ${JSON.stringify(r.log[0]?.rows?.map((x: any) => x.id))}`)
  },

  // Desk staff on the whole job's clock. An answer from a load that began
  // before her punch is merged, not dropped: it keeps her punch, and still
  // brings what happened elsewhere. Closed beats running, whichever copy says it.
  async timerOlderAnswerKeepsAClockOut() {
    setClock(EVENING); seedServer(); seedSession()
    server.tables.job_time_entries.push(timeEntry('te-proxy', U, '2026-10-14T02:00:00Z'))
    let c = load()
    await c.cachedRead(c.reads.timeEntriesRead('J-red', O, true))
    setClock(MORNING); seedSession()
    // Nichole clocked out on her own phone this morning.
    server.tables.job_time_entries.find((e: any) => e.id === 'te-proxy').clocked_out_at = at('2026-10-14T13:30:00Z')
    server.slow.job_time_entries = 700
    c = relaunch(); scaleDeadlines(c)
    const s = tracking(c)
    const p = s.tr.load(JOBS.red, OWNER, true, { soon: true })
    while (!s.log.length) await sleep(10)
    ok('the saved whole-job clock within the wait: Nichole running', s.log[0].at < CARD_WAIT + 200 && runningIds(s.log[0].rows) === 'te-proxy', fmt(s.log[0].at))
    // She records Ali's start while the live answer is on its way.
    await s.tr.punched(timeEntry('te-ali', V, new Date().toISOString()), OWNER)
    await p
    ok('the late answer keeps her punch and brings Nichole\'s clock-out',
      runningIds(s.last()) === 'te-ali' && s.last().find((e: any) => e.id === 'te-proxy')?.clocked_out_at != null,
      s.log.map(x => `${fmt(x.at)} [${runningIds(x.rows)}]`).join(' → '))
    ok('her proxy punch is in the whole job\'s saved copy', runningIds(cachedVal(`time:J-red:job`)).includes('te-ali'))
  },

  // Desk staff on a clean they aren't crew on see the whole job's clock: the
  // entry they recorded for a cleaner has to show, or Complete can't close it.
  // The screen widens once the crew line says she's not on it; on a dead link
  // the whole job's saved copy shows within the wait.
  async timerWholeJobForTheOffice() {
    setClock(EVENING); seedServer(); seedSession()
    server.tables.job_time_entries.push(timeEntry('te-proxy', U, '2026-10-14T02:00:00Z', null, { users: { full_name: 'Nichole' } }))
    let c = load()
    await c.cachedRead(c.reads.timeEntriesRead('J-red', O, true))
    await c.cachedRead(c.reads.timeEntriesRead('J-red', O, false))
    setClock(MORNING); seedSession()
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const s = tracking(c)
    void s.tr.load(JOBS.red, OWNER, false, { soon: true })
    while (!s.log.length) await sleep(10)
    ok('her own clock first: nothing of hers (within the wait)', s.log[0].rows.length === 0 && s.log[0].at < CARD_WAIT + 400, fmt(s.log[0].at))
    const from = s.now()
    void s.tr.load(JOBS.red, OWNER, true)
    while (s.log.length < 2) await sleep(10)
    const w = s.log[1]
    ok('widened: the whole job\'s saved clock within the wait, with the entry she recorded for Nichole',
      w.at - from < CARD_WAIT + 400 && runningIds(w.rows) === 'te-proxy', `${fmt(w.at - from)} [${runningIds(w.rows)}]`)
    void s.tr.load(JOBS.red, OWNER, false)
    while (s.log.length < 3) await sleep(10)
    ok('narrowed back (she is on the crew after all): her own entries only', s.log[2].rows.every((e: any) => e.user_id === O), `[${s.log[2].rows.map((e: any) => e.id)}]`)
    // A load overtaken by a newer one shows nothing: its answer may be the
    // other clock. (Her own clock's read hangs and falls back late; the whole
    // job's answers meanwhile.)
    await sleep(READ_DEADLINE)
    const ownP = s.tr.load(JOBS.red, OWNER, false)
    await sleep(20)
    server.mode = 'online'
    await s.tr.load(JOBS.red, OWNER, true)
    await ownP
    ok('an overtaken load\'s late answer never replaces the newer one', runningIds(s.last()) === 'te-proxy', `[${runningIds(s.last())}]`)
  },

  // ── The office's note, the next arrival, Stop k of M, the video switch ──
  // (lib/stopInfo) One read deadline each on a dead link; the note gates
  // Clock in ("Got it").
  async stopInfoOnAHangingLink() {
    setClock(EVENING); seedServer(); seedSession()
    server.tables.jobs.find((j: any) => j.id === 'J-red').crew_note_at_clock_in = true
    let c = load()
    ok('evening: the pack saves', (await c.prefetchDays(CREW)).status === 'saved')
    setClock(MORNING); seedSession()
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const o = openInfo(c, JOBS.red, CREW)
    const doneAt = await o.done
    const note = o.first('note'), arr = o.first('nextArrival'), route = o.first('routeStop'), video = o.first('video')
    ok('the office\'s note (asked for at clock-in) within the wait, not after a read deadline',
      !!note && note.at < CARD_WAIT + 400 && note.v.crew_note === 'Guest left early — check the patio.' && note.v.crew_note_at_clock_in === true,
      `${fmt(note?.at)} (deadline ${READ_DEADLINE} ms)`)
    ok('who arrives next, within the wait', !!arr && arr.at < CARD_WAIT + 400 && arr.v?.kind === 'guest' && arr.v?.name === 'Rivera', `${fmt(arr?.at)} ${JSON.stringify(arr?.v)}`)
    ok('"Stop 1 of 2", within the wait', !!route && route.at < CARD_WAIT + 400 && route.v?.k === 1 && route.v?.m === 2, `${fmt(route?.at)} ${JSON.stringify(route?.v)}`)
    ok('the video switch, within the wait', !!video && video.at < CARD_WAIT + 400 && video.v === false, fmt(video?.at))
    ok('the load ends after one read deadline', doneAt < 2 * READ_DEADLINE, fmt(doneAt))
    ok('nothing newer once the live reads give up: one show each', ['note', 'nextArrival', 'routeStop', 'video'].every(k => o.shows(k).length === 1),
      ['note', 'nextArrival', 'routeStop', 'video'].map(k => `${k}:${o.shows(k).length}`).join(' '))
    const again = openInfo(c, JOBS.red, CREW)
    await again.done
    ok('opened again: at once (the last request failed)', (again.first('note')?.at ?? Infinity) < 150, fmt(again.first('note')?.at))
  },

  // A trickle: the office reworded the note this morning, and the acks are
  // slow. The saved note shows first, the live one replaces it. A "Got it"
  // she gives while the answers are on their way is never lost to them (it
  // would ask her again).
  async stopInfoTrickleKeepsGotIt() {
    setClock(EVENING); seedServer(); seedSession()
    server.tables.jobs.find((j: any) => j.id === 'J-red').crew_note_at_clock_in = true
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    server.tables.jobs.find((j: any) => j.id === 'J-red').crew_note = 'Guest left early — check the patio and the grill.'
    server.slow.jobs = 700
    server.slow.job_crew_note_acks = 700
    c = relaunch(); scaleDeadlines(c)
    const o = openInfo(c, JOBS.red, CREW)
    while (!o.first('acks')) await sleep(10)
    o.info.acknowledged('Guest left early — check the patio.')
    await o.done
    const notes = o.shows('note')
    ok('the saved note within the wait, then the reworded one',
      notes.length === 2 && notes[0].at < CARD_WAIT + 200 && /patio\.$/.test(notes[0].v.crew_note) && /grill/.test(notes[1].v.crew_note),
      notes.map(x => `${fmt(x.at)} ${x.v.crew_note}`).join(' → '))
    ok('the note never shows before the "Got it"s (it would ask again)', o.log.findIndex(e => e.kind === 'acks') < o.log.findIndex(e => e.kind === 'note'))
    const acks = o.shows('acks')
    ok('her "Got it" stays through the late answers',
      acks.at(-1)?.v.includes('Guest left early — check the patio.') && acks.slice(acks.findIndex(a => a.v.includes('Guest left early — check the patio.'))).every(a => a.v.includes('Guest left early — check the patio.')),
      acks.map(x => `${fmt(x.at)} [${x.v.join('|')}]`).join(' → '))
  },

  // ── The required-shot counter (lib/requiredPhotoCount) ──────────────────
  // Its reads were uncached and in two rounds (the company's switch, then
  // the requirements, the shots and the owed list): offline the counter was
  // hidden, and on a dead link nothing showed for a read deadline and more.
  async photoCountOnAHangingLink() {
    setClock(EVENING); seedServer(); seedSession()
    server.rpc.job_required_photo_ids = () => [{ requirement_id: 'rq1' }]
    let c = load()
    ok('evening: the pack saves, the company\'s switch with it',
      (await c.prefetchDays(CREW)).status === 'saved' && cachedVal(`tenphotoreq:${T}`)?.enforce_photo_requirements === true)
    setClock(MORNING); seedSession()
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    server.asked = []
    const k = counting(c)
    const doneAt = await k.load(JOBS.red, CREW, { soon: true })
    const first = k.log[0]
    ok('the counter within the wait: 1 shot, none taken (every required shot counts while the owed list can\'t be asked)',
      !!first && first.at < CARD_WAIT + 400 && first.c.total === 1 && first.c.done === 0 && first.c.owed === null,
      `${fmt(first?.at)} ${countStr(first?.c)} (deadline ${READ_DEADLINE} ms)`)
    const sent = (t: string) => server.asked.find(a => a.table === t)?.at
    ok('one round: the requirements, shots and owed list go out with the switch (the saved switch says on)',
      sent('property_photo_requirements') != null && sent('job_photos') != null && sent('rpc/job_required_photo_ids') != null &&
      Math.abs(sent('property_photo_requirements')! - sent('tenants')!) < 50,
      server.asked.map(a => a.table).join())
    ok('the load ends once the reads give up', doneAt < WRITE_DEADLINE + 500, fmt(doneAt))
  },

  // The owed list (job_required_photo_ids: frozen at clock-in, archived rooms
  // out) is never taken from a saved copy: an old one could only leave out
  // shots the clean owes. Until it answers, every required shot counts.
  async photoCountOwedListNarrows() {
    setClock(MORNING); seedServer(); seedSession()
    // The owner archived the kitchen room: this clean owes nothing.
    server.rpc.job_required_photo_ids = () => []
    server.slow['rpc/job_required_photo_ids'] = 700
    const c = load(); scaleDeadlines(c)
    for (const r of [c.reads.photoEnforceRead(T), c.reads.photoRequirementsRead('A2'), c.reads.requirementShotsRead('J-red')]) await c.cachedRead(r)
    // With signal: one count, the owed list in it (no flash of every required shot).
    server.slow = {}
    server.rpc.job_required_photo_ids = () => [{ requirement_id: 'rq1' }]
    const k0 = counting(c)
    await k0.load(JOBS.red, CREW, { soon: true })
    ok('with signal: one count, with the owed list', k0.log.length === 1 && k0.log[0].c.owed?.size === 1, k0.log.map(x => countStr(x.c)).join(' → '))
    server.rpc.job_required_photo_ids = () => []
    server.slow['rpc/job_required_photo_ids'] = 700
    const k = counting(c)
    await k.load(JOBS.red, CREW, { soon: true })
    ok('first every required shot, within the wait; then the owed list: none owed',
      k.log.length === 2 && k.log[0].at < CARD_WAIT + 200 && k.log[0].c.total === 1 && k.log[0].c.owed === null && k.log[1].c.total === 0 && k.log[1].c.owed?.size === 0,
      k.log.map(x => `${fmt(x.at)} ${countStr(x.c)}`).join(' → '))
    ok('the owed list is not kept on the phone', ![...store.keys()].some(key => /job_required_photo_ids|owed/.test(key)))

    // An older database without the function: 404. Every required shot, as before.
    delete server.rpc.job_required_photo_ids; server.slow = {}
    const k2 = counting(c)
    await k2.load(JOBS.red, CREW, { soon: true })
    ok('no owed list (an older database): every required shot counts', k2.log.at(-1)?.c.total === 1 && k2.log.at(-1)?.c.owed === null,
      k2.log.map(x => countStr(x.c)).join(' → '))

    // A shot lands: the reload (it waits for the live answer) counts it.
    server.rpc.job_required_photo_ids = () => [{ requirement_id: 'rq1' }]
    server.tables.job_photos.push(photoRow('ph1', 'J-red', { photo_requirement_id: 'rq1' }))
    await k2.load(JOBS.red, CREW)
    ok('a reload after a shot lands: 1 of 1, owed list from the server', k2.log.at(-1)?.c.total === 1 && k2.log.at(-1)?.c.done === 1 && k2.log.at(-1)?.c.owed?.size === 1,
      countStr(k2.log.at(-1)?.c))

    // The link dies, and the copy a reload falls back to is from before the
    // shot: the counter keeps what it shows.
    store.set('dataCache:pshot:J-red', '[]')
    server.mode = 'hang'
    const n = k2.log.length
    await k2.load(JOBS.red, CREW)
    ok('a reload on a dead link never steps back to an older copy, nor forgets the owed list', k2.log.slice(n).every(x => x.c.done === 1 && x.c.total === 1 && x.c.owed?.size === 1),
      k2.log.slice(n).map(x => countStr(x.c)).join(' → ') || 'no show')
  },

  // A trickle: a shot landed from another phone after the copy was saved,
  // and the shots are slow: the saved count first, then the live one. And a
  // company that turned the switch on this morning: no counter at first, then
  // the count, its requirements asked only once the switch says so.
  async photoCountTrickle() {
    setClock(MORNING); seedServer(); seedSession()
    server.rpc.job_required_photo_ids = () => [{ requirement_id: 'rq1' }]
    let c = load(); scaleDeadlines(c)
    for (const r of [c.reads.photoEnforceRead(T), c.reads.photoRequirementsRead('A2'), c.reads.requirementShotsRead('J-red')]) await c.cachedRead(r)
    server.tables.job_photos.push(photoRow('ph1', 'J-red', { photo_requirement_id: 'rq1' }))
    server.slow.job_photos = 700
    c = relaunch(); scaleDeadlines(c)
    const k = counting(c)
    await k.load(JOBS.red, CREW, { soon: true })
    ok('the saved count within the wait, then the live shot', k.log.length === 2 && k.log[0].at < CARD_WAIT + 200 && k.log[0].c.done === 0 && k.log[1].c.done === 1,
      k.log.map(x => `${fmt(x.at)} ${countStr(x.c)}`).join(' → '))
    store.set(`dataCache:tenphotoreq:${T}`, JSON.stringify({ enforce_photo_requirements: false }))
    server.slow = { tenants: 700 }
    server.asked = []
    const k2 = counting(c)
    await k2.load(JOBS.red, CREW, { soon: true })
    const sent = (t: string) => server.asked.find(a => a.table === t)?.at ?? Infinity
    ok('switched on this morning: no counter within the wait, then the count',
      k2.log.length >= 2 && k2.log[0].at < CARD_WAIT + 200 && k2.log[0].c.total === 0 && k2.log.at(-1)?.c.total === 1 && k2.log.at(-1)?.c.done === 1,
      k2.log.map(x => `${fmt(x.at)} ${countStr(x.c)}`).join(' → '))
    ok('...its requirements asked only once the switch said on', sent('property_photo_requirements') - sent('tenants') >= 650, `${Math.round(sent('property_photo_requirements') - sent('tenants'))} ms after`)
  },

  // A company that doesn't hold crews to the shots: no counter, and on a
  // weak link nothing asked beyond its switch.
  async photoCountNotEnforcedAsksNothingMore() {
    setClock(MORNING); seedServer(); seedSession()
    server.tables.tenants[0].enforce_photo_requirements = false
    const c = load(); scaleDeadlines(c)
    await c.cachedRead(c.reads.photoEnforceRead(T))
    server.asked = []
    const k = counting(c)
    await k.load(JOBS.red, CREW, { soon: true })
    ok('no counter', k.log.length >= 1 && k.log.at(-1)?.c.total === 0, k.log.map(x => countStr(x.c)).join(' → '))
    ok('...and nothing asked beyond the switch', server.asked.every(a => a.table === 'tenants'), server.asked.map(a => a.table).join())
  },

  // ── Supplies (lib/suppliesCard) ─────────────────────────────────────────
  async suppliesOnAHangingLink() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const o = openSupplies(c, JOBS.red, 'A2')
    const doneAt = await o.done
    ok('the spinner gives way within the wait, not after a read deadline', o.offAt() != null && o.offAt()! < CARD_WAIT + 400, `${fmt(o.offAt())} (deadline ${READ_DEADLINE} ms)`)
    const v = o.log[0]?.v
    ok('...showing the saved catalog, the office\'s extra linen, and the offline banner',
      v?.items?.length === 2 && v?.extras?.['inv-towel'] === 2 && v?.offline === true, JSON.stringify({ items: v?.items?.length, extras: v?.extras, offline: v?.offline }))
    ok('the load ends once the live reads give up, with nothing newer', doneAt < 2 * READ_DEADLINE && o.log.length === 1 && !o.spinnerOn(), `${fmt(doneAt)}, ${o.log.length} show(s)`)
  },

  // A trickle: a teammate logged towels on this clean this morning. The saved
  // copy shows first; she flags toilet paper low; then the live rows come.
  // Her line stays, the teammate's shows, and the save diffs against the live
  // rows: it adds hers and leaves the teammate's alone.
  async suppliesLiveAnswerKeepsHerLines() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    server.tables.job_inventory_log.push(logRow('lg-t', 'J-red', 'inv-towel', 'Bath towel', { qty_used: 2 }))
    server.slow.job_inventory_log = 700
    c = relaunch(); scaleDeadlines(c)
    const o = openSupplies(c, JOBS.red, 'A2')
    while (!o.log.length) await sleep(10)
    ok('the saved list within the wait (no rows for this clean yet)', o.log[0].at < CARD_WAIT + 200 && Object.keys(o.screen.lines).length === 0, fmt(o.log[0].at))
    o.edit('inv-tp', { qty_used: 0, qty_remaining: '', needs_restock: true, notes: '' })
    await o.done
    ok('the live rows come: the teammate\'s towels show, her toilet paper flag stays',
      o.log.length === 2 && o.log[1].late === true && o.screen.lines['inv-towel']?.qty_used === 2 && o.screen.lines['inv-tp']?.needs_restock === true,
      `${o.log.length} show(s) ${JSON.stringify(o.screen.lines)}`)
    const plan = c.planInventorySave({ tenantId: T, jobId: 'J-red', lines: o.screen.lines, saved: o.screen.saved, catalog: server.tables.address_inventory, minted: {}, newId: () => 'new-1' })
    const written = plan.upserts.flat()
    ok('her save adds her line and leaves the teammate\'s row alone (no delete, no rewrite)',
      plan.deleteIds.length === 0 && written.length === 1 && written[0].inventory_id === 'inv-tp' && written[0].id === 'new-1',
      JSON.stringify({ del: plan.deleteIds, up: written.map((r: any) => `${r.id}:${r.inventory_id}`) }))

    // She saves before the live answer comes: it may predate the save, so
    // it isn't shown (the list stays as she saved it).
    const o2 = openSupplies(c, JOBS.red, 'A2')
    while (!o2.log.length) await sleep(10)
    o2.card.saving()
    await o2.done
    ok('a save before the live answer: that answer is not shown', o2.log.length === 1, `${o2.log.length} show(s)`)
  },

  // Whatever goes wrong inside a load, Supplies' and the walkthrough's
  // spinners go.
  async spinnersAlwaysClear() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    server.mode = 'offline'
    // Queued writes with no values (no code path queues one; they stand for
    // any bug in a load).
    store.set('writeOutbox', JSON.stringify([
      { id: 'bad1', table: 'job_inventory_log', op: 'upsert', values: null, created_at: 0 },
      { id: 'bad2', table: 'job_checklist_items', op: 'upsert', values: null, created_at: 0 },
    ]))
    c = relaunch(); scaleDeadlines(c)
    const settle = (done: Promise<number>) => Promise.race([
      done.then(() => 'done', (e: any) => `threw: ${e?.message || e}`), sleep(3 * READ_DEADLINE).then(() => 'still loading')])
    const sp = openSupplies(c, JOBS.red, 'A2')
    const e1 = await settle(sp.done)
    ok('Supplies: a load that throws ends, its spinner down', e1 === 'done' && sp.spinner.length > 0 && !sp.spinnerOn(), `${e1} ${JSON.stringify(sp.spinner.map(x => x.on))}`)
    const w = openWalk(c, JOBS.chapel, { soon: true })
    const e2 = await settle(w.done)
    ok('the walkthrough: a load that throws ends, its spinner down', e2 === 'done' && !w.spinnerOn(), `${e2} ${JSON.stringify(w.spinner.map(x => x.on))}`)
    store.delete('writeOutbox')
  },

  // ── The walkthrough (lib/walkthroughCard) ───────────────────────────────
  async walkthroughOnAHangingLink() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    server.mode = 'hang'
    c = relaunch(); scaleDeadlines(c)
    const o = openWalk(c, JOBS.chapel, { soon: true })
    const doneAt = await o.done
    ok('the spinner gives way within the wait, not after a read deadline', o.offAt() != null && o.offAt()! < CARD_WAIT + 400, `${fmt(o.offAt())} (deadline ${READ_DEADLINE} ms)`)
    ok('...showing the saved lines and the trash day', o.log[0]?.v?.lines?.length === 2 && JSON.stringify(o.log[0]?.v?.pickupDays) === '[2]')
    ok('the load ends after one read deadline, spinner down', doneAt < 2 * READ_DEADLINE && !o.spinnerOn(), fmt(doneAt))
  },

  // A trickle: Ali answered the windows this morning. Saved lines first, then
  // his answer. An answer she gives while a live answer is on its way keeps
  // that answer off the card; a reload on a dead link keeps what's shown.
  async walkthroughTrickle() {
    setClock(EVENING); seedServer(); seedSession()
    let c = load()
    await c.prefetchDays(CREW)
    setClock(MORNING); seedSession()
    server.tables.job_checklist_items.find((r: any) => r.id === 'wt1').result = 'ok'
    server.slow.job_checklist_items = 700
    c = relaunch(); scaleDeadlines(c)
    const res = (v: any, id: string) => v?.lines?.find((l: any) => l.id === id)?.result ?? null
    const o = openWalk(c, JOBS.chapel, { soon: true })
    await o.done
    ok('the saved lines within the wait, then Ali\'s answer',
      o.log.length === 2 && o.log[0].at < CARD_WAIT + 200 && res(o.log[0].v, 'wt1') === null && res(o.log[1].v, 'wt1') === 'ok',
      o.log.map(x => `${fmt(x.at)} wt1=${res(x.v, 'wt1')}`).join(' → '))
    const o2 = openWalk(c, JOBS.chapel, { soon: true })
    while (!o2.log.length) await sleep(10)
    o2.card.edited()
    await o2.done
    ok('a late answer never overwrites an answer she gave since the load began', o2.log.length === 1, `${o2.log.length} show(s)`)
    // Back from the photo screen as the link dies; the phone's copy is older.
    server.mode = 'hang'
    store.set('dataCache:wtlines:J-chapel', JSON.stringify(cachedVal('wtlines:J-chapel').map((l: any) => ({ ...l, result: null }))))
    const n = o2.log.length
    await o2.card.load(JOBS.chapel)
    ok('a reload on a dead link never steps back to the saved copy', o2.log.length === n && !o2.spinnerOn(), `${o2.log.length - n} show(s)`)
  },

}

// ── The checklist card (lib/checklistCard), as JobDetailScreen mounts it ─────
// Deadlines scaled 10:1 so a scenario takes seconds: a read gives up after
// 1.5 s (the app: 15 s) and the card waits 0.3 s for a live answer (3 s).
const READ_DEADLINE = 1500
/** Writes, RPCs (the app: 30 s). */
const WRITE_DEADLINE = 3000
const CARD_WAIT = 300
const DEFAULTS = [{ id: '1', room: 'Kitchen', title: 'General clean' }, { id: '2', room: 'Bathroom', title: 'General clean' }]
const fmt = (ms: number | null | undefined) => (ms == null ? 'never' : `${Math.round(ms)} ms`)

function scaleDeadlines(c: any) {
  c.NET_TIMEOUTS.read = READ_DEADLINE
  c.NET_TIMEOUTS.write = WRITE_DEADLINE
  c.CHECKLIST_WAIT.ms = CARD_WAIT
  c.STOP_DETAILS_WAIT.ms = CARD_WAIT
  c.CHECK_FIRST_WAIT.ms = CARD_WAIT
  c.TIME_TRACKER_WAIT.ms = CARD_WAIT
  c.STOP_INFO_WAIT.ms = CARD_WAIT
  c.PHOTO_COUNT_WAIT.ms = CARD_WAIT
  c.SUPPLIES_WAIT.ms = CARD_WAIT
  c.WALKTHROUGH_WAIT.ms = CARD_WAIT
}

/** Open the stop's screen: a new card, its first load, every show and every
 *  spinner change timed from the open. */
function open(c: any, job: any, addressId: string | null) {
  const t0 = performance.now()
  const log = { shows: [] as { at: number; v: any }[], spinner: [] as { at: number; on: boolean }[] }
  const card = c.checklistCard({
    show: (v: any) => { log.shows.push({ at: performance.now() - t0, v }) },
    setLoading: (on: boolean) => { log.spinner.push({ at: performance.now() - t0, on }) },
  })
  const done: Promise<number> = card.load(job, CREW, addressId, DEFAULTS).then(() => performance.now() - t0)
  return {
    card, log, done,
    /** When the spinner first went down. */
    offAt: () => log.spinner.find(s => !s.on)?.at ?? null,
    spinnerOn: () => log.spinner.length > 0 && log.spinner[log.spinner.length - 1].on,
  }
}

// ── The stop's details (lib/stopDetails) and Check first card (lib/checkFirstCard) ──
const names = (rows: any) => (Array.isArray(rows) ? rows.map((a: any) => a.users?.full_name).join() : '')

/** The details' first load, as JobDetailScreen starts it on opening: every
 *  hand-over timed from the open. */
function openDetails(c: any, job: any) {
  const t0 = performance.now()
  const log: { kind: string; at: number; v: any; flags?: boolean }[] = []
  const at = () => performance.now() - t0
  const details = c.stopDetails({
    job: (v: any, flags: boolean) => { log.push({ kind: 'job', at: at(), v, flags }) },
    crew: (v: any) => { log.push({ kind: 'crew', at: at(), v }) },
    roster: (v: any) => { log.push({ kind: 'roster', at: at(), v }) },
    property: (v: any) => { log.push({ kind: 'property', at: at(), v }) },
  })
  const done: Promise<number> = details.load(job).then(() => at())
  return {
    details, log, done,
    shows: (kind: string) => log.filter(e => e.kind === kind),
    first: (kind: string) => log.find(e => e.kind === kind),
  }
}

/** A Check first load: each view the card shows, timed from the call. */
function openCheckFirst(c: any, job: any, opts: { soon?: boolean } = {}) {
  const t0 = performance.now()
  const log: { at: number; v: any }[] = []
  const card = c.checkFirstCard({ show: (v: any) => { log.push({ at: performance.now() - t0, v }) } })
  const first: Promise<any> = card.load(job, CREW, opts)
  return { card, log, first }
}

// ── The time tracker, the stop's info, the counter, Supplies, the walkthrough ──
const runningIds = (rows: any) => (Array.isArray(rows) ? rows : []).filter((e: any) => !e.clocked_out_at).map((e: any) => e.id).join()
const countStr = (x: any) => (x ? `${x.done}/${x.total} owed=${x.owed ? [...x.owed].join('|') || '∅' : 'null'}` : 'none')

function timeEntry(id: string, user: string, inAt: string, outAt: string | null = null, extra: any = {}) {
  return {
    id, tenant_id: T, job_id: 'J-red', user_id: user, clocked_in_at: at(inAt), clocked_out_at: outAt,
    pause_reason: null, duration_minutes: null, entry_type: 'work', source: 'manual',
    users: { full_name: NAMES[user] }, ...extra,
  }
}
function photoRow(id: string, job: string, extra: any = {}) {
  return { id, job_id: job, caption: null, checklist_item_id: null, photo_requirement_id: null, check_first_line_id: null,
    photo_url: `https://example.com/${id}.jpg`, created_at: new Date().toISOString(), ...extra }
}
function logRow(id: string, job: string, inv: string, name: string, extra: any = {}) {
  return { id, job_id: job, inventory_id: inv, item_name: name, qty_used: 0, qty_remaining: null, needs_restock: false,
    notes: null, incident_id: null, restocked_at: null, client_notified_at: null, created_at: new Date().toISOString(),
    jobs: { address_id: 'A2' }, ...extra }
}

/** The screen's tracker: every show, timed from when it was made. */
function tracking(c: any) {
  const t0 = performance.now()
  const log: { at: number; rows: any[] }[] = []
  const tr = c.timeTracker({ show: (rows: any[]) => { log.push({ at: performance.now() - t0, rows }) } })
  return { tr, log, now: () => performance.now() - t0, last: () => log[log.length - 1]?.rows ?? [] }
}

function openInfo(c: any, job: any, user: any) {
  const t0 = performance.now()
  const log: { kind: string; at: number; v: any }[] = []
  const at = () => performance.now() - t0
  const ui: any = {}
  for (const k of ['note', 'acks', 'nextArrival', 'routeStop', 'video']) ui[k] = (v: any) => { log.push({ kind: k, at: at(), v }) }
  const info = c.stopInfo(ui)
  const done: Promise<number> = info.load(job, user).then(() => at())
  return { info, log, done, first: (k: string) => log.find(e => e.kind === k), shows: (k: string) => log.filter(e => e.kind === k) }
}

function counting(c: any) {
  const t0 = performance.now()
  const log: { at: number; c: any }[] = []
  const counter = c.requiredPhotoCount({ show: (x: any) => { log.push({ at: performance.now() - t0, c: x }) } })
  return {
    counter, log,
    load: (job: any, user: any, opts: any = {}) => { const from = performance.now(); return counter.load(job, user, opts).then(() => performance.now() - from) },
  }
}

/** The Supplies screen: its lines and baseline as JobInventoryScreen keeps them. */
function openSupplies(c: any, job: any, addrId: string) {
  const t0 = performance.now()
  const at = () => performance.now() - t0
  const log: { at: number; v: any; late: boolean }[] = []
  const spinner: { at: number; on: boolean }[] = []
  const screen = { lines: {} as Record<string, any>, saved: {} as Record<string, any>, edited: new Set<string>() }
  const card = c.suppliesCard({
    show: (v: any, late: boolean) => {
      log.push({ at: at(), v, late })
      screen.saved = v.saved
      if (late) { screen.lines = c.rebaseLines(v.lines, screen.lines, screen.edited); return }
      screen.edited = new Set()
      screen.lines = v.lines
    },
    setLoading: (on: boolean) => { spinner.push({ at: at(), on }) },
  })
  const done: Promise<number> = card.load(job, addrId).then(() => at())
  return {
    card, log, spinner, screen, done,
    edit: (inv: string, line: any) => { screen.edited.add(inv); screen.lines = { ...screen.lines, [inv]: line } },
    offAt: () => spinner.find(s => !s.on)?.at ?? null,
    spinnerOn: () => spinner.at(-1)?.on ?? true,
  }
}

/** The walkthrough card (its spinner starts on, as WalkthroughChecklist's does). */
function openWalk(c: any, job: any, opts: { soon?: boolean } = {}) {
  const t0 = performance.now()
  const at = () => performance.now() - t0
  const log: { at: number; v: any }[] = []
  const spinner: { at: number; on: boolean }[] = []
  const card = c.walkthroughCard({ show: (v: any) => { log.push({ at: at(), v }) }, setLoading: (on: boolean) => { spinner.push({ at: at(), on }) } })
  const done: Promise<number> = card.load(job, opts).then(() => at())
  return {
    card, log, spinner, done,
    offAt: () => spinner.find(s => !s.on)?.at ?? null,
    spinnerOn: () => spinner.at(-1)?.on ?? true,
  }
}

let finished = false
process.on('exit', () => {
  if (!finished) { console.log('FAIL  scenario never finished (a request hung with nothing to end it)'); process.exitCode = 1 }
})

;(async () => {
  const name = process.argv[2]
  const run = scenarios[name]
  if (!run) { console.log(`unknown scenario ${name}; have: ${Object.keys(scenarios).join(', ')}`); process.exit(2) }
  console.log(`\n── ${name}`)
  try { await run() } catch (e: any) { failures++; console.log(`FAIL  threw: ${e?.stack || e}`) }
  finished = true
  process.exit(failures ? 1 : 0)
})()
