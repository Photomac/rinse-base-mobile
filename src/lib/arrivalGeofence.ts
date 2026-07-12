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
const MAX_REGIONS = 18            // iOS caps 20 monitored regions per app; leave headroom
const ARRIVAL_FRESH_MS = 12 * 60 * 60 * 1000
const ARRIVAL_KEY = (jobId: string) => `arrival:${jobId}`
const PROMPTED_KEY = (jobId: string) => `arrival_prompted:${jobId}`

export interface PendingArrival {
  at: string   // ISO instant the fence was crossed
  lat: number
  lng: number
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
      .select('id, scheduled_start, job_assignments!inner(user_id), client_addresses!jobs_address_id_fkey(lat, lng)')
      .eq('job_assignments.user_id', user.id)
      .in('status', ['pending_approval', 'scheduled', 'en_route'])
      .gte('scheduled_start', dayStart.toISOString())
      .lte('scheduled_start', dayEnd.toISOString())
      .order('scheduled_start')
      .limit(MAX_REGIONS)

    const regions = (jobs ?? [])
      .filter((j: any) => j.client_addresses?.lat && j.client_addresses?.lng)
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
      .select('id, status, scheduled_start, client_addresses!jobs_address_id_fkey(nickname, street)')
      .eq('id', jobId)
      .in('status', ['pending_approval', 'scheduled', 'en_route'])
      .maybeSingle()
    if (!job) return
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
