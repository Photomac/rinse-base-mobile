// src/lib/locationTracker.ts
// Pings crew GPS every 5 minutes when they have an active job
// Monitors geofence — alerts crew if they leave job site without clocking out

import { Alert, Linking, Platform } from 'react-native'
import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import * as Notifications from 'expo-notifications'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase, readStoredSession } from './supabase'
import { cachedQuery } from './dataCache'
import { overlayPending } from './outbox'
import { loadCachedProfile } from './profileCache'
import { myUsersRowFilter, pickMyUsersRow } from './myUsersRow'
import { byCrewDayOrder } from './jobOrder'
import { ensureForegroundLocation, ensureBackgroundLocation, getBackgroundLocationStatus } from './permissions'
import { tStatic, ti } from './i18n'

const LOCATION_TASK = 'crew-location-task'
const PING_INTERVAL = 5 * 60 * 1000 // 5 minutes
const GEOFENCE_RADIUS = 300 // meters — trigger alert if crew is farther than this
const GEOFENCE_DISMISS_DURATION = 15 * 60 * 1000 // 15 minutes after "Still working"

// Is this address accurate enough to fence on?
//
// client_addresses.geocode_precision === 'approximate' is a ZIP/city centroid
// written when no geocoder could resolve the street address — 1-3km from the
// real building, i.e. 3-10x GEOFENCE_RADIUS. A crew member standing inside the
// property would read as "left the job site" on every single ping, pushing a
// "Still clocked in!" notification every 15 minutes and logging each one.
//
// A null precision is a legacy coordinate of unknown provenance and stays
// trusted, exactly as before the column existed.
// `!= null` rather than falsy: latitude 0 / longitude 0 are valid.
function canFenceOn(addr: any): boolean {
  return !!addr && addr.lat != null && addr.lng != null && addr.geocode_precision !== 'approximate'
}

let pingTimer: any = null
let currentUser: any = null
let geofenceDismissedUntil: Record<string, number> = {} // jobId → timestamp
let dismissalsHydrated = false

export function setTrackedUser(user: any) {
  currentUser = user
}

// Module state dies whenever the OS restarts the process (backgrounding,
// headless relaunch for a location update) — without persistence, a crew
// member who tapped "Still working" gets re-nagged minutes later. Persist
// dismissals and hydrate lazily before any geofence check.
const DISMISS_KEY = 'geofence_dismissals'
async function hydrateDismissals() {
  if (dismissalsHydrated) return
  dismissalsHydrated = true
  try {
    const raw = await AsyncStorage.getItem(DISMISS_KEY)
    if (raw) {
      const stored = JSON.parse(raw)
      // keep the later of stored vs in-memory, drop expired
      for (const [jobId, until] of Object.entries(stored)) {
        if ((until as number) > Date.now() && (until as number) > (geofenceDismissedUntil[jobId] || 0)) {
          geofenceDismissedUntil[jobId] = until as number
        }
      }
    }
  } catch { /* cache-only degradation */ }
}

// Dismiss geofence alert for a specific job (crew tapped "Still working")
export function dismissGeofenceAlert(jobId: string) {
  geofenceDismissedUntil[jobId] = Date.now() + GEOFENCE_DISMISS_DURATION
  AsyncStorage.setItem(DISMISS_KEY, JSON.stringify(geofenceDismissedUntil)).catch(() => {})
}

// ── One departure, one push ──
// The checks below run on every location update (the 5-minute timer, the OS
// background task, any timer a racing startLocationTracking leaked), and each
// used to push whenever the crew member was outside the fence. Nothing
// remembered that they had already been told, so a clean left open after the
// crew drove off pushed every few minutes until someone closed it, often two
// or three at once. CKS 2026-09-30: 50 pushes to one inspector over two hours.
//
// Now a job's departure is announced once. The next push needs the crew member
// to be seen back inside the fence first (a new departure), and even then not
// within REALERT_GAP, so GPS drift across the edge can't turn into a stream.
// The check-and-set is synchronous after the one await, so two checks racing
// in the same JS runtime can't both claim the same departure. Persisted, so a
// headless relaunch of the background task doesn't forget it already told them.
const REALERT_GAP = 30 * 60 * 1000
const DEPARTURE_KEY = 'geofence_departures'
type DepartureState = { alertedAt: number; backInside: boolean }
let departures: Record<string, DepartureState> = {}
let departuresHydrated: Promise<void> | null = null

// One shared read: a second check arriving mid-read waits for it rather than
// deciding on an empty record.
function hydrateDepartures(): Promise<void> {
  if (!departuresHydrated) {
    departuresHydrated = (async () => {
      try {
        const raw = await AsyncStorage.getItem(DEPARTURE_KEY)
        if (raw) departures = { ...JSON.parse(raw), ...departures }
      } catch { /* cache-only degradation */ }
    })()
  }
  return departuresHydrated
}

function persistDepartures() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const [id, d] of Object.entries(departures)) if (d.alertedAt < cutoff) delete departures[id]
  AsyncStorage.setItem(DEPARTURE_KEY, JSON.stringify(departures)).catch(() => {})
}

// True exactly when this check should push. Call it for every fenced job on
// every check, inside or out: seeing them inside is what re-arms the alert.
async function claimDepartureAlert(jobId: string, outside: boolean): Promise<boolean> {
  await hydrateDepartures()
  await hydrateDismissals()
  // Nothing below awaits until the claim is recorded.
  const d = departures[jobId]
  if (!outside) {
    if (d && !d.backInside) { d.backInside = true; persistDepartures() }
    return false
  }
  if (Date.now() <= (geofenceDismissedUntil[jobId] || 0)) return false
  if (d && (!d.backInside || Date.now() - d.alertedAt < REALERT_GAP)) return false
  departures[jobId] = { alertedAt: Date.now(), backInside: false }
  persistDepartures()
  return true
}

// Haversine distance in meters
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// What checkWork reads for each clean: enough to name it on the dispatch map,
// fence its property, and put it in day order.
const JOB_FIELDS = 'id, status, scheduled_start, route_order, job_number, client_addresses!jobs_address_id_fkey(lat, lng, geocode_precision, nickname, street)'

// Is this crew member actively working RIGHT NOW? Merely having a job scheduled
// for later today is NOT "working" and must not broadcast a location (that was
// the "why am I on the map at home, with the app closed?" leak). This gates
// BOTH starting tracking and continuing it, so tracking self-terminates the
// moment someone goes off the clock.
//
// Working means an open time entry (a punch on a clean, or a day shift) or a
// clean they are en route to today. A day-shift company ('daily') also counts a
// clean in progress: a clean marked started is its only per-job signal. A
// per-job company does not. There, in progress with no open punch means the
// crew member paused the clean ("Going to another job", a break) or clocked out
// and the completion gate held it open. Either way they are off the clock, and
// the web dispatch board already leaves them off. Counting it kept a phone
// reporting its location all evening after a stranded clean, and pushing
// "you're still clocked in" at every ping.
//
// With no signal the answer comes from the last good copy of the same reads
// plus the punches and status changes still queued in the outbox. It used to
// read a failed query as "not working", so walking into a dead zone mid-clean
// switched tracking off — including the OS background task, which then stayed
// off after signal came back. `working` is null only when there is no way to
// tell (offline and nothing saved yet); each caller picks its safe side.
//
// The same reads (so this still works offline) also give:
// - activeJob: the clean the dispatch dot names. Per-job: the one they clocked
//   into last. Daily: pickActiveJob.
// - fenceJobs: the cleans the left-the-property check measures against. Every
//   push is a claim, so per-job fences exactly the cleans they are clocked
//   into: "you're still clocked in" is true of those and no others, including
//   one they forgot to clock out of before starting the next. Daily fences the
//   active clean ("not marked complete").
// Exported for scripts/test-offline-auth.mjs.
export async function checkWork(userId: string, daily = false): Promise<{ working: boolean | null; activeJob: any | null; fenceJobs: any[] }> {
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999)
  const [entriesRes, jobsRes] = await Promise.all([
    // Each punch brings its clean along: it can be one they aren't assigned
    // to, or yesterday's, and neither is in today's read below.
    cachedQuery(`track:open:${userId}`, supabase
      .from('job_time_entries')
      .select(`id, user_id, job_id, entry_type, clocked_in_at, clocked_out_at, jobs!job_time_entries_job_id_fkey(${JOB_FIELDS})`)
      .eq('user_id', userId).is('clocked_out_at', null).limit(20)),
    // Embeds name their FK: a second FK between these tables would make an
    // unhinted embed ambiguous (HTTP 300), and this read would fail everywhere.
    cachedQuery(`track:today:${userId}`, supabase
      .from('jobs')
      .select(`${JOB_FIELDS}, job_assignments!job_assignments_job_id_fkey!inner(user_id)`)
      .eq('job_assignments.user_id', userId)
      .gte('scheduled_start', todayStart.toISOString())
      .lte('scheduled_start', todayEnd.toISOString())),
  ])
  // Saved rows can be from an earlier day: keep today's (the server already
  // did that for live rows). Queued en-route / start / complete apply on top.
  const todays = jobsRes.data
    ? await overlayPending('jobs', (jobsRes.data as any[]).filter(j => inDay(j.scheduled_start, todayStart, todayEnd)))
    : null

  if (entriesRes.data) {
    // A clock-in made offline is a queued upsert; a clock-out or pause is a
    // queued update that stamps clocked_out_at on it.
    const open = (await overlayPending('job_time_entries', entriesRes.data as any[], v => v.user_id === userId))
      .filter((e: any) => !e.clocked_out_at)
    if (open.length > 0) {
      if (!daily) {
        const clockedIn = jobsClockedInto(open, todays ?? [])
        return { working: true, activeJob: clockedIn[0] ?? null, fenceJobs: clockedIn }
      }
      const activeJob = todays ? pickActiveJob(todays) : null
      return { working: true, activeJob, fenceJobs: activeJob ? [activeJob] : [] }
    }
  }
  if (!todays) return { working: null, activeJob: null, fenceJobs: [] }
  const working = todays.some((j: any) => j.status === 'en_route' || (daily && j.status === 'in_progress'))
  if (!working && !entriesRes.data) return { working: null, activeJob: null, fenceJobs: [] }
  // Per-job with no open punch means en route: nothing to name or fence yet.
  const activeJob = working && daily ? pickActiveJob(todays) : null
  return { working, activeJob, fenceJobs: activeJob ? [activeJob] : [] }
}

function inDay(iso: string, start: Date, end: Date): boolean {
  const t = new Date(iso).getTime()
  return t >= start.getTime() && t <= end.getTime()
}

// The cleans a per-job crew member is clocked into, newest punch first. Any
// open punch on a clean counts, whatever its entry_type ('job' exists as well
// as 'work'). A punch queued offline for a clean that isn't in today's read has
// no address to fence yet, but its id still names the clean on the map.
function jobsClockedInto(open: any[], todays: any[]): any[] {
  const punches = open
    .filter((e: any) => e.job_id && e.entry_type !== 'shift')
    .sort((a: any, b: any) => ms(b.clocked_in_at) - ms(a.clocked_in_at))
  const seen = new Set<string>()
  const jobs: any[] = []
  for (const e of punches) {
    if (seen.has(e.job_id)) continue
    seen.add(e.job_id)
    // Today's copy first: it carries queued status changes.
    jobs.push(todays.find((j: any) => j.id === e.job_id) ?? e.jobs ?? { id: e.job_id })
  }
  return jobs
}

function ms(iso: any): number {
  const t = new Date(iso ?? 0).getTime()
  return Number.isFinite(t) ? t : 0
}

// The clean a day-shift crew member is on: the LAST one in progress in their
// day order (byCrewDayOrder). Two in progress at once is normal (a paused clean,
// or one the completion gate held open, and then the next one started), and
// they work the day in order, so the later clean is where they are. The old
// lookup returned none with two, which switched the fence off until one closed.
function pickActiveJob(todays: any[]) {
  const inProgress = todays.filter((j: any) => j.status === 'in_progress').sort(byCrewDayOrder)
  return inProgress[inProgress.length - 1] ?? null
}

export async function startLocationTracking(user: any, opts?: { requestBackground?: boolean }) {
  currentUser = user

  // Foreground only — silent ask, will use cached status if already answered.
  const fgStatus = await ensureForegroundLocation({ silent: true })
  if (fgStatus !== 'granted') return

  // Only broadcast while actively working. If not (e.g. app just opened with no
  // job, or clocked out), make sure any prior tracking — including a lingering
  // background task from an earlier session — is fully stopped and the dispatch
  // dot is removed. Off the clock = off the map.
  const { working } = await checkWork(user.id, await isDailyMode(user))
  if (working === false) {
    await stopLocationTracking()
    return
  }
  // Offline with nothing saved to decide from: don't START broadcasting on a
  // guess, and don't tear down tracking that may belong to a live shift.
  if (working === null) return

  // Background ("Always") is a stronger ask, so we only escalate to the OS
  // prompt at a user-initiated work moment (clock-in / start-of-day) — never on
  // plain app launch, which just reads the cached status. silent:true means a
  // past denial won't nag with the Settings alert on every clock-in.
  const bgStatus = opts?.requestBackground
    ? await ensureBackgroundLocation({ silent: true })
    : await getBackgroundLocationStatus()

  // Without "Always", the dispatch dot dies the moment the screen sleeps —
  // crew mid-clean silently fall off the map after 20 minutes. Explain that
  // ONCE at a clock-in moment (never on app launch, never repeatedly).
  if (opts?.requestBackground && bgStatus !== 'granted') {
    try {
      const NUDGE_KEY = 'bg_location_map_nudge_shown'
      if (!(await AsyncStorage.getItem(NUDGE_KEY))) {
        await AsyncStorage.setItem(NUDGE_KEY, '1')
        Alert.alert(
          tStatic('bg_nudge_title'),
          Platform.OS === 'ios' ? tStatic('bg_nudge_ios') : tStatic('bg_nudge_android'),
          [
            { text: tStatic('bg_nudge_later'), style: 'cancel' },
            { text: tStatic('bg_nudge_settings'), onPress: () => Linking.openSettings() },
          ],
        )
      }
    } catch { /* education is best-effort */ }
  }

  // Register the OS background task ONLY now that we've confirmed they're
  // working. Previously this ran BEFORE the work check, so an Always-granted
  // phone kept pinging location with no job and the app closed.
  if (bgStatus === 'granted') {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK)
    if (!isRegistered) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: PING_INTERVAL,
        distanceInterval: 100, // also trigger on 100m movement
        deferredUpdatesInterval: PING_INTERVAL,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'Rinsebase',
          notificationBody: 'Tracking location for active job',
          notificationColor: '#D4A843',
        },
      })
    }
  }

  // Start periodic pinging. Clear any existing timer first — clock-in, resume
  // and relaunch all call this, and stacked intervals meant duplicate pings.
  // Swap the timer BEFORE the first ping's await: two overlapping calls used to
  // both clear an empty slot, then both set one, leaking an interval.
  if (pingTimer) clearInterval(pingTimer)
  pingTimer = setInterval(() => pingLocation(user), PING_INTERVAL)
  await pingLocation(user)
}

export async function stopLocationTracking() {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  // Stop background tracking
  const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK)
  if (isRegistered) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK)
  }
  // Remove this crew member's live dot from dispatch. Without this the last
  // known position lingers in crew_locations forever and keeps showing on the
  // map ("why am I always on the map?"). RLS lets a user delete their own row
  // (crew_update_own_location). Best-effort — a server cron also expires stale
  // rows as a safety net.
  const u = currentUser
  if (u?.id && u?.tenant_id) {
    try {
      await supabase.from('crew_locations').delete().eq('tenant_id', u.tenant_id).eq('user_id', u.id)
    } catch { /* best-effort */ }
  }
}

// Stop tracking when the crew member is genuinely done working — no open time
// entry (work or shift) and nothing else checkWork counts as working. Called
// after clock-out / job completion. Before this, per-job crews had NO stop path
// at all: the ping timer and the OS background task ran until the app was
// killed (battery drain + "why is it tracking me at home"). Daily-shift crews
// keep tracking until "End my day" because their shift entry stays open.
export async function maybeStopLocationTracking(user: any) {
  try {
    currentUser = user // so stopLocationTracking clears the right row
    // Stop only on a definite "not working" — which offline includes a
    // clock-out that is still queued. Can't tell → keep tracking; the next
    // ping re-checks.
    if ((await checkWork(user.id, await isDailyMode(user))).working !== false) return
    await stopLocationTracking()
  } catch { /* best-effort — worst case tracking continues as before */ }
}

// Day-shift tenants (time_tracking_mode = 'daily') have no per-job clock: the
// "active job" the departure check keys on is merely a clean marked started.
// App.tsx caches the mode on the user as _timeMode; the headless background
// task rebuilds a bare user, so fall back to the tenant row. That read is
// cached: the mode decides what counts as working and which push is true, so a
// headless relaunch in a dead zone must still know it.
async function isDailyMode(user: any): Promise<boolean> {
  if (user?._timeMode) return user._timeMode === 'daily'
  try {
    const { data } = await cachedQuery(`track:mode:${user.tenant_id}`, supabase.from('tenants')
      .select('time_tracking_mode').eq('id', user.tenant_id).maybeSingle())
    return (data as any)?.time_tracking_mode === 'daily'
  } catch { return false }
}

// The "you left the property" push. Two versions, because the wrong one is a
// lie: a per-job crew member IS still clocked in and should clock out; a
// day-shift crew member has no per-job clock — their paid day is untouched —
// they just left a clean that isn't marked complete. Telling them to "clock
// out" sends them looking for a button that does not exist in that mode.
async function notifyLeftProperty(daily: boolean, jobId: string, property: string, extra: Record<string, any> = {}) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: tStatic(daily ? 'left_site_daily_title' : 'left_site_clocked_title'),
      body: ti(tStatic(daily ? 'left_site_daily_body' : 'left_site_clocked_body'), { property }),
      sound: 'default',
      data: { type: 'geofence_alert', jobId },
      ...extra,
    },
    trigger: null,
  })
}

// ── BACKGROUND TASK HANDLER ──
// This runs even when the app is in the background
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error) { console.warn('Background location error:', error); return }
  if (!data) return

  const { locations } = data as { locations: Location.LocationObject[] }
  if (!locations || locations.length === 0) return

  const loc = locations[locations.length - 1] // most recent

  // Module state dies with the process: when the OS relaunches us headless
  // for a location update, currentUser is null — rebuild it from the stored
  // session instead of dropping the ping. Read from storage, not getUser():
  // getUser() is a network call (and with the hour-long token lapsed it first
  // spends ~25 s trying to renew it), so in a dead zone every background wake
  // used to end right here.
  let user = currentUser
  if (!user) {
    try {
      const authId = (await readStoredSession())?.user?.id
      if (!authId) return
      // The row the database acts as (see myUsersRow.ts); .maybeSingle() errored
      // when both of the login's rows were readable.
      const { data: rows, error } = await supabase.from('users')
        .select('id, tenant_id, auth_user_id, is_active')
        .or(myUsersRowFilter(authId))
      const u = pickMyUsersRow(rows, authId)
      // Offline: the profile App.tsx saved at the last good load.
      const found = u ?? (error ? await loadCachedProfile(authId) : null)
      if (!found) return
      currentUser = found
      user = found
    } catch { return }
  }

  try {
    // Off the clock? Self-terminate: stop the background task, drop the dispatch
    // dot, and record nothing. This is what stops an Always-granted phone from
    // reporting location after the crew member is done for the day. Only on a
    // definite no: a dead zone mid-clean is not "off the clock".
    const daily = await isDailyMode(user)
    const { working, activeJob, fenceJobs } = await checkWork(user.id, daily)
    if (working === false) {
      await stopLocationTracking()
      return
    }

    // Update crew location
    await supabase.from('crew_locations').upsert({
      tenant_id: user.tenant_id,
      user_id: user.id,
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      accuracy: loc.coords.accuracy,
      job_id: activeJob?.id || null,
      status: activeJob ? 'active' : 'idle',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,user_id' })

    // Geofence check: every clean the push would be true about (see checkWork)
    for (const job of fenceJobs) {
      const addr = job.client_addresses as any
      if (!canFenceOn(addr)) continue
      const dist = haversineDistance(loc.coords.latitude, loc.coords.longitude, addr.lat, addr.lng)

      if (await claimDepartureAlert(job.id, dist > GEOFENCE_RADIUS)) {
        await notifyLeftProperty(daily, job.id, addr.nickname || addr.street || tStatic('arrival_generic_property'))
      }
    }
  } catch (e) {
    console.warn('Background location task failed:', e)
  }
})

async function pingLocation(user: any) {
  try {
    // Stop the moment they're no longer working — belt-and-suspenders with
    // maybeStopLocationTracking so a stray timer can't keep broadcasting.
    // Only on a definite no (see checkWork).
    const daily = await isDailyMode(user)
    const { working, activeJob, fenceJobs } = await checkWork(user.id, daily)
    if (working === false) {
      await stopLocationTracking()
      return
    }

    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    })

    const jobId = activeJob?.id || null
    const status = activeJob ? 'active' : 'idle'

    await supabase.from('crew_locations').upsert({
      tenant_id: user.tenant_id,
      user_id: user.id,
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      accuracy: loc.coords.accuracy,
      job_id: jobId,
      status,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,user_id' })

    // ── GEOFENCE CHECK ──
    // Every clean the push would be true about: per-job, each one they are
    // clocked into; daily, the clean in progress (see checkWork)
    for (const job of fenceJobs) {
      const addr = job.client_addresses as any
      if (!canFenceOn(addr)) continue
      const dist = haversineDistance(loc.coords.latitude, loc.coords.longitude, addr.lat, addr.lng)

      if (await claimDepartureAlert(job.id, dist > GEOFENCE_RADIUS)) {
        const propertyName = addr.nickname || addr.street || tStatic('arrival_generic_property')

        // Fire local push notification
        await notifyLeftProperty(daily, job.id, propertyName, { categoryIdentifier: 'geofence' })

        // Log the geofence departure (non-blocking — if this fails,
        // the push already fired, so we just swallow the error)
        try {
          await supabase.from('notification_log').insert({
            tenant_id: user.tenant_id,
            job_id: job.id,
            user_id: user.id,
            type: 'geofence_departure',
            channel: 'push',
            message: `Left ${propertyName} while clocked in (${Math.round(dist)}m away)`,
          })
        } catch { /* non-blocking */ }
      }
    }

  } catch (e) {
    console.warn('Location ping failed:', e)
  }
}
