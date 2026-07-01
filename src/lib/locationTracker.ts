// src/lib/locationTracker.ts
// Pings crew GPS every 5 minutes when they have an active job
// Monitors geofence — alerts crew if they leave job site without clocking out

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import * as Notifications from 'expo-notifications'
import { supabase } from './supabase'
import { ensureForegroundLocation, ensureBackgroundLocation, getBackgroundLocationStatus } from './permissions'

const LOCATION_TASK = 'crew-location-task'
const PING_INTERVAL = 5 * 60 * 1000 // 5 minutes
const GEOFENCE_RADIUS = 300 // meters — trigger alert if crew is farther than this
const GEOFENCE_DISMISS_DURATION = 15 * 60 * 1000 // 15 minutes after "Still working"

let pingTimer: any = null
let currentUser: any = null
let geofenceDismissedUntil: Record<string, number> = {} // jobId → timestamp

export function setTrackedUser(user: any) {
  currentUser = user
}

// Dismiss geofence alert for a specific job (crew tapped "Still working")
export function dismissGeofenceAlert(jobId: string) {
  geofenceDismissedUntil[jobId] = Date.now() + GEOFENCE_DISMISS_DURATION
}

// Haversine distance in meters
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export async function startLocationTracking(user: any, opts?: { requestBackground?: boolean }) {
  currentUser = user

  // Foreground only — silent ask, will use cached status if already answered.
  const fgStatus = await ensureForegroundLocation({ silent: true })
  if (fgStatus !== 'granted') return

  // Background ("Always") is a stronger ask, so we only escalate to the OS
  // prompt at a user-initiated work moment (clock-in / start-of-day) — never
  // on plain app launch, which just reads the cached status. silent:true means
  // a past denial won't nag with the Settings alert on every clock-in.
  const bgStatus = opts?.requestBackground
    ? await ensureBackgroundLocation({ silent: true })
    : await getBackgroundLocationStatus()

  // Start background location task if user has previously opted into Always
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

  // Check if user has any active jobs today
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0)
  const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999)

  const { data: assignments } = await supabase
    .from('job_assignments')
    .select('job_id')
    .eq('user_id', user.id)

  const myJobIds = (assignments ?? []).map((a: any) => a.job_id)

  let hasTodayJob = false
  if (myJobIds.length > 0) {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('id')
      .in('id', myJobIds)
      .gte('scheduled_start', todayStart.toISOString())
      .lte('scheduled_start', todayEnd.toISOString())
      .neq('status', 'cancelled')
    hasTodayJob = (jobs?.length ?? 0) > 0
  }

  // Also track whenever the crew member is CLOCKED IN — any open time entry,
  // per-job ('work') or day-shift ('shift') — even on a job they aren't a
  // formal job_assignment on. Being on the clock is what "working" means; the
  // old assignment-only gate meant clocked-in-but-unassigned crew (and shift
  // workers) never broadcast a location.
  const { data: openEntry } = await supabase
    .from('job_time_entries')
    .select('id')
    .eq('user_id', user.id)
    .is('clocked_out_at', null)
    .limit(1)
  const clockedIn = (openEntry?.length ?? 0) > 0

  if (!hasTodayJob && !clockedIn) return // not working right now — nothing to track

  // Start periodic pinging
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
