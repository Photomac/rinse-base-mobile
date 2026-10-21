// Tapping a crew job push opens its job. Run with: node scripts/test-push-tap.mjs
//
// Exercises the REAL src/lib/pushTap.ts (pure apart from its injected io)
// against the pushes the server sends — notify-crew-assigned
// { type: 'job_assigned', jobId, tenantId } and send-job-reminders
// { type: 'job_reminder', jobId, tenantId } (rinse-base-app #1687) — then
// checks App.tsx's wiring on its source text (src/ and App.tsx are copied next
// to the scenario by the runner): the launching tap and the warm tap go
// through one ledger, the Schedule fallback reaches the navigator, the job
// row is Schedule's, and the saved copies are the ones the screens keep.
//
// The routing itself can't be seen on a simulator (no push permission there,
// registerPushToken skips !Device.isDevice), so the sequences a phone goes
// through are played here: a cold start, a tap over an open clean, a second
// tap while the first is loading, a dead zone, a slow link.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  tappedJobId, onScreen, tapWhen, stillWanted, openable, loadTappedJob, tapRouter, tapLedger, savedKeys,
  SCHEDULE_JOB_SELECT, JOB_PUSH_TYPES, LIVE_WAIT_MS, QUEUE_MAX_MS, HANDLED_KEEP, HANDLED_TAPS_KEY,
  type TapIO, type OnScreen,
} from '../pushTap'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const between = (text: string, from: string, to: string) => {
  const i = text.indexOf(from)
  return i < 0 ? '' : text.slice(i, text.indexOf(to, i + from.length))
}

const TENANT = 'ten-cks'
const MIA = { id: 'u-mia', tenant_id: TENANT, role: 'cleaner' }
const OWNER = { id: 'u-cat', tenant_id: TENANT, role: 'owner' }
const job = (id: string, crew: string[], extra: Record<string, any> = {}) => ({
  id, status: 'scheduled', scheduled_start: '2026-10-21T15:00:00Z', job_type: 'clean',
  client_addresses: { id: 'addr-' + id, street: '12 Pine', city: 'Breck', nickname: 'Pine', photo_url: null },
  job_assignments: crew.map(user_id => ({ user_id })), ...extra,
})

async function main() {
  // ── which taps open a job ──
  ok('a day-before reminder opens its job', tappedJobId({ type: 'job_reminder', jobId: 'j1', tenantId: TENANT }, TENANT) === 'j1')
  ok('an assignment push opens its job', tappedJobId({ type: 'job_assigned', jobId: 'j2', tenantId: TENANT }, TENANT) === 'j2')
  ok('exactly those two types', JOB_PUSH_TYPES.slice().sort().join() === 'job_assigned,job_reminder')
  ok('any other type keeps doing nothing',
    tappedJobId({ type: 'chat_message', jobId: 'j1' }, TENANT) === null && tappedJobId({ type: 'sos', jobId: 'j1' }, TENANT) === null &&
    tappedJobId({ jobId: 'j1' }, TENANT) === null)
  ok('no job id (missing, empty, blank, not a string) keeps doing nothing',
    tappedJobId({ type: 'job_reminder' }, TENANT) === null && tappedJobId({ type: 'job_reminder', jobId: '' }, TENANT) === null &&
    tappedJobId({ type: 'job_reminder', jobId: '  ' }, TENANT) === null && tappedJobId({ type: 'job_reminder', jobId: 42 }, TENANT) === null)
  ok('no data at all: nothing', tappedJobId(null, TENANT) === null && tappedJobId(undefined, TENANT) === null)
  ok('another company\'s push on a phone signed in to this one: nothing',
    tappedJobId({ type: 'job_reminder', jobId: 'j1', tenantId: 'ten-other' }, TENANT) === null)
  ok('a push without a tenant still opens (the read is the company\'s own anyway)',
    tappedJobId({ type: 'job_assigned', jobId: 'j1' }, TENANT) === 'j1')

  // ── what is on screen, in App.tsx's render order ──
  const tabs = onScreen({ selectedJob: null, activeChannel: null, showSOS: false, subScreen: null })
  const onJob = onScreen({ selectedJob: { id: 'j9' }, activeChannel: null, showSOS: false, subScreen: null })
  ok('nothing open: the tabs', tabs.what === 'tabs')
  ok('a job open: that job', onJob.what === 'job' && (onJob as any).jobId === 'j9')
  ok('chat over a job shows chat; SOS over a job shows SOS; Mileage/Team over a job shows that',
    onScreen({ selectedJob: { id: 'j9' }, activeChannel: { id: 'c' }, showSOS: true, subScreen: 'mileage' }).what === 'chat' &&
    onScreen({ selectedJob: { id: 'j9' }, activeChannel: null, showSOS: true, subScreen: 'team' }).what === 'sos' &&
    onScreen({ selectedJob: { id: 'j9' }, activeChannel: null, showSOS: false, subScreen: 'team' }).what === 'sub')
  const app = src('App.tsx')
  const order = ['if (activeChannel) {', 'if (showSOS) {', "if (subScreen === 'mileage') {", 'if (selectedJob) {', '<NavigationContainer']
    .map(s => app.indexOf(s))
  ok('App.tsx renders chat, SOS, Mileage/Team, the job, then the tabs: the order onScreen() reads',
    order.every(i => i > 0) && order.every((v, i) => i === 0 || order[i - 1] < v), order.join(' < '))

  // ── when a tap opens ──
  ok('on the tabs: now', tapWhen(tabs, 'j1') === 'now')
  ok('the tapped job is the one open: nothing to do', tapWhen(onJob, 'j9') === 'here')
  ok('another job open: waits (its timer, checklist and camera are only on that screen)', tapWhen(onJob, 'j1') === 'wait')
  ok('a chat thread, SOS, Mileage or Team today: waits',
    (['chat', 'sos', 'sub'] as const).every(what => tapWhen({ what } as OnScreen, 'j1') === 'wait'))
  ok('a waiting tap lasts QUEUE_MAX_MS, then is dropped',
    stillWanted(0, 0) && stillWanted(0, QUEUE_MAX_MS) && !stillWanted(0, QUEUE_MAX_MS + 1) && QUEUE_MAX_MS === 10 * 60_000)

  // ── which jobs a tap may open: what Schedule lists for the person ──
  ok('crew: a clean they are on', openable(job('j1', [MIA.id]), MIA))
  ok('crew: a clean they were taken off of — no (Schedule instead)', !openable(job('j1', ['u-lilly']), MIA))
  ok('office: any of the company\'s, as their Schedule shows', openable(job('j1', ['u-lilly']), OWNER))
  ok('cancelled since the push: no, for anyone (Schedule leaves it out, and the job screen would offer Start)',
    !openable(job('j1', [MIA.id], { status: 'cancelled' }), MIA) && !openable(job('j1', [], { status: 'cancelled' }), OWNER))
  ok('no row: no', !openable(null, MIA) && !openable({}, OWNER))

  // ── loading the job ──
  const NEVER = new Promise<any>(() => {})
  const fakeIO = (o: { live?: any; liveThrows?: boolean; liveSlow?: Promise<any>; saved?: Record<string, any>; queued?: Record<string, any>; overlayThrows?: boolean }) => {
    const calls = { live: 0, saved: [] as string[], overlay: 0, waited: [] as number[] }
    const io: TapIO = {
      live: () => {
        calls.live++
        if (o.liveThrows) throw new Error('fetch failed')
        return o.liveSlow ?? Promise.resolve(o.live)
      },
      saved: async key => { calls.saved.push(key); return o.saved?.[key] ?? null },
      overlay: async rows => {
        calls.overlay++
        if (o.overlayThrows) throw new Error('queue unreadable')
        return rows.map(r => ({ ...r, ...(o.queued?.[r.id] ?? {}) }))
      },
      // The LIVE_WAIT_MS timer: run out at once on a slow link, never otherwise.
      wait: ms => { calls.waited.push(ms); return o.liveSlow ? Promise.resolve() : NEVER },
    }
    return { io, calls }
  }
  const DASH = `dash:today:${MIA.id}`
  const SCHED = `sched:${MIA.id}`
  const mine = job('j1', [MIA.id])

  {
    const f = fakeIO({ live: { data: mine, error: null, status: 200 }, queued: { j1: { status: 'in_progress' } } })
    const r = await loadTappedJob('j1', MIA, f.io)
    ok('live: the row, with the Start still queued on this phone laid over it',
      r?.job.id === 'j1' && r.job.status === 'in_progress' && r.fromCache === false && f.calls.overlay === 1 && f.calls.saved.length === 0)
    ok('the live read gets LIVE_WAIT_MS before the saved copy', f.calls.waited[0] === LIVE_WAIT_MS && LIVE_WAIT_MS === 4000)
  }
  {
    const f = fakeIO({ live: { data: null, error: null, status: 200 }, saved: { [DASH]: [mine] } })
    ok('the server says there is no such job (deleted, or not this person\'s to read): Schedule, and the saved copy is not used',
      (await loadTappedJob('j1', MIA, f.io)) === null && f.calls.saved.length === 0)
  }
  {
    const f = fakeIO({ live: { data: null, error: { message: 'permission denied' }, status: 403 }, saved: { [DASH]: [mine] } })
    ok('a server refusal is final too (only the network\'s silence falls back, as in lib/dataCache)',
      (await loadTappedJob('j1', MIA, f.io)) === null && f.calls.saved.length === 0)
  }
  {
    const f = fakeIO({ live: { data: null, error: { message: 'Network request failed' }, status: 0 }, saved: { [DASH]: [job('j0', [MIA.id]), mine] } })
    const r = await loadTappedJob('j1', MIA, f.io)
    ok('no signal: the day pack\'s copy (Home\'s read)', r?.job.id === 'j1' && r.fromCache === true && f.calls.saved[0] === DASH)
  }
  {
    const later = job('j7', [MIA.id], { scheduled_start: '2026-10-28T15:00:00Z' })
    const f = fakeIO({ live: { data: null, error: { message: 'offline' }, status: 0 }, saved: { [DASH]: [mine], [SCHED]: [mine, later] } })
    const r = await loadTappedJob('j7', MIA, f.io)
    ok('no signal, a job past tomorrow: Schedule\'s saved copy', r?.job.id === 'j7' && r.fromCache && f.calls.saved.join() === `${DASH},${SCHED}`)
  }
  {
    const f = fakeIO({ live: { data: null, error: { message: 'offline' }, status: 0 }, saved: { [DASH]: [mine] } })
    ok('no signal and not on the phone: Schedule', (await loadTappedJob('j5', MIA, f.io)) === null)
  }
  {
    const f = fakeIO({ liveThrows: true, saved: { [DASH]: [mine] } })
    const r = await loadTappedJob('j1', MIA, f.io)
    ok('a read that throws is the network failing, not a "no"', r?.job.id === 'j1' && r.fromCache)
  }
  {
    // Home's saved read is the whole company's day; a crew phone opens only its own.
    const lillys = job('j3', ['u-lilly'])
    const f = fakeIO({ live: { data: null, error: { message: 'offline' }, status: 0 }, saved: { [DASH]: [lillys] } })
    ok('no signal: a teammate\'s clean in the saved day is not opened on a crew phone', (await loadTappedJob('j3', MIA, f.io)) === null)
  }
  {
    const f = fakeIO({ live: { data: job('j1', ['u-lilly']), error: null, status: 200 } })
    ok('live, but taken off the clean since the push: Schedule', (await loadTappedJob('j1', MIA, f.io)) === null)
  }
  {
    const f = fakeIO({ live: { data: job('j1', [MIA.id], { status: 'cancelled' }), error: null, status: 200 } })
    ok('live, cancelled since the push: Schedule', (await loadTappedJob('j1', MIA, f.io)) === null)
  }
  {
    let answer: (v: any) => void = () => {}
    const slow = new Promise(r => { answer = r })
    const f = fakeIO({ liveSlow: slow, saved: { [DASH]: [mine] } })
    const r = await loadTappedJob('j1', MIA, f.io)
    ok('one bar, nothing back within LIVE_WAIT_MS: the saved copy, not 15 s of nothing', r?.job.id === 'j1' && r.fromCache === true)
    answer({ data: mine, error: null, status: 200 })
  }
  {
    let answer: (v: any) => void = () => {}
    const slow = new Promise(r => { answer = r })
    const f = fakeIO({ liveSlow: slow })
    const pending = loadTappedJob('j1', MIA, f.io)
    setTimeout(() => answer({ data: mine, error: null, status: 200 }), 5)
    const r = await pending
    ok('one bar and nothing saved: it waits for the live answer', r?.job.id === 'j1' && r.fromCache === false)
  }
  {
    const f = fakeIO({ live: { data: mine, error: null, status: 200 }, overlayThrows: true })
    const r = await loadTappedJob('j1', MIA, f.io)
    ok('an unreadable outbox: the row as read', r?.job.id === 'j1' && r.job.status === 'scheduled')
  }

  // ── the sequences a phone goes through ──
  const harness = (start: OnScreen, loads: Record<string, any>) => {
    let screen: OnScreen = start
    let clock = 1_000_000
    const opened: string[] = []
    let schedule = 0
    const gates: Record<string, (v?: any) => void> = {}
    const gated = new Set<string>()
    const r = tapRouter({
      screen: () => screen,
      load: async jobId => {
        // 'GATE': the first load of it hangs until the scenario opens the gate.
        if (loads[jobId] === 'GATE') {
          if (!gated.has(jobId)) { gated.add(jobId); await new Promise(res => { gates[jobId] = res }) }
          return { job: { id: jobId }, fromCache: false }
        }
        if (loads[jobId] === 'THROW') throw new Error('boom')
        return loads[jobId] ? { job: loads[jobId], fromCache: false } : null
      },
      openJob: j => { opened.push(j.id); screen = { what: 'job', jobId: j.id } },
      openSchedule: () => { schedule++ },
      now: () => clock,
    })
    return {
      r, opened, gates,
      get schedule() { return schedule },
      set: (s: OnScreen) => { screen = s },
      tick: (ms: number) => { clock += ms },
    }
  }
  const settle = () => new Promise(r => setTimeout(r, 0))
  {
    const h = harness({ what: 'tabs' }, { j1: { id: 'j1' } })
    await h.r.tap('j1')
    ok('cold start or warm tap on the tabs: the job opens', h.opened.join() === 'j1' && h.schedule === 0)
  }
  {
    const h = harness({ what: 'tabs' }, {})
    await h.r.tap('jX')
    ok('a job it can\'t have: the Schedule tab', h.opened.length === 0 && h.schedule === 1)
  }
  {
    const h = harness({ what: 'tabs' }, { j1: 'THROW' })
    await h.r.tap('j1')
    ok('a load that throws: the Schedule tab, no crash', h.schedule === 1)
  }
  {
    const h = harness({ what: 'job', jobId: 'j9' }, { j1: { id: 'j1' } })
    await h.r.tap('j1')
    ok('mid-clean on another job: nothing moves, the tap waits', h.opened.length === 0 && h.r.waiting() === 'j1')
    h.set({ what: 'job', jobId: 'j9' }); await h.r.screenChanged()
    ok('still on that job (a re-render): still waiting', h.opened.length === 0 && h.r.waiting() === 'j1')
    h.set({ what: 'tabs' }); await h.r.screenChanged()
    ok('Back to the tabs: the tapped job opens', h.opened.join() === 'j1' && h.r.waiting() === null)
  }
  {
    const h = harness({ what: 'sos' }, { j1: { id: 'j1' } })
    await h.r.tap('j1')
    h.set({ what: 'tabs' }); await h.r.screenChanged()
    ok('an SOS is never replaced; the job opens once it is closed', h.opened.join() === 'j1')
  }
  {
    const h = harness({ what: 'chat' }, { j1: { id: 'j1' } })
    await h.r.tap('j1')
    h.tick(QUEUE_MAX_MS + 1)
    h.set({ what: 'tabs' }); await h.r.screenChanged()
    ok('a tap still waiting after QUEUE_MAX_MS is dropped', h.opened.length === 0 && h.schedule === 0 && h.r.waiting() === null)
  }
  {
    const h = harness({ what: 'job', jobId: 'j1' }, { j1: { id: 'j1' } })
    await h.r.tap('j1')
    h.set({ what: 'tabs' }); await h.r.screenChanged()
    ok('a tap on the job already open: nothing, and nothing pops up on Back', h.opened.length === 0 && h.r.waiting() === null)
  }
  {
    const h = harness({ what: 'job', jobId: 'j9' }, { j1: { id: 'j1' } })
    await h.r.tap('j1')
    h.set({ what: 'job', jobId: 'j1' }); await h.r.screenChanged()
    ok('waiting for a job they then open themselves: done, nothing more', h.opened.length === 0 && h.r.waiting() === null)
  }
  {
    const h = harness({ what: 'tabs' }, { j1: 'GATE', j2: { id: 'j2' } })
    const first = h.r.tap('j1')
    await settle()
    await h.r.tap('j2')
    h.gates.j1?.(); await first
    ok('a second tap while the first is loading: the second wins, the first never opens', h.opened.join() === 'j2')
  }
  {
    const h = harness({ what: 'tabs' }, { j1: 'GATE' })
    const first = h.r.tap('j1')
    await settle()
    h.set({ what: 'job', jobId: 'j4' }) // they opened a clean from Home while it loaded
    h.gates.j1?.(); await first
    ok('they open a job while the tap loads: it waits instead of replacing that one', h.opened.length === 0 && h.r.waiting() === 'j1')
    h.set({ what: 'tabs' }); await h.r.screenChanged()
    ok('…and opens on Back', h.opened.join() === 'j1')
  }
  {
    const h = harness({ what: 'job', jobId: 'j9' }, { j1: { id: 'j1' }, j2: { id: 'j2' } })
    await h.r.tap('j1'); await h.r.tap('j2')
    h.set({ what: 'tabs' }); await h.r.screenChanged()
    ok('two taps while busy: the later one opens', h.opened.join() === 'j2')
  }

  // ── each tap once ──
  const store = () => {
    const m = new Map<string, string>()
    return { m, getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v) } }
  }
  {
    const s = store()
    const a = tapLedger(s)
    const firstSeen = await a.first('n-1')
    const again = await a.first('n-1')
    ok('the launching tap and the listener\'s copy of it: handled once', firstSeen === true && again === false)
    const relaunch = tapLedger(s)
    ok('a later launch handed the same tap again: not handled again', (await relaunch.first('n-1')) === false)
    ok('a new tap: handled', (await relaunch.first('n-2')) === true)
    for (let i = 0; i < 40; i++) await relaunch.first(`m-${i}`)
    const kept = JSON.parse(s.m.get(HANDLED_TAPS_KEY) || '[]')
    ok('the phone keeps only the last HANDLED_KEEP ids', kept.length === HANDLED_KEEP && kept[kept.length - 1] === 'm-39')
    ok('a tap with no id: not handled', (await relaunch.first('')) === false)
  }
  {
    const broken = { getItem: async () => { throw new Error('storage') }, setItem: async () => { throw new Error('storage') } }
    const l = tapLedger(broken as any)
    ok('storage unreadable: the tap still opens, once', (await l.first('n-9')) === true && (await l.first('n-9')) === false)
  }
  {
    const s = store(); s.m.set(HANDLED_TAPS_KEY, '{oops')
    ok('a garbled saved list: read as empty', (await tapLedger(s).first('n-1')) === true)
  }

  // ── App.tsx wiring ──
  const inner = between(app, 'function AppInner() {', '\n// ── Root')
  const firstReturn = inner.indexOf('if (loading) {')
  const tapBlock = between(inner, 'const [lastResponse, setLastResponse]', 'if (loading) {')
  ok('the tap hooks sit above AppInner\'s first early return (Rules of Hooks)', tapBlock.length > 0 && inner.indexOf('const [lastResponse') < firstReturn && inner.indexOf('const tapRef') < firstReturn)
  ok('cold start: the tap that launched the app is read once at mount (getLastNotificationResponse, guarded for web)',
    /try \{ const r = Notifications\.getLastNotificationResponse\(\); if \(r\) setLastResponse\(r\) \} catch/.test(tapBlock) && /\}, \[\]\)/.test(tapBlock))
  ok('warm tap: the response listener feeds the same state',
    /addNotificationResponseReceivedListener\(r => setLastResponse\(r\)\)/.test(tapBlock) && /sub\.remove\(\)/.test(tapBlock))
  const effect = between(tapBlock, 'if (!user || !lastResponse) return', '}, [lastResponse, user?.id])')
  ok('only the notification body\'s tap (DEFAULT_ACTION_IDENTIFIER), only after sign-in',
    effect.includes('lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER'))
  ok('the payload goes through tappedJobId with the account\'s company; no job id → return before anything else',
    /tappedJobId\(lastResponse\.notification\.request\.content\.data, user\.tenant_id\)/.test(effect) && /if \(!jobId\) return/.test(effect) &&
    effect.indexOf('if (!jobId) return') < effect.indexOf('taps.first('))
  ok('each tap once, by its notification id, then the native copy is cleared',
    /taps\.first\(lastResponse\.notification\.request\.identifier\)/.test(effect) && effect.includes('if (!first) return') &&
    effect.indexOf('clearLastNotificationResponse()') < effect.indexOf('tapRef.current?.tap(jobId)'))
  ok('the ledger is on AsyncStorage, made once for the app', /const taps = tapLedger\(AsyncStorage\)/.test(app))
  ok('a waiting tap is re-checked whenever a full screen opens or closes',
    /tapRef\.current\?\.screenChanged\(\)\s*\n\s*\}, \[user\?\.id, selectedJob\?\.id, activeChannel, showSOS, subScreen\]\)/.test(tapBlock))
  ok('the router reads App\'s own screen state', /screenRef\.current = onScreen\(\{ selectedJob, activeChannel, showSOS, subScreen \}\)/.test(tapBlock))
  ok('a job opens the way a list tap does (setSelectedJob)', /openJob: \(job\) => setSelectedJob\(job\)/.test(tapBlock))
  ok('Schedule: now if the navigator is up, else when it is (onReady)',
    /pendingTab\.current = 'Schedule'/.test(tapBlock) && /navigationRef\.isReady\(\)/.test(tapBlock) &&
    /<NavigationContainer\s+ref=\{navigationRef\}\s+onReady=\{\(\) => \{ const tab = pendingTab\.current; if \(tab\) \{ pendingTab\.current = null; navigationRef\.navigate\(tab\) \} \}\}/.test(app) &&
    /const navigationRef = createNavigationContainerRef/.test(app))
  ok('there is a Schedule tab to switch to', app.includes('name="Schedule"'))
  ok('the live read is Schedule\'s columns, one job, this company',
    /supabase\.from\('jobs'\)\.select\(SCHEDULE_JOB_SELECT\)\s*\.eq\('id', jobId\)\.eq\('tenant_id', user\.tenant_id\)\.maybeSingle\(\)/.test(app))
  ok('the saved copies come through readCacheEntry, the queued writes through overlayPending(\'jobs\')',
    /saved: \(key\) => readCacheEntry\(key\)/.test(app) && /overlay: \(rows\) => overlayPending\('jobs', rows\)/.test(app))
  ok('the day-change prefetch on a job_assigned push is still there, untouched',
    /if \(isDayChangePush\(data\)\) prefetchDays\(user, \{ force: true \}\)/.test(app) &&
    /return data\?\.type === 'job_assigned'/.test(src('src/lib/offlinePrefetch.ts')))

  // ── Schedule's row, Schedule's rule, the screens' keys ──
  const schedule = src('src/screens/ScheduleScreen.tsx')
  const schedSelect = /cachedQuery\(`sched:\$\{user\.id\}`, supabase\.from\('jobs'\)\s*\.select\('([^']+)'\)/.exec(schedule)?.[1]
  ok('SCHEDULE_JOB_SELECT is exactly ScheduleScreen\'s select', schedSelect === SCHEDULE_JOB_SELECT, schedSelect ? '' : 'Schedule\'s select not found')
  ok('Schedule still leaves cancelled cleans out and shows crew only their own (what openable() mirrors)',
    schedule.includes(".neq('status', 'cancelled')") && /isOwner\s*\?\s*\(data \?\? \[\]\)\s*:\s*\(data \?\? \[\]\)\.filter\(\(j: any\) => isMyJob\(j, user\.id\)\)/.test(schedule) &&
    /const isOwner = \['owner', 'manager', 'dispatcher'\]\.includes\(user\.role\)/.test(schedule))
  ok('the saved keys are the ones Home and Schedule write',
    savedKeys('U').join() === 'dash:today:U,sched:U' &&
    src('src/lib/jobReads.ts').includes('key: `dash:today:${user.id}`') && schedule.includes('cachedQuery(`sched:${user.id}`'))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

// A scenario left awaiting a promise nobody settles would otherwise end the
// process quietly, with exit code 0 and half the checks never run.
process.on('beforeExit', () => { console.error('\n✗ FAIL  the scenario stopped before its end (a promise never settled)'); process.exit(1) })
main().catch(e => { console.error(e); process.exit(1) })
