// src/lib/siteVisits.ts
// Arrive and leave at each home, for day-shift companies with the switch on
// (tenants.site_visits; rinsebase-app 20261023190000_job_site_events).
//
// Day-shift crews are paid from Start my day to End my day, so a clean has no
// clock of its own: just Start and Complete taps, which say when a button was
// pressed, not when anyone reached or left the home. The arrival fences
// (lib/arrivalGeofence) already watch a 150 m fence around each home on the
// person's list; in this mode they watch for leaving too, and every crossing
// is written to job_site_events.
//
// A record only: no time entry (pay comes from the day shift), no
// notification, no gate. So it keeps its own small queue rather than the
// outbox: a crossing must never wait in line ahead of a clock-in, and one the
// server refuses (taken off the clean, switch turned off, too old) is simply
// dropped, never shown to the crew as "your hours may be missing".
// The rules live in lib/siteVisitRules (pure, tested under Node).
//
// Since 20261023210100-0200 (rinsebase-app) the server reads the leaves: a
// clean left open is completed at the time its crew left, once they've moved
// on, and a day left open ends at leaving the last home or the office. So:
//   • the office is fenced too (the company's address), recorded with no clean;
//   • a leave is timed from the phone's own trail of map positions when it can
//     say, not from when the OS got round to reporting it;
//   • Start my day can offer the time the phone recorded them reaching the
//     home they're at (arrivalForStart).

import * as Location from 'expo-location'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase, readStoredSession } from './supabase'
import { cachedQuery } from './dataCache'
import { loadCachedProfile } from './profileCache'
import { myUsersRowFilter, pickMyUsersRow } from './myUsersRow'
import { uuid4 } from './outbox'
import {
  decideSiteEvent, pruneSiteQueue, siteSendOutcome, readFenceMark, pruneTrail, departureFromTrail, arrivalToOffer,
  OFFICE_FENCE, type SiteEventRow, type TrailFix,
} from './siteVisitRules'

const QUEUE_KEY = 'site_events:queue'
// Per fence: { s: 'in' | 'out', t: ms } (a bare 'in' / 'out' from the first version still reads)
const STATE_PREFIX = 'site_events:state:'
// The day's fences, when they are arrive/leave fences: { day, jobIds }.
const ARMED_KEY = 'site_events:armed'
// The phone's own map positions, the last hour, while those fences are up (siteVisitRules).
const TRAIL_KEY = 'site_events:trail'

/** The company's switch. The saved copy answers offline (a headless wake in a
 *  dead zone); any error, including the column not existing yet, is "off". */
export async function siteVisitsOn(tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return false
  try {
    const { data } = await cachedQuery(`site:flag:${tenantId}`,
      supabase.from('tenants').select('site_visits').eq('id', tenantId).maybeSingle())
    return (data as any)?.site_visits === true
  } catch { return false }
}

/** Where the office is: the company's address (tenants.lat/lng, Settings).
 *  Its own saved-copy read, so a headless wake offline still knows; null when
 *  there's none (no fence). */
export async function officeLocation(tenantId: string | null | undefined): Promise<{ lat: number; lng: number } | null> {
  if (!tenantId) return null
  try {
    const { data } = await cachedQuery(`site:office:${tenantId}`,
      supabase.from('tenants').select('lat, lng').eq('id', tenantId).maybeSingle())
    const row = data as any
    if (row?.lat == null || row?.lng == null) return null
    const lat = Number(row.lat), lng = Number(row.lng)
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
  } catch { return null }
}

// The phone's own calendar day. The fences are registered and checked on the
// same phone, so the two always agree, whatever zone a headless wake is in.
const today = () => new Date().toDateString()

/** Called when the day's fences are registered: jobIds = arrive/leave fences
 *  for these cleans, null = the fences (if any) are something else. Fence
 *  states for cleans no longer fenced are forgotten. */
export async function markSiteFences(jobIds: string[] | null): Promise<void> {
  try {
    // No fences, no trail: positions are kept only while they're up.
    if (!jobIds) await AsyncStorage.multiRemove([ARMED_KEY, TRAIL_KEY])
    else await AsyncStorage.setItem(ARMED_KEY, JSON.stringify({ day: today(), jobIds }))
    const keep = new Set((jobIds ?? []).map(id => STATE_PREFIX + id))
    const stale = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(STATE_PREFIX) && !keep.has(k))
    if (stale.length) await AsyncStorage.multiRemove(stale)
  } catch { /* best-effort */ }
}

/** Is this fence one of today's arrive/leave fences? 'stale' = it was, on an
 *  earlier day (the fences are re-registered when Home next loads; until then
 *  a crossing at yesterday's home is not recorded). */
export async function siteFenceKind(jobId: string): Promise<'site' | 'stale' | 'other'> {
  try {
    const raw = await AsyncStorage.getItem(ARMED_KEY)
    if (!raw) return 'other'
    const armed = JSON.parse(raw) as { day: string; jobIds: string[] }
    if (!armed?.jobIds?.includes(jobId)) return 'other'
    return armed.day === today() ? 'site' : 'stale'
  } catch { return 'other' }
}

// One crossing at a time per fence, in the order the OS reported them: an
// arrive still being handled must not lose the leave that follows it.
const chains: Record<string, Promise<void>> = {}

/** The fence the OS reported: its centre and radius (the region it watched). */
export type FenceCentre = { lat: number; lng: number; radius: number }

/** An OS fence report for an arrive/leave fence (a clean's home, or
 *  OFFICE_FENCE). The time is taken now, before anything waits. */
export function onSiteCrossing(jobId: string, report: 'enter' | 'exit', centre: FenceCentre | null = null): Promise<void> {
  const at = new Date().toISOString()
  const run = (chains[jobId] ?? Promise.resolve()).then(() => handleCrossing(jobId, report, at, centre)).catch(() => {})
  chains[jobId] = run
  return run
}

async function handleCrossing(jobId: string, report: 'enter' | 'exit', reportedAt: string, centre: FenceCentre | null) {
  const last = readFenceMark(await AsyncStorage.getItem(STATE_PREFIX + jobId))
  const kind = decideSiteEvent(last?.s, report)
  if (!kind) return
  // A leave is timed from the trail when it can say; an arrive at the report.
  const at = kind === 'depart' && centre ? await leaveTimeFromTrail(centre, reportedAt, last?.s === 'in' ? last.t : null) : reportedAt
  await AsyncStorage.setItem(STATE_PREFIX + jobId, JSON.stringify({ s: kind === 'arrive' ? 'in' : 'out', t: Date.parse(at) }))
  const user = await signedInUser()
  if (!user?.id || !user?.tenant_id) return
  const fix = await quickFix(5000)
  const office = jobId === OFFICE_FENCE
  const clean = office ? null : jobId
  const place = office ? 'office' : 'home'
  await recordSiteEvent({
    id: uuid4(), tenant_id: user.tenant_id, job_id: clean, user_id: user.id, kind, at, place,
    lat: fix?.lat ?? null, lng: fix?.lng ?? null, accuracy_m: fix?.accuracy ?? null,
  })
}

async function readTrail(): Promise<TrailFix[]> {
  try { return JSON.parse((await AsyncStorage.getItem(TRAIL_KEY)) || '[]') as TrailFix[] } catch { return [] }
}

async function leaveTimeFromTrail(centre: FenceCentre, reportedAt: string, arrivedMs: number | null): Promise<string> {
  const t = departureFromTrail(await readTrail(), centre, centre.radius, Date.parse(reportedAt), arrivedMs)
  return t == null ? reportedAt : new Date(t).toISOString()
}

/** Map positions the tracker just got (lib/locationTracker), kept for timing
 *  leaves: only while today's arrive/leave fences are up, the last hour only.
 *  Best-effort: never in the tracker's way. */
export async function noteTrail(locs: { timestamp: number; coords: { latitude: number; longitude: number; accuracy?: number | null } }[]): Promise<void> {
  try {
    if (!locs?.length) return
    const raw = await AsyncStorage.getItem(ARMED_KEY)
    if (!raw || JSON.parse(raw)?.day !== today()) return
    const add: TrailFix[] = locs.map(l => [Number(l.timestamp), l.coords.latitude, l.coords.longitude, l.coords.accuracy ?? null])
    await locked(async () => {
      await AsyncStorage.setItem(TRAIL_KEY, JSON.stringify(pruneTrail([...(await readTrail()), ...add], Date.now())))
    })
  } catch { /* best-effort */ }
}

/** The arrival Start my day can offer (siteVisitRules arrivalToOffer): the
 *  home they're still at today, reached 5+ minutes ago. */
export async function arrivalForStart(): Promise<{ jobId: string; at: string } | null> {
  try {
    const raw = await AsyncStorage.getItem(ARMED_KEY)
    const armed = raw ? JSON.parse(raw) as { day: string; jobIds: string[] } : null
    if (!armed || armed.day !== today() || !Array.isArray(armed.jobIds)) return null
    const marks = await Promise.all(armed.jobIds.map(async jobId =>
      ({ jobId, mark: readFenceMark(await AsyncStorage.getItem(STATE_PREFIX + jobId)) })))
    const offer = arrivalToOffer(marks, Date.now())
    return offer ? { jobId: offer.jobId, at: new Date(offer.at).toISOString() } : null
  } catch { return null }
}

// A headless wake has no module state: the signed-in person from the stored
// sign-in, the row the database acts as (lib/myUsersRow), else the profile
// App.tsx saved at the last good load.
async function signedInUser(): Promise<{ id: string; tenant_id: string } | null> {
  const authId = (await readStoredSession())?.user?.id
  if (!authId) return null
  try {
    const { data: rows, error } = await supabase.from('users')
      .select('id, tenant_id, auth_user_id, is_active')
      .or(myUsersRowFilter(authId))
    return pickMyUsersRow(rows, authId) ?? (error ? await loadCachedProfile(authId) : null)
  } catch {
    return loadCachedProfile(authId)
  }
}

// Where the phone is, if it can say within the time: evidence, never required.
async function quickFix(timeoutMs: number): Promise<{ lat: number; lng: number; accuracy: number | null } | null> {
  try {
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]) as Location.LocationObject | null
    if (!fix?.coords) return null
    return { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy ?? null }
  } catch { return null }
}

// ── The queue ────────────────────────────────────────────────────────────────
// Every read-modify-write of the stored list goes through one lock.
let lock: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.catch(() => {})
  return run
}

async function readQueue(): Promise<SiteEventRow[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as SiteEventRow[]) : []
  } catch { return [] }
}

async function writeQueue(q: SiteEventRow[]) {
  try { await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q)) } catch { /* best-effort */ }
}

/** Keep a crossing on the phone, then try to send what's waiting. */
export async function recordSiteEvent(row: SiteEventRow): Promise<void> {
  await locked(async () => writeQueue(pruneSiteQueue([...(await readQueue()), row], Date.now())))
  await flushSiteEvents()
}

let flushing: Promise<void> | null = null

/** Send waiting crossings in order. No answer stops the run (the next crossing
 *  or Home load tries again); a refusal drops that one and goes on. Each row
 *  carries its own id and goes as INSERT … ON CONFLICT (id) DO NOTHING, so a
 *  send whose answer was lost can't land twice. */
export function flushSiteEvents(): Promise<void> {
  if (!flushing) flushing = sendWaiting().finally(() => { flushing = null })
  return flushing
}

async function sendWaiting() {
  for (;;) {
    const head = await locked(async () => {
      const q = pruneSiteQueue(await readQueue(), Date.now())
      await writeQueue(q)
      return q[0] ?? null
    })
    if (!head) return
    const res: any = await supabase.from('job_site_events').upsert(head, { onConflict: 'id', ignoreDuplicates: true })
    if (siteSendOutcome(res) === 'retry') return
    await locked(async () => writeQueue((await readQueue()).filter(e => e.id !== head.id)))
  }
}
