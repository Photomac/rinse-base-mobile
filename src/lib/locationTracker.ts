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

// Haversine distance in meters
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Is this crew member actively working RIGHT NOW — clocked in (per-job 'work'
// or day 'shift') OR en route / in progress on a job today? Merely having a job
// scheduled for later today is NOT "working" and must not broadcast a location
// (that was the "why am I on the map at home, with the app closed?" leak). This
// gates BOTH starting tracking and continuing it, so tracking self-terminates
// the moment someone goes off the clock.
//
// With no signal the answer comes from the last good copy of the same reads
// plus the punches and status changes still queued in the outbox. It used to
// read a failed query as "not working", so walking into a dead zone mid-clean
// switched tracking off — including the OS background task, which then stayed
// off after signal came back. `working` is null only when there is no way to
// tell (offline and nothing saved yet); each caller picks its safe side.
//
// Also returns the one in-progress job today, with its address, for the
// geofence check — from the same read, so offline the "you left the property
// while clocked in" reminder still fires.
// Exported for scripts/test-offline-auth.mjs.
export async function checkWork(userId: string): Promise<{ working: boolean | null; activeJob: any | null }> {
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999)
  const [entriesRes, jobsRes] = await Promise.all([
    cachedQuery(`track:open:${userId}`, supabase
      .from('job_time_entries').select('id, user_id, job_id, entry_type, clocked_out_at')
      .eq('user_id', userId).is('clocked_out_at', null).limit(20)),
    cachedQuery(`track:today:${userId}`, supabase
      .from('jobs')
      .select('id, status, scheduled_start, job_assignments!inner(user_id), client_addresses!jobs_address_id_fkey(lat, lng, geocode_precision, nickname, street)')
      .eq('job_assignments.user_id', userId)
      .gte('scheduled_start', todayStart.toISOString())
      .lte('scheduled_start', todayEnd.toISOString())),
  ])

  if (entriesRes.data) {
    // A clock-in made offline is a queued upsert; a clock-out or pause is a
    // queued update that stamps clocked_out_at on it.
    const entries = await overlayPending('job_time_entries', entriesRes.data as any[], v => v.user_id === userId)
    if (entries.some((e: any) => !e.clocked_out_at)) {
      return { working: true, activeJob: jobsRes.data ? await activeJobFrom(jobsRes.data as any[], todayStart, todayEnd) : null }
    }
  }
  if (!jobsRes.data) return { working: null, activeJob: null }
  // Saved rows can be from an earlier day: keep today's (the server already
  // did that for live rows). Queued en-route / start / complete apply on top.
  const todays = await overlayPending('jobs', (jobsRes.data as any[]).filter(j => inDay(j.scheduled_start, todayStart, todayEnd)))
  const working = todays.some((j: any) => j.status === 'en_route' || j.status === 'in_progress')
  if (!working && !entriesRes.data) return { working: null, activeJob: null }
  return { working, activeJob: working ? pickActiveJob(todays) : null }
}

function inDay(iso: string, start: Date, end: Date): boolean {
  const t = new Date(iso).getTime()
  return t >= start.getTime() && t <= end.getTime()
}

async function activeJobFrom(rows: any[], start: Date, end: Date) {
  return pickActiveJob(await overlayPending('jobs', rows.filter(j => inDay(j.scheduled_start, start, end))))
}

// The geofence needs exactly one clean in progress — with two it can't know
// which property to fence, same as the old .maybeSingle() lookup.
function pickActiveJob(todays: any[]) {
  const inProgress = todays.filter((j: any) => j.status === 'in_progress')
  return inProgress.length === 1 ? inProgress[0] : null
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
  const { working } = await checkWork(user.id)
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
  if (pingTimer) clearInterval(pingTimer)
  await pingLocation(user)
  pingTimer = setInterval(() => pingLocation(user), PING_INTERVAL)
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
// entry (work or shift) AND no still-active job today. Called after clock-out /
// job completion. Before this, per-job crews had NO stop path at all: the ping
// timer and the OS background task ran until the app was killed (battery drain
// + "why is it tracking me at home"). Daily-shift crews keep tracking until
// "End my day" because their shift entry stays open.
export async function maybeStopLocationTracking(user: any) {
  try {
    currentUser = user // so stopLocationTracking clears the right row
    // Stop only on a definite "not working" — which offline includes a
    // clock-out that is still queued. Can't tell → keep tracking; the next
    // ping re-checks.
    if ((await checkWork(user.id)).working !== false) return
    await stopLocationTracking()
  } catch { /* best-effort — worst case tracking continues as before */ }
}

// Day-shift tenants (time_tracking_mode = 'daily') have no per-job clock: the
// "active job" the departure check keys on is merely a clean marked started.
// App.tsx caches the mode on the user as _timeMode; the headless background
// task rebuilds a bare user, so fall back to the tenant row.
async function isDailyMode(user: any): Promise<boolean> {
  if (user?._timeMode) return user._timeMode === 'daily'
  try {
    const { data } = await supabase.from('tenants')
      .select('time_tracking_mode').eq('id', user.tenant_id).maybeSingle()
    return data?.time_tracking_mode === 'daily'
  } catch { return false }
}

// The "you left the property" push. Two versions, because the wrong one is a
// lie: a per-job crew member IS still clocked in and should clock out; a
// day-shift crew member has no per-job clock — their paid day is untouched —
// they just left a clean that isn't marked complete. Telling them to "clock
// out" sends them looking for a button that does not exist in that mode.
async function notifyLeftProperty(user: any, jobId: string, property: string, extra: Record<string, any> = {}) {
  const daily = await isDailyMode(user)
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
      const { data: u, error } = await supabase.from('users')
        .select('id, tenant_id')
        .or(`auth_user_id.eq.${authId},id.eq.${authId}`)
        .maybeSingle()
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
    const { working, activeJob } = await checkWork(user.id)
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

    // Geofence check
    if (activeJob?.client_addresses) {
      const addr = activeJob.client_addresses as any
      if (canFenceOn(addr)) {
        const dist = haversineDistance(loc.coords.latitude, loc.coords.longitude, addr.lat, addr.lng)
        await hydrateDismissals()
        const dismissed = geofenceDismissedUntil[activeJob.id] || 0

        if (dist > GEOFENCE_RADIUS && Date.now() > dismissed) {
          await notifyLeftProperty(user, activeJob.id, addr.nickname || addr.street || tStatic('arrival_generic_property'))
        }
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
    const { working, activeJob } = await checkWork(user.id)
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
    // If crew is clocked into a job, check if they've left the property
    if (activeJob && activeJob.client_addresses) {
      const addr = activeJob.client_addresses as any
      if (canFenceOn(addr)) {
        const dist = haversineDistance(loc.coords.latitude, loc.coords.longitude, addr.lat, addr.lng)
        await hydrateDismissals()
        const dismissed = geofenceDismissedUntil[activeJob.id] || 0

        if (dist > GEOFENCE_RADIUS && Date.now() > dismissed) {
          const propertyName = addr.nickname || addr.street || tStatic('arrival_generic_property')

          // Fire local push notification
          await notifyLeftProperty(user, activeJob.id, propertyName, { categoryIdentifier: 'geofence' })

          // Log the geofence departure (non-blocking — if this fails,
          // the push already fired, so we just swallow the error)
          try {
            await supabase.from('notification_log').insert({
              tenant_id: user.tenant_id,
              job_id: activeJob.id,
              user_id: user.id,
              type: 'geofence_departure',
              channel: 'push',
              message: `Left ${propertyName} while clocked in (${Math.round(dist)}m away)`,
            })
          } catch { /* non-blocking */ }
        }
      }
    }

  } catch (e) {
    console.warn('Location ping failed:', e)
  }
}
