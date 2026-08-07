// src/lib/arrivalGeofence.ts
// Arrival-triggered clock-in prompts (GPS-verified time tracking, Phase 1).
//
// Uses OS geofence REGIONS (Location.startGeofencingAsync), not continuous
// tracking — the OS wakes us only when the phone crosses a property fence, so
// the "off the clock = off the map" privacy model in locationTracker.ts is
// untouched. The only pre-clock-in datum ever recorded is the arrival event at
// the property itself: stored on-device, and written to the time entry only if
// the crew member actually clocks in (clocked_in_at backdates to it — the
// QuickBooks Time pattern: human confirms, no minutes lost).
// Spec: rinse-base-app docs/gps-arrival-clock-in-spec.md

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import * as Notifications from 'expo-notifications'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { getBackgroundLocationStatus } from './permissions'
import { tStatic, ti } from './i18n'

const ARRIVAL_TASK = 'arrival-geofence-task'
const RADIUS_M = 150
const AUTO_MAX_SPEED_MPS = 3 // ~7 mph — faster than a walk = still driving, not working
const MAX_REGIONS = 18            // iOS caps 20 monitored regions per app; leave headroom
const ARRIVAL_FRESH_MS = 12 * 60 * 60 * 1000
const ARRIVAL_KEY = (jobId: string) => `arrival:${jobId}`
const PROMPTED_KEY = (jobId: string) => `arrival_prompted:${jobId}`

export interface PendingArrival {
  at: string   // ISO instant the fence was crossed
  lat: number
  lng: number
}

// Is this address accurate enough to hang a 150m fence on?
//
// client_addresses.geocode_precision === 'approximate' is a ZIP/city centroid,
// written when no geocoder could resolve the street address. It sits 1-3km
// from the real building — 7-20x this radius. Fencing on one is wrong in both
// directions: the crew arriving at the actual property never crosses the
// fence (no prompt, no auto punch), while driving past the centroid — the
// town centre, which is exactly where roads go — does cross it. The auto-punch
// check below measures distance from the REGION centre, not the property, so a
// crew member stopped at a light near the centroid passes both the distance
// and speed tests and gets a time entry for a job they haven't reached.
// "A spurious notification is recoverable, a spurious time entry is somebody's
// pay" — so such addresses get no fence at all.
//
// A null precision is a legacy coordinate of unknown provenance and stays
// trusted, exactly as before the column existed.
// `!= null` rather than falsy: latitude 0 / longitude 0 are valid.
function canFenceOn(addr: any): boolean {
  return !!addr && addr.lat != null && addr.lng != null && addr.geocode_precision !== 'approximate'
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Register one enter-only region per still-active assigned job today.
// Call on Dashboard load / refresh. Fails quiet on every path — arrival
// prompts are an enhancement; manual clock-in must never depend on them.
export async function refreshArrivalGeofences(user: any) {
  try {
    if (!user?.id) return
    // Daily-shift crews have no per-job clock — prompting them to "clock in"
    // per property would be wrong. (Phase 3 may log bare arrival events.)
    if (user._timeMode === 'daily') { await stopArrivalGeofences(); return }
    // Geofencing needs "Always"; the clock-in moment owns that escalation.
    if ((await getBackgroundLocationStatus()) !== 'granted') return

    const now = new Date()
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999)
    const { data: jobs } = await supabase
      .from('jobs')
      .select('id, scheduled_start, job_assignments!inner(user_id), client_addresses!jobs_address_id_fkey(lat, lng, geocode_precision)')
      .eq('job_assignments.user_id', user.id)
      .in('status', ['pending_approval', 'scheduled', 'en_route'])
      .gte('scheduled_start', dayStart.toISOString())
      .lte('scheduled_start', dayEnd.toISOString())
      .order('scheduled_start')
      .limit(MAX_REGIONS)

    const regions = (jobs ?? [])
      .filter((j: any) => canFenceOn(j.client_addresses))
      .map((j: any) => ({
        identifier: j.id,
        latitude: Number(j.client_addresses.lat),
        longitude: Number(j.client_addresses.lng),
        radius: RADIUS_M,
        notifyOnEnter: true,
        notifyOnExit: false,
      }))

    if (regions.length === 0) { await stopArrivalGeofences(); return }
    // startGeofencingAsync REPLACES the monitored set, so stale regions from
    // yesterday's jobs drop off automatically.
    await Location.startGeofencingAsync(ARRIVAL_TASK, regions)
  } catch { /* enhancement only — never break the dashboard */ }
}

export async function stopArrivalGeofences() {
  try {
    if (await TaskManager.isTaskRegisteredAsync(ARRIVAL_TASK)) {
      await Location.stopGeofencingAsync(ARRIVAL_TASK)
    }
  } catch { /* best-effort */ }
}

// The recorded fence-entry for a job, if fresh — read at clock-in to backdate
// the entry and stamp coordinates. Cleared after use (clearPendingArrival).
export async function getPendingArrival(jobId: string): Promise<PendingArrival | null> {
  try {
    const raw = await AsyncStorage.getItem(ARRIVAL_KEY(jobId))
    if (!raw) return null
    const a = JSON.parse(raw) as PendingArrival
    if (Date.now() - new Date(a.at).getTime() > ARRIVAL_FRESH_MS) return null
    return a
  } catch { return null }
}

export async function clearPendingArrival(jobId: string) {
  try { await AsyncStorage.removeItem(ARRIVAL_KEY(jobId)) } catch { /* best-effort */ }
}

// ── BACKGROUND GEOFENCE HANDLER ──
// Runs headless when the OS detects a region crossing; module state can be
// fresh, so everything is rebuilt from storage/session (same pattern as
// crew-location-task).
TaskManager.defineTask(ARRIVAL_TASK, async ({ data, error }: any) => {
  if (error || !data) return
  const { eventType, region } = data as { eventType: Location.GeofencingEventType; region: Location.LocationRegion }
  if (eventType !== Location.GeofencingEventType.Enter || !region?.identifier) return
  const jobId = region.identifier

  try {
    // One prompt per job per 12h — re-entering the fence (lunch run, supply
    // trip) must not re-nag.
    const prompted = await AsyncStorage.getItem(PROMPTED_KEY(jobId))
    if (prompted && Date.now() - Number(prompted) < ARRIVAL_FRESH_MS) return

    // Rebuild the user (headless launch has no module state).
    const { data: auth } = await supabase.auth.getUser()
    const authId = auth?.user?.id
    if (!authId) return
    const { data: user } = await supabase.from('users')
      .select('id, tenant_id')
      .or(`auth_user_id.eq.${authId},id.eq.${authId}`)
      .maybeSingle()
    if (!user) return

    // Job still worth prompting for? (Not started/completed/cancelled by a
    // teammate, and this user isn't already on the clock for it.)
    const { data: job } = await supabase
      .from('jobs')
      .select('id, status, scheduled_start, client_addresses!jobs_address_id_fkey(nickname, street, lat, lng, geocode_precision)')
      .eq('id', jobId)
      .in('status', ['pending_approval', 'scheduled', 'en_route'])
      .maybeSingle()
    if (!job) return
    // Re-check precision at fire time, not just at registration. A region
    // registered this morning can outlive the coordinate it was built from —
    // the geocoder cron re-runs every 20 minutes and may have downgraded the
    // address since. This path can insert a time entry, so it verifies rather
    // than trusting the stale region.
    if (!canFenceOn((job as any).client_addresses)) return
    const { data: openEntry } = await supabase
      .from('job_time_entries').select('id')
      .eq('job_id', jobId).eq('user_id', user.id).is('clocked_out_at', null).limit(1)
    if ((openEntry?.length ?? 0) > 0) return

    // Record the arrival FIRST — even if the notification is missed, the next
    // manual clock-in on this job backdates to this instant.
    const arrival: PendingArrival = {
      at: new Date().toISOString(),
      lat: (region as any).latitude ?? 0,
      lng: (region as any).longitude ?? 0,
    }
    await AsyncStorage.setItem(ARRIVAL_KEY(jobId), JSON.stringify(arrival))
    await AsyncStorage.setItem(PROMPTED_KEY(jobId), String(Date.now()))

    const addr = (job as any).client_addresses
    const property = addr?.nickname || addr?.street || tStatic('arrival_generic_property')

    // ── PHASE 2: tenant opt-in AUTO punch ──
    // Only when the owner enabled it AND the arrival verifies as a genuine
    // dwell: a fresh fix must land back inside the fence and not be moving at
    // driving speed — by the time the fix resolves (seconds later), a drive-by
    // is already outside the radius or still fast. Any doubt falls through to
    // the prompt: a spurious notification is recoverable, a spurious time
    // entry is somebody's pay.
    try {
      const { data: tenant } = await supabase.from('tenants')
        .select('auto_clock_in, time_tracking_mode')
        .eq('id', user.tenant_id).maybeSingle()
      // No auto-punch before the window opens — an early arrival gets the
      // prompt instead (backdate floor already handles early manual punches).
      const windowOpen = Date.now() >= new Date((job as any).scheduled_start).getTime() - 30 * 60000
      if (tenant?.auto_clock_in && tenant?.time_tracking_mode !== 'daily' && windowOpen) {
        const fix = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 8000)),
        ]) as Location.LocationObject | null
        const regionLat = (region as any).latitude
        const regionLng = (region as any).longitude
        const dist = fix && regionLat != null
          ? haversineM(fix.coords.latitude, fix.coords.longitude, regionLat, regionLng)
          : Infinity
        const speed = fix?.coords.speed ?? -1 // unknown reads as -1 → passes
        if (fix && dist <= RADIUS_M * 1.3 && speed < AUTO_MAX_SPEED_MPS) {
          const { data: entry, error: insErr } = await supabase.from('job_time_entries').insert({
            tenant_id: user.tenant_id, job_id: jobId, user_id: user.id,
            clocked_in_at: arrival.at, entry_type: 'work',
            source: 'auto', arrived_at: arrival.at,
            clock_in_lat: fix.coords.latitude, clock_in_lng: fix.coords.longitude,
          }).select('id').single()
          if (!insErr && entry) {
            await clearPendingArrival(jobId) // consumed — a manual punch must not double-enter
            // Mirror manual clock-in: the job is being worked now. Status guard
            // keeps a teammate's already-started job untouched.
            await supabase.from('jobs').update({ status: 'in_progress' })
              .eq('id', jobId).in('status', ['pending_approval', 'scheduled', 'en_route'])
            await Notifications.scheduleNotificationAsync({
              content: {
                title: `⏱ ${tStatic('auto_clock_in_title')}`,
                body: ti(tStatic('auto_clock_in_body'), {
                  property,
                  time: new Date(arrival.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                }),
                sound: 'default',
                data: { type: 'auto_clock_in', jobId },
              },
              trigger: null,
            })
            return // clocked in — no prompt needed
          }
        }
      }
    } catch { /* verification failed — fall through to the prompt */ }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: `📍 ${tStatic('arrival_prompt_title')}`,
        body: ti(tStatic('arrival_prompt_body'), { property }),
        sound: 'default',
        data: { type: 'arrival_prompt', jobId },
      },
      trigger: null,
    })
  } catch { /* headless best-effort */ }
})

// Best-effort quick GPS fix for stamping manual punches — must never block or
// fail the punch itself (the entry IS the crew member's pay).
export async function quickGpsStamp(timeoutMs = 2500): Promise<{ lat: number; lng: number } | null> {
  try {
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ])
    if (fix && (fix as Location.LocationObject).coords) {
      const { latitude, longitude } = (fix as Location.LocationObject).coords
      return { lat: latitude, lng: longitude }
    }
  } catch { /* no stamp — punch proceeds unstamped */ }
  return null
}
