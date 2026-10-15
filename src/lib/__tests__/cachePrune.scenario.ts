// Offline cache pruning scenario test. Run with: node scripts/test-cache-prune.mjs
//
// Exercises the REAL src/lib/cachePrune.ts, jobReads.ts, dataCache.ts,
// outbox.ts, photoQueue.ts, videoQueue.ts, crewNote.ts and timezone.ts on top
// of the REAL supabase-js that ships in the app. Native modules are stubs
// (offlineAuth.mocks.ts, stubs/expo-file-system). The clock is faked so a
// scenario can open a stop on Oct 1 and prune on Oct 13.
//
// The failure this guards against: the read cache never dropped a stop, so a
// phone used for months fills Android's 6 MB AsyncStorage, and then the
// outbox, the photo queue and the sign-in can't be saved either. And the
// opposite: a prune that throws away a stop the crew member still needs with
// no signal (today's, tomorrow's, one still open, one with work waiting to send).
//
// Each scenario runs in its own Node process, started by the runner with the
// scenario name as argv[2].

const h: any = ((globalThis as any).__harness = (globalThis as any).__harness ?? {})
// The phone's AsyncStorage (offlineAuth.mocks.ts reads and writes this map).
// A scenario can act at the moment a key is read (onRead).
const onRead = new Map<string, () => void>()
class PhoneStore extends Map<string, string> {
  get(k: string) { const f = onRead.get(k); if (f) { onRead.delete(k); f() } return super.get(k) }
}
const store: Map<string, string> = (h.store = h.store ?? new PhoneStore())
console.error = () => {}
console.warn = () => {}

// ── Clock ───────────────────────────────────────────────────────────────────
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
/** Noon in Sedona on a YYYY-MM-DD (Arizona keeps no DST: UTC-7). */
const noon = (ymd: string) => `${ymd}T19:00:00.000Z`
/** That day, at `hour` o'clock in Sedona. */
const setDay = (ymd: string, hour = 12) => { skewMs = RealDate.parse(`${ymd}T00:00:00.000Z`) + (hour + 7) * 3600_000 - RealDate.now() }
const TZ = 'America/Phoenix'
const ymdPlus = (ymd: string, n: number) => { const d = new RealDate(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

// ── A signed-in phone ───────────────────────────────────────────────────────
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const AUTH_USER = { id: 'auth-u1', aud: 'authenticated', role: 'authenticated', email: 'crew@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
const jwt = (expSec: number) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: AUTH_USER.id, exp: expSec, role: 'authenticated', aud: 'authenticated' })}.sig`
const seedSession = () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  store.set('sb-cbnbhwclbtowfbjylnph-auth-token', JSON.stringify({ access_token: jwt(exp), refresh_token: 'rt-0', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: AUTH_USER }))
}

// ── Network: on or off; writes always land ──────────────────────────────────
const net = { mode: 'online' as 'online' | 'offline', writes: 0 }
;(globalThis as any).fetch = async (input: any, init: any = {}) => {
  if (net.mode === 'offline') throw new TypeError('Network request failed')
  const url = new URL(typeof input === 'string' ? input : input.url)
  const json = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (url.pathname.startsWith('/auth/')) return json(200, {})
  if (String(init.method || 'GET').toUpperCase() !== 'GET') { net.writes++; return new Response('', { status: 201 }) }
  return json(200, [])
}

// ── The company ─────────────────────────────────────────────────────────────
const T = 't-cks'
const U = 'u-crew'
const CREW = { id: U, tenant_id: T, role: 'cleaner', full_name: 'Nichole', _timeMode: 'per_job' }

/** A job row the way Home / Schedule / Needs closing carry it. */
function job(id: string, ymd: string, prop: string | null, extra: any = {}) {
  return {
    id, tenant_id: T, status: 'scheduled', scheduled_start: noon(ymd), route_order: 1, job_type: 'clean',
    address_id: prop, client_addresses: prop ? { id: prop, street: `${prop} Rd` } : null,
    job_assignments: [{ user_id: U }], ...extra,
  }
}

// Every key one stop leaves on the phone, written out here rather than taken
// from the app, so a key the pruner doesn't know about can't hide.
const STOP_KEYS = (J: string) => [
  `chkrows:${J}`, `jobmeta:${J}`, `crew:${J}`, `crewclock:${J}`, `time:${J}:${U}`, `time:${J}:job`,
  `photos:${J}`, `pshot:${J}`, `signoffs:${J}`, `inv:log:${J}`, `inv:extras:${J}`, `nextarr:${J}`,
  `route:${J}:${U}`, `crewnote:${J}`, `crewnoteack:${J}:${U}`, `crewNoteAck:${J}:${U}`, `wtlines:${J}`, `wtphotos:${J}`,
  `cfticks:${J}`, `cfphotos:${J}`, `cfstart:${J}`,
]
const PROPERTY_KEYS = (A: string) => [
  `tmpl:${A}`, `rooms:${A}`, `addrmode:${A}`, `preq:${A}`, `propmeta:${A}`,
  `inv:items:${A}`, `inv:rooms:${A}`, `wttrash:${A}`, `nextarr:addr:${A}`, `cflines:${A}`,
]
// Per user / per company / per day, and the phone's other stores: never touched.
const OTHER_KEYS = [
  `dataCache:dash:today:${U}`, `dataCache:dash:month:${U}`, `dataCache:dash:pay:${U}`, `dataCache:dash:shift:${U}`,
  `dataCache:sched:${U}`, `dataCache:track:open:${U}`, `dataCache:track:mode:${T}`, `dataCache:openjobs:${T}`,
  `dataCache:tenvideo:${T}`, `dataCache:tenseed:${T}`, `dataCache:tenmode:${T}`, `dataCache:nextarr:ten:${T}`,
  `dataCache:cften:${T}`, `dataCache:prep:ten:${T}`, `dataCache:prep:addr:${U}:2026-10-13`, `dataCache:prep:cflines:${U}:2026-10-13`, `dataCache:daypack:${U}`, `dataCache:crewNoteAckPending`,
  'writeOutbox', 'writeOutboxRejected', 'rinsebase.photoQueue.v1', 'language', `jobScope:${U}`, `prep:${U}:2026-09-01`,
  'arrival:J-old', 'mt:es:abc:12',
]

const put = (key: string, bytes = 40) => store.set(`dataCache:${key}`, JSON.stringify('x'.repeat(bytes)))
const has = (key: string) => store.has(`dataCache:${key}`)
/** A stop as the phone holds it after it was opened: its keys and its property's. */
function seedStop(j: any) {
  STOP_KEYS(j.id).forEach(k => put(k))
  if (j.address_id) PROPERTY_KEYS(j.address_id).forEach(k => put(k))
}
const allThere = (keys: string[]) => keys.filter(k => !has(k))
const allGone = (keys: string[]) => keys.filter(k => has(k))
/** Home saved its Needs closing list (DashboardScreen does on every load). */
const needsClosing = (rows: any[]) => store.set(`dataCache:dash:stranded:${U}`, JSON.stringify(rows))
const seedOthers = () => OTHER_KEYS.forEach(k => { if (!store.has(k)) store.set(k, JSON.stringify(k.includes('Outbox') || k.includes('Queue') || k.includes('Pending') ? [] : 'keep')) })
const othersIntact = () => OTHER_KEYS.filter(k => !store.has(k))

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function load() {
  const c = require(process.env.CLIENT_BUNDLE as string)
  c.setCurrentTz(TZ)
  return c
}
/** Kill the app and open it again: fresh module state, same phone storage. */
function relaunch() {
  delete require.cache[require.resolve(process.env.CLIENT_BUNDLE as string)]
  return load()
}

// ── Scenarios ───────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {

  // Every builder in jobReads: its keys belong to the job they name, else the
  // property they name, else to neither. A new builder must be added below.
  async everyKeyHasItsOwner() {
    setDay('2026-10-13'); seedSession()
    const c = load()
    const R = c.reads
    const J = 'job-7f3a', A = 'prop-91c2'
    const j = job(J, '2026-10-13', A)
    const BUILDERS: Record<string, () => any> = {
      dashTodayRead: () => R.dashTodayRead(CREW, new Date()),
      tenantVideoRead: () => R.tenantVideoRead(T),
      routeStopRead: () => R.routeStopRead(j, CREW),
      nextArrivalReads: () => R.nextArrivalReads(j, A, T),
      crewNoteRead: () => R.crewNoteRead(J),
      crewNoteAckRead: () => R.crewNoteAckRead(J, U),
      jobMetaRead: () => R.jobMetaRead(J),
      jobCrewRead: () => R.jobCrewRead(J),
      propMetaRead: () => R.propMetaRead(A),
      crewClockRead: () => R.crewClockRead(J),
      timeEntriesRead: () => [R.timeEntriesRead(J, U, false), R.timeEntriesRead(J, U, true)],
      checklistTemplateRead: () => R.checklistTemplateRead(A),
      checklistRowsRead: () => R.checklistRowsRead(J),
      tenantSeedRead: () => R.tenantSeedRead(T),
      roomsRead: () => R.roomsRead(A),
      roomSignoffsRead: () => R.roomSignoffsRead(J),
      addressModeRead: () => R.addressModeRead(A),
      tenantModeRead: () => R.tenantModeRead(T),
      photoRequirementsRead: () => R.photoRequirementsRead(A),
      requirementShotsRead: () => R.requirementShotsRead(J),
      itemPhotosRead: () => R.itemPhotosRead(J),
      checkFirstLinesRead: () => R.checkFirstLinesRead(A),
      checkFirstTicksRead: () => R.checkFirstTicksRead(J),
      checkFirstPhotosRead: () => R.checkFirstPhotosRead(J),
      checkFirstStartRead: () => R.checkFirstStartRead(J),
      checkFirstTenantRead: () => R.checkFirstTenantRead(T),
      inventoryItemsRead: () => R.inventoryItemsRead(A),
      inventoryLogRead: () => R.inventoryLogRead(J),
      inventoryRoomsRead: () => R.inventoryRoomsRead(A),
      linenExtrasRead: () => R.linenExtrasRead(J),
      walkthroughLinesRead: () => R.walkthroughLinesRead(J),
      walkthroughPhotosRead: () => R.walkthroughPhotosRead(J),
      trashDaysRead: () => R.trashDaysRead(A),
      prepReads: () => R.prepReads(CREW, [j], '2026-10-13'),
      jobPackReads: () => [
        ...R.jobPackReads(j, CREW),
        ...R.jobPackReads({ ...j, job_type: 'inspection' }, { ...CREW, _timeMode: 'daily' }),
      ],
    }
    const exported = Object.keys(R).filter(n => /Reads?$/.test(n) && typeof R[n] === 'function')
    const untested = exported.filter(n => !(n in BUILDERS))
    ok('every read builder in jobReads is checked here', untested.length === 0, untested.length ? `add: ${untested.join(', ')}` : `${exported.length} builders`)

    const keys = new Set<string>()
    for (const make of Object.values(BUILDERS)) {
      const out = make()
      const list = Array.isArray(out) ? out : out?.key ? [out] : Object.values(out)
      list.forEach((r: any) => keys.add(r.key))
    }
    // "Got it" remembered on this device (lib/crewNote), through its own API.
    const before = new Set(store.keys())
    await c.rememberAck(J, U, 'Back gate sticks.')
    const ackKey = [...store.keys()].find(k => !before.has(k))
    ok('the crew-note "Got it" is kept under the cache prefix', !!ackKey?.startsWith('dataCache:'), String(ackKey))
    if (ackKey) keys.add(ackKey.slice('dataCache:'.length))

    const wrong: string[] = []
    for (const k of keys) {
      const want = k.includes(J) ? { job: J } : k.includes(A) ? { property: A } : null
      const got = R.cacheKeyOwner(k)
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${k} → ${JSON.stringify(got)}`)
    }
    ok('each key belongs to the job it names, else the property, else neither', wrong.length === 0, wrong.join('; ') || `${keys.size} keys`)
    const stopKeys = [...keys].filter(k => k.includes(J)).sort()
    ok('the keys a stop leaves are exactly the ones these scenarios seed',
      JSON.stringify(stopKeys) === JSON.stringify(STOP_KEYS(J).sort()),
      `app: ${stopKeys.filter(k => !STOP_KEYS(J).includes(k)).join(',')} / here: ${STOP_KEYS(J).filter(k => !stopKeys.includes(k)).join(',')}`)
    const propKeys = [...keys].filter(k => !k.includes(J) && k.includes(A)).sort()
    ok('...and the property\'s', JSON.stringify(propKeys) === JSON.stringify(PROPERTY_KEYS(A).sort()), propKeys.join(','))
    const others = OTHER_KEYS.filter(k => k.startsWith('dataCache:')).map(k => k.slice(10)).concat(['cachedJobs', 'crewNoteAckPending'])
    ok('Home, Schedule, company and per-day keys belong to no stop', others.every(k => R.cacheKeyOwner(k) === null),
      others.filter(k => R.cacheKeyOwner(k) !== null).join(','))
  },

  // Two weeks of use: what is a week old and done goes; what is current stays.
  async dropsStopsAWeekGone() {
    seedSession()
    let c = load()
    const old = job('J-old', '2026-10-01', 'A-old')
    const shared = job('J-shared', '2026-10-01', 'A-shared')
    const edge = job('J-edge', '2026-10-06', 'A-edge')        // exactly a week back
    const past = job('J-past', '2026-10-05', 'A-past')        // a week and a day back
    const today = job('J-today', '2026-10-13', 'A-shared')
    const tomorrow = job('J-tom', '2026-10-14', 'A-new')
    // Opened on their day.
    for (const j of [old, shared, past, edge]) {
      setDay(j.scheduled_start.slice(0, 10), 8)
      await c.noteCachedJobs([j]); seedStop(j)
    }
    setDay('2026-10-13', 19)
    c = relaunch()
    await c.noteCachedJobs([today, tomorrow]); seedStop(today); seedStop(tomorrow)
    seedOthers(); needsClosing([])

    const res = await c.pruneJobCache(CREW, [today, tomorrow])
    ok('prunes', res.status === 'pruned', JSON.stringify(res))
    ok('a stop 12 days back: every key gone', allGone(STOP_KEYS('J-old')).length === 0, allGone(STOP_KEYS('J-old')).join(','))
    ok('...and its property\'s, no stop kept there', allGone(PROPERTY_KEYS('A-old')).length === 0)
    ok('a stop 8 days back: gone', allGone(STOP_KEYS('J-past')).length === 0 && allGone(PROPERTY_KEYS('A-past')).length === 0)
    ok('a stop exactly a week back: kept', allThere(STOP_KEYS('J-edge')).length === 0 && allThere(PROPERTY_KEYS('A-edge')).length === 0)
    ok('an old stop at a property visited today: its keys go, the property\'s stay',
      allGone(STOP_KEYS('J-shared')).length === 0 && allThere(PROPERTY_KEYS('A-shared')).length === 0)
    ok('today\'s and tomorrow\'s stops: everything kept',
      allThere([...STOP_KEYS('J-today'), ...STOP_KEYS('J-tom'), ...PROPERTY_KEYS('A-new')]).length === 0)
    ok('nothing else on the phone touched', othersIntact().length === 0, othersIntact().join(','))
    const idx = await c.readCacheEntry('cachedJobs')
    ok('the index forgets the dropped stops, keeps the rest',
      !idx['J-old'] && !idx['J-shared'] && !idx['J-past'] && !!idx['J-edge'] && !!idx['J-today'] && !!idx['J-tom'], Object.keys(idx).join(','))
    ok('it reports what it did', res.stops === 3 && res.properties === 2 && res.keys === 3 * STOP_KEYS('x').length + 2 * PROPERTY_KEYS('x').length, JSON.stringify(res))
  },

  // Old stops a crew member may still need with no signal.
  async keepsWhatMayStillBeNeeded() {
    seedSession()
    let c = load()
    const stuck = job('J-stuck', '2026-09-20', 'A-stuck', { status: 'in_progress' })   // Needs closing
    const photo = job('J-photo', '2026-09-21', 'A-photo')
    const video = job('J-video', '2026-09-22', 'A-video')
    const ack = job('J-ack', '2026-09-23', 'A-ack')
    const reopened = job('J-reopened', '2026-09-01', 'A-reopened')
    const ahead = job('J-ahead', '2026-10-20', 'A-ahead')                        // opened Sept 25, not since
    const pack = job('J-pack', '2026-09-24', 'A-pack')                           // in the day pack's set (moved since)
    for (const j of [stuck, photo, video, ack, reopened, pack]) {
      setDay(j.scheduled_start.slice(0, 10), 8)
      await c.noteCachedJobs([j]); seedStop(j)
    }
    setDay('2026-09-25', 8)
    await c.noteCachedJobs([ahead]); seedStop(ahead)

    // Work waiting to send: a photo, a video, a "Got it" given with no signal.
    setDay('2026-10-10', 9)
    store.set('rinsebase.photoQueue.v1', JSON.stringify([{ id: 'p1', job_id: 'J-photo', localUri: 'x.jpg', fileName: 'f', tenant_id: T, user_id: U, photo_type: 'after', caption: null, visible_to_client: true, created_at: Date.now() }]))
    store.set('rinsebase.videoQueue.v1', JSON.stringify([{ id: 'v1', job_id: 'J-video', localUri: 'x.mp4', storagePath: 's', mimeType: 'video/mp4', tenant_id: T, user_id: U, video_type: 'after', duration_seconds: 30, size_bytes: 1, recorded_at: '', created_at: Date.now() }]))
    net.mode = 'offline'
    await c.recordAck(c.ackRow({ tenantId: T, jobId: 'J-ack', userId: U, note: 'Code changed to 4455.' }))
    net.mode = 'online'
    ok('the queues report what they hold',
      (await c.queuedPhotoJobIds()).join() === 'J-photo' && (await c.queuedVideoJobIds()).join() === 'J-video' && (await c.pendingAckJobIds()).join() === 'J-ack')
    // Re-opened from Schedule three days ago.
    await c.noteCachedJobs([reopened])

    // An old visit to the property of a clean someone else left open, never
    // opened on this phone: the visit goes, the door code must stay.
    setDay('2026-09-02', 8)
    const visit = job('J-visit', '2026-09-02', 'A-left')
    await c.noteCachedJobs([visit]); seedStop(visit)
    const left = job('J-left', '2026-09-30', 'A-left', { status: 'en_route' })

    setDay('2026-10-13', 19)
    c = relaunch()
    needsClosing([stuck, left]); seedOthers()
    const res = await c.pruneJobCache(CREW, [{ ...pack, scheduled_start: noon('2026-10-14') }])
    ok('prunes', res.status === 'pruned' && res.stops === 1, JSON.stringify(res))
    const kept = (j: any) => allThere([...STOP_KEYS(j.id), ...PROPERTY_KEYS(j.address_id)])
    ok('a clean still open from 3 weeks ago (Needs closing): kept', kept(stuck).length === 0, kept(stuck).join(','))
    ok('a stop with a photo waiting to upload: kept', kept(photo).length === 0)
    ok('a stop with a video waiting to upload: kept', kept(video).length === 0)
    ok('a stop with a "Got it" waiting to send: kept', kept(ack).length === 0)
    ok('a month-old stop opened again 3 days ago: kept', kept(reopened).length === 0)
    ok('next week\'s stop opened 18 days ago: kept', kept(ahead).length === 0)
    ok('a stop the day pack just saved: kept', kept(pack).length === 0)
    ok('an open clean never opened here: its property (door code) kept, the old visit there gone',
      allThere(PROPERTY_KEYS('A-left')).length === 0 && allGone(STOP_KEYS('J-visit')).length === 0)

    // Once each reason is gone, so is the stop.
    store.set('rinsebase.photoQueue.v1', '[]'); store.set('rinsebase.videoQueue.v1', '[]')
    await c.flushAcks()
    needsClosing([])
    setDay('2026-10-28', 19)
    const later = await c.pruneJobCache(CREW, [])
    const gone = (j: any) => allGone([...STOP_KEYS(j.id), ...PROPERTY_KEYS(j.address_id)])
    ok('two weeks later, nothing holding them: all gone',
      [stuck, photo, video, ack, reopened, ahead, pack].every(j => gone(j).length === 0),
      [stuck, photo, video, ack, reopened, ahead, pack].filter(j => gone(j).length).map(j => j.id).join(','))
    ok('...and nothing else', othersIntact().length === 0, othersIntact().join(','))
    ok('reported', later.status === 'pruned', JSON.stringify(later))
  },

  // A queued write may name only a checklist row or a punch: hold everything.
  async outboxHoldsEverything() {
    seedSession()
    const c = load()
    setDay('2026-10-01', 8)
    const old = job('J-old', '2026-10-01', 'A-old')
    await c.noteCachedJobs([old]); seedStop(old)
    setDay('2026-10-13', 19)
    needsClosing([])
    net.mode = 'offline'
    const w = await c.writeThrough({ table: 'job_checklist_items', op: 'update', match: { id: 'ci-1' }, values: { completed: true } })
    ok('a tick with no signal is queued', w.queued === true && (await c.pendingOpCount()) === 1)
    net.mode = 'online'
    setDay('2026-10-13', 20)   // signal back an hour later
    const held = await c.pruneJobCache(CREW, [])
    ok('the outbox holds something: nothing dropped', held.status === 'held' && held.reason === 'outbox' && allThere(STOP_KEYS('J-old')).length === 0, JSON.stringify(held))
    await c.flushOutbox()
    ok('the tick syncs', (await c.pendingOpCount()) === 0 && net.writes === 1)
    const res = await c.pruneJobCache(CREW, [])
    ok('then the old stop goes', res.status === 'pruned' && allGone(STOP_KEYS('J-old')).length === 0, JSON.stringify(res))
  },

  // Without Home's Needs closing list an old open clean can't be told apart.
  async noNeedsClosingListNoPrune() {
    seedSession()
    const c = load()
    setDay('2026-10-01', 8)
    const old = job('J-old', '2026-10-01', 'A-old')
    await c.noteCachedJobs([old]); seedStop(old)
    setDay('2026-10-13', 19)
    const res = await c.pruneJobCache(CREW, [])
    ok('held, nothing dropped', res.status === 'held' && res.reason === 'no-needs-closing' && allThere(STOP_KEYS('J-old')).length === 0, JSON.stringify(res))
    needsClosing([])
    const again = await c.pruneJobCache(CREW, [])
    ok('once Home has saved it: pruned', again.status === 'pruned' && allGone(STOP_KEYS('J-old')).length === 0, JSON.stringify(again))
  },

  // A phone updated with months of keys and no index: a week's grace, then gone.
  async keysFromBeforeTheIndexGetAWeek() {
    seedSession()
    const c = load()
    const legacy = ['J-l1', 'J-l2', 'J-l3']
    legacy.forEach((id, i) => { STOP_KEYS(id).forEach(k => put(k)); PROPERTY_KEYS(`A-l${i}`).forEach(k => put(k)) })
    const reopened = job('J-l3', '2026-08-02', 'A-l2')
    setDay('2026-10-13', 19)
    needsClosing([]); seedOthers()
    const first = await c.pruneJobCache(CREW, [])
    ok('first prune after the update: nothing dropped', first.status === 'pruned' && first.keys === 0,
      JSON.stringify(first))
    ok('their keys are all still there', legacy.every(id => allThere(STOP_KEYS(id)).length === 0))
    setDay('2026-10-15', 19)
    await c.noteCachedJobs([reopened])   // opened again from Schedule
    setDay('2026-10-19', 19)
    const mid = await c.pruneJobCache(CREW, [])
    ok('6 days on: still kept', mid.keys === 0 && legacy.every(id => allThere(STOP_KEYS(id)).length === 0), JSON.stringify(mid))
    setDay('2026-10-21', 19)
    const res = await c.pruneJobCache(CREW, [])
    ok('8 days on: the untouched ones go', allGone([...STOP_KEYS('J-l1'), ...STOP_KEYS('J-l2')]).length === 0, JSON.stringify(res))
    ok('the one opened again stays, with its property', allThere([...STOP_KEYS('J-l3'), ...PROPERTY_KEYS('A-l2')]).length === 0)
    ok('properties no kept stop is at: gone', allGone([...PROPERTY_KEYS('A-l0'), ...PROPERTY_KEYS('A-l1')]).length === 0)
    ok('nothing else touched', othersIntact().length === 0, othersIntact().join(','))
  },

  // A kept stop whose property the phone can't name keeps every property.
  async unknownPropertyKeepsProperties() {
    seedSession()
    const c = load()
    setDay('2026-10-01', 8)
    const old = job('J-old', '2026-10-01', 'A-old')
    await c.noteCachedJobs([old]); seedStop(old)
    setDay('2026-10-13', 19)
    // A row with a street but no property id: the stop's screen looks it up by street.
    const odd = { ...job('J-odd', '2026-10-13', null), client_addresses: { street: '9 Unknown Way' } }
    await c.noteCachedJobs([odd]); STOP_KEYS('J-odd').forEach(k => put(k))
    needsClosing([])
    const res = await c.pruneJobCache(CREW, [])
    ok('the old stop\'s own keys go', res.status === 'pruned' && allGone(STOP_KEYS('J-old')).length === 0, JSON.stringify(res))
    ok('every property is kept while that stop is', allThere(PROPERTY_KEYS('A-old')).length === 0)
    // Ten days on that stop is gone; a task with no property, opened today, pins nothing.
    setDay('2026-10-23', 19)
    const task = job('J-task', '2026-10-23', null, { job_type: 'task', client_addresses: null })
    await c.noteCachedJobs([task]); STOP_KEYS('J-task').forEach(k => put(k))
    await c.pruneJobCache(CREW, [])
    ok('10 days on, only a property-less task kept: the property goes', allGone(PROPERTY_KEYS('A-old')).length === 0 && allThere(STOP_KEYS('J-task')).length === 0)
  },

  // A stop opened while a prune runs keeps its keys.
  async openedDuringAPrune() {
    seedSession()
    const c = load()
    setDay('2026-10-01', 8)
    const old = job('J-old', '2026-10-01', 'A-old')
    await c.noteCachedJobs([old]); seedStop(old)
    setDay('2026-10-13', 19)
    needsClosing([])
    const p = c.pruneJobCache(CREW, [])
    const n = c.noteCachedJobs([old])           // opened from Schedule at that moment
    const res = await p; await n
    ok('the prune spares it, and its property', allThere([...STOP_KEYS('J-old'), ...PROPERTY_KEYS('A-old')]).length === 0, JSON.stringify(res))
    const idx = await c.readCacheEntry('cachedJobs')
    ok('it is on the index as opened now', idx?.['J-old']?.t >= Date.now() - 60_000, JSON.stringify(idx?.['J-old']))
    const next = await c.pruneJobCache(CREW, [])
    ok('the next prune keeps it too', next.status === 'pruned' && allThere(STOP_KEYS('J-old')).length === 0, JSON.stringify(next))
  },

  // Two screens noting at once both land.
  async notesDoNotLoseEachOther() {
    seedSession()
    const c = load()
    setDay('2026-10-13', 19)
    const jobs = Array.from({ length: 6 }, (_, i) => job(`J-${i}`, '2026-10-13', `A-${i}`))
    await Promise.all(jobs.map(j => c.noteCachedJobs([j])))
    const idx = await c.readCacheEntry('cachedJobs')
    ok('six notes at once: six entries', jobs.every(j => idx?.[j.id]?.d === '2026-10-13' && idx?.[j.id]?.a === j.address_id), Object.keys(idx ?? {}).join(','))
  },

  // Signing out mid-prune leaves nothing of the account behind.
  async signOutDuringAPrune() {
    seedSession()
    const c = load()
    setDay('2026-10-01', 8)
    await c.noteCachedJobs([job('J-old', '2026-10-01', 'A-old')]); seedStop(job('J-old', '2026-10-01', 'A-old'))
    setDay('2026-10-13', 19)
    needsClosing([])
    // Signed out just as the prune reads its index, after it has decided to run.
    let cleared: Promise<void> | null = null
    onRead.set('dataCache:cachedJobs', () => { cleared = c.clearDataCache() })
    const res = await c.pruneJobCache(CREW, [])
    await cleared
    await sleep(5)
    ok('the sign-out landed mid-prune', cleared !== null && res.status === 'pruned', JSON.stringify(res))
    const left = Array.from(store.keys()).filter(k => k.startsWith('dataCache:'))
    ok('nothing cached after sign-out (the index is not written back)', left.length === 0, `${left.join(' ')} / ${JSON.stringify(res)}`)
  },

  // Months of use at the sizes measured on prod: bounded with pruning, past
  // Android's 6 MB without it.
  async growthStaysBounded() {
    seedSession()
    const c = load()
    const R = c.reads
    // Bytes per cached read, measured 2026-10-13 (CKS / Rhyne averages,
    // completed cleans of the last 30 days; small keys estimated).
    const PROFILES = {
      'CKS, busiest cleaner (131 stops / 30 days, 51 properties)': {
        perDay: 5, properties: 51, crew: { ...CREW, _timeMode: 'daily' },
        bytes: { chkrows: 3551, nextarr: 3607, crew: 158, jobmeta: 250, crewnote: 53, crewnoteack: 2, time: 50, crewclock: 38, photos: 15, pshot: 2, signoffs: 83, 'inv:log': 7, 'inv:extras': 2, route: 120,
          tmpl: 152, rooms: 570, preq: 25, propmeta: 4226, 'inv:items': 2810, 'inv:rooms': 570, addrmode: 40, 'nextarr:addr': 40, tenvideo: 40, tenseed: 40, tenmode: 40, 'nextarr:ten': 40 } as Record<string, number>,
      },
      'Rhyne, busiest cleaner (30 stops / 30 days, 11 properties)': {
        perDay: 1, properties: 11, crew: CREW,
        bytes: { chkrows: 31856, nextarr: 1574, crew: 111, jobmeta: 250, crewnote: 53, crewnoteack: 2, time: 700, crewclock: 260, photos: 248, pshot: 943, signoffs: 1755, 'inv:log': 10, 'inv:extras': 2, route: 120,
          tmpl: 16857, rooms: 1642, preq: 2472, propmeta: 2082, 'inv:items': 1743, 'inv:rooms': 1642, addrmode: 40, 'nextarr:addr': 40, tenvideo: 40, tenseed: 40, tenmode: 40, 'nextarr:ten': 40 } as Record<string, number>,
      },
    }
    const kindOf = (key: string) => { const p = key.split(':'); return (p[0] === 'inv' || (p[0] === 'nextarr' && (p[1] === 'addr' || p[1] === 'ten'))) ? `${p[0]}:${p[1]}` : p[0] }
    const cacheBytes = () => { let n = 0; for (const [k, v] of store) if (k.startsWith('dataCache:')) n += k.length + v.length; return n }
    const MB = (n: number) => (n / 1024 / 1024).toFixed(2)
    for (const [name, p] of Object.entries(PROFILES)) {
      for (const prune of [true, false]) {
        store.clear(); seedSession()
        let peak = 0, at180 = 0, at30 = 0, n = 0
        const start = '2026-01-05'
        for (let d = 0; d < 180; d++) {
          const ymd = ymdPlus(start, d)
          setDay(ymd, 19)
          if (d % 7 === 6) continue           // a day off a week
          const stops = Array.from({ length: p.perDay }, () => { n++; return job(`J-${n}`, ymd, `A-${n % p.properties}`) })
          // The stop's screen and the day pack write the stop's reads.
          await c.noteCachedJobs(stops)
          for (const s of stops) for (const r of R.jobPackReads(s, p.crew)) put(r.key, p.bytes[kindOf(r.key)] ?? 40)
          needsClosing([])
          if (prune) await c.pruneJobCache(p.crew, stops)
          const b = cacheBytes()
          peak = Math.max(peak, b)
          if (d === 29) at30 = b
          if (d === 179 || d === 178) at180 = b
        }
        console.log(`      ${name}, ${prune ? 'pruned' : 'never pruned'}: ${MB(at30)} MB after a month, ${MB(at180)} MB after 6 months (peak ${MB(peak)} MB)`)
        if (prune) ok(`${name}: stays under 1 MB with pruning`, peak < 1024 * 1024, `${MB(peak)} MB`)
        else if (p.perDay >= 5) ok(`${name}: past 6 MB within 6 months without it (the bug)`, at180 > 6 * 1024 * 1024, `${MB(at180)} MB`)
        else ok(`${name}: grows without bound without it (the bug)`, at180 > 4 * at30, `${MB(at30)} → ${MB(at180)} MB`)
      }
    }
  },
}

let finished = false
process.on('exit', () => {
  if (!finished) { console.log('FAIL  scenario never finished'); process.exitCode = 1 }
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
