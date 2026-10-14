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

const ADDR: Record<string, any> = {
  A1: { id: 'A1', street: '1 Uptown Rd', nickname: 'Uptown', lockbox_code: '1111', arrival_instructions: null },
  A2: { id: 'A2', street: '20 Red Rock Ln', nickname: 'Red Rock Casita', lockbox_code: '4321', arrival_instructions: 'Side gate, gate code 1122. Key in the lockbox by the hose.' },
  A3: { id: 'A3', street: '3 Chapel Rd', nickname: 'Chapel View', lockbox_code: '7777', arrival_instructions: 'Front door keypad.' },
  A4: { id: 'A4', street: '4 Oak Creek Dr', nickname: 'Oak Creek', lockbox_code: '9999', arrival_instructions: 'Owner on site.' },
  A5: { id: 'A5', street: '5 Bell Rock Blvd', nickname: 'Bell Rock', lockbox_code: '5555', arrival_instructions: null },
}
const addressRow = (a: any) => ({
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
    crew_note: null, crew_note_at_clock_in: false,
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
    tenants: [{ id: T, video_walkthroughs_enabled: false, default_checkin_time: '16:00', default_checklist_seed: 'generated', checklist_execution_mode: 'detailed', crew_prep_linens: true }],
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
    job_time_entries: [], job_room_signoffs: [], job_photos: [], job_crew_note_acks: [],
  }
}

// ── Mock Supabase server ────────────────────────────────────────────────────
const server = {
  mode: 'online' as 'online' | 'offline',
  tables: {} as Record<string, any[]>,
  rest: [] as { method: string; table: string; params: URLSearchParams }[],
  /** ms each answer takes, so concurrency is observable. */
  delayMs: 5,
  inflight: 0,
  maxInflight: 0,
  /** Go offline after this many REST answers (signal lost mid-run). */
  failAfter: null as number | null,
  other: [] as string[],
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
;(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (server.mode === 'offline') throw new TypeError('Network request failed')
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
    await sleep(server.delayMs)
    if (server.failAfter != null && server.rest.length > server.failAfter) {
      server.mode = 'offline'
      throw new TypeError('Network request failed')
    }
    if (method !== 'GET') return new Response('', { status: 201, headers: { date } })
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
    }
    const got: Record<string, any> = {}
    const missing: string[] = []
    for (const [name, r] of Object.entries(screen)) {
      got[name] = await c.cachedRead(r)
      if (!got[name].fromCache) missing.push(`${name} (${r.key})`)
    }
    ok('every read the stop\'s screen makes comes back from the phone', missing.length === 0, missing.join(', ') || `${Object.keys(screen).length} reads`)
    ok('the door code', got.propmeta.data?.lockbox_code === '4321', String(got.propmeta.data?.lockbox_code))
    ok('the arrival instructions', /gate code 1122/.test(got.propmeta.data?.arrival_instructions || ''), String(got.propmeta.data?.arrival_instructions))
    ok('the checklist, in room order', (got.chkrows.data || []).map((r: any) => r.task).join('|') === 'Scrub tub|Make beds|Wipe counters',
      (got.chkrows.data || []).map((r: any) => r.task).join('|'))
    ok('the checklist template behind it', (got.tmpl.data || []).length === 2)
    ok('the office\'s note', got.crewnote.data?.crew_note === 'Guest left early — check the patio.')
    ok('who is on it', (got.crew.data || []).some((a: any) => a.users?.full_name === 'Nichole'))
    ok('the next arrival', (got.nextarr.data || []).some((r: any) => r.guest_name === 'Rivera'))
    ok('"Stop 1 of 2"', (got.route.data || []).length === 2, ids(got.route.data || []))
    ok('supplies, with the office\'s extra linen', (got.invItems.data || []).length === 2 && got.invExtras.data?.[0]?.extra_qty === 2)

    // The walkthrough clean's walkthrough (WalkthroughChecklist).
    const chapel = day.jobs.find((j: any) => j.id === 'J-chapel')
    const wt = await c.cachedRead(R.walkthroughLinesRead(chapel.id))
    ok('the walkthrough clean: its lines', wt.fromCache && (wt.data || []).length === 2, String((wt.data || []).length))

    // "Get ready for today" (PrepCard), over Home's day.
    const prep = R.prepReads(CREW, R.prepJobs(day.jobs), c.todayKey())
    const [pa, pl, pr] = [await c.cachedRead(prep.addresses), await c.cachedRead(prep.linen), await c.cachedRead(prep.stays)]
    ok('the prep card: door codes, linens, arrivals',
      pa.fromCache && (pa.data || []).some((a: any) => a.lockbox_code === '4321') && pl.fromCache && (pl.data || []).length === 1 && pr.fromCache,
      `addr ${pa.fromCache}/${(pa.data || []).length} linen ${pl.fromCache}/${(pl.data || []).length} stays ${pr.fromCache}`)
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
