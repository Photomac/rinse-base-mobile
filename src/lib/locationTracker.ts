// src/lib/locationTracker.ts
// Pings crew GPS every 5 minutes when they have an active job
// Monitors geofence — alerts crew if they leave job site without clocking out

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import * as Notifications from 'expo-notifications'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { ensureForegroundLocation, ensureBackgroundLocation, getBackgroundLocationStatus } from './permissions'

const LOCATION_TASK = 'crew-location-task'
const PING_INTERVAL = 5 * 60 * 1000 // 5 minutes
const GEOFENCE_RADIUS = 300 // meters — trigger alert if crew is farther than this
const GEOFENCE_DISMISS_DURATION = 15 * 60 * 1000 // 15 minutes after "Still working"

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
async function isActivelyWorking(userId: string): Promise<boolean> {
  const { data: openEntry } = await supabase
    .from('job_time_entries').select('id').eq('user_id', userId).is('clocked_out_at', null).limit(1)
  if ((openEntry?.length ?? 0) > 0) return true
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999)
  const { data: active } = await supabase
    .from('jobs').select('id, job_assignments!inner(user_id)')
    .eq('job_assignments.user_id', userId)
    .in('status', ['en_route', 'in_progress'])
    .gte('scheduled_start', todayStart.toISOString())
    .lte('scheduled_start', todayEnd.toISOString())
    .limit(1)
  return (active?.length ?? 0) > 0
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
  if (!(await isActivelyWorking(user.id))) {
    await stopLocationTracking()
    return
  }

  // Background ("Always") is a stronger ask, so we only escalate to the OS
  // prompt at a user-initiated work moment (clock-in / start-of-day) — never on
  // plain app launch, which just reads the cached status. silent:true means a
  // past denial won't nag with the Settings alert on every clock-in.
  const bgStatus = opts?.requestBackground
    ? await ensureBackgroundLocation({ silent: true })
    : await getBackgroundLocationStatus()

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
    if (await isActivelyWorking(user.id)) return // still working — keep tracking
    await stopLocationTracking()
  } catch { /* best-effort — worst case tracking continues as before */ }
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
  // session instead of dropping the ping.
  let user = currentUser
  if (!user) {
    try {
      const { data: auth } = await supabase.auth.getUser()
      const authId = auth?.user?.id
      if (!authId) return
      const { data: u } = await supabase.from('users')
        .select('id, tenant_id')
        .or(`auth_user_id.eq.${authId},id.eq.${authId}`)
        .maybeSingle()
      if (!u) return
      currentUser = u
      user = u
    } catch { return }
  }

  try {
    // Off the clock? Self-terminate: stop the background task, drop the dispatch
    // dot, and record nothing. This is what stops an Always-granted phone from
    // reporting location after the crew member is done for the day.
    if (!(await isActivelyWorking(user.id))) {
      await stopLocationTracking()
      return
    }

    // Find this crew member's active job
    const now = new Date()
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999)

    // Get this user's assigned jobs that are in_progress
    const { data: myAssignments } = await supabase
      .from('job_assignments').select('job_id').eq('user_id', user.id)
    const myJobIds = (myAssignments ?? []).map((a: any) => a.job_id)

    let activeJob: any = null
    if (myJobIds.length > 0) {
      const { data } = await supabase
        .from('jobs')
        .select('id, status, client_addresses!jobs_address_id_fkey(lat, lng, nickname, street)')
        .in('id', myJobIds)
        .eq('status', 'in_progress')
        .gte('scheduled_start', todayStart.toISOString())
        .lte('scheduled_start', todayEnd.toISOString())
        .maybeSingle()
      activeJob = data
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
      if (addr.lat && addr.lng) {
        const dist = haversineDistance(loc.coords.latitude, loc.coords.longitude, addr.lat, addr.lng)
        await hydrateDismissals()
        const dismissed = geofenceDismissedUntil[activeJob.id] || 0

        if (dist > GEOFENCE_RADIUS && Date.now() > dismissed) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Still clocked in!',
              body: `You've left ${addr.nickname || addr.street || 'the property'} but you're still clocked in. Tap to clock out.`,
              sound: 'default',
              data: { type: 'geofence_alert', jobId: activeJob.id },
            },
            trigger: null,
          })
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
    if (!(await isActivelyWorking(user.id))) {
      await stopLocationTracking()
      return
    }

    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    })

    // Find this crew member's active job with address coordinates
    const now = new Date()
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0)
    const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999)

    const { data: myAssignments } = await supabase
      .from('job_assignments').select('job_id').eq('user_id', user.id)
    const myJobIds = (myAssignments ?? []).map((a: any) => a.job_id)

    let activeJob: any = null
    if (myJobIds.length > 0) {
      const { data } = await supabase
        .from('jobs')
        .select('id, status, client_addresses!jobs_address_id_fkey(lat, lng, nickname, street)')
        .in('id', myJobIds)
        .eq('status', 'in_progress')
        .gte('scheduled_start', todayStart.toISOString())
        .lte('scheduled_start', todayEnd.toISOString())
        .maybeSingle()
      activeJob = data
    }

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
      if (addr.lat && addr.lng) {
        const dist = haversineDistance(loc.coords.latitude, loc.coords.longitude, addr.lat, addr.lng)
        await hydrateDismissals()
        const dismissed = geofenceDismissedUntil[activeJob.id] || 0

        if (dist > GEOFENCE_RADIUS && Date.now() > dismissed) {
          const propertyName = addr.nickname || addr.street || 'your current job'

          // Fire local push notification
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Still clocked in!',
              body: `You've left ${propertyName} but you're still clocked in. Tap to clock out.`,
              sound: 'default',
              data: { type: 'geofence_alert', jobId: activeJob.id },
              categoryIdentifier: 'geofence',
            },
            trigger: null, // immediate
          })

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
