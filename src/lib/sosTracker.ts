// src/lib/sosTracker.ts
// Location trail for a live SOS alert — writes sos_pings rows so the owner's
// Safety alerts page can follow a crew member who is moving (or being moved)
// after the panic button was pressed.
//
// WHY THIS IS ITS OWN BACKGROUND TASK, not a hook into locationTracker.ts:
//
//  1. locationTracker self-terminates whenever isActivelyWorking() is false.
//     An SOS can fire off the clock — walking to the van, between jobs, after
//     a shift. Piggybacking would kill the trail for exactly the crew who most
//     need it.
//  2. It pings every 5 minutes. A 5-minute-stale position is close to useless
//     when someone is being followed to their car; SOS wants ~1 minute.
//  3. It deletes the crew_locations row on stop. Different lifecycle entirely.
//
// And it MUST be a real OS background task, not a JS setInterval: in a genuine
// emergency the crew member locks the phone, opens Maps, or dials 911 — every
// one of which backgrounds the app and freezes a JS timer. That is the same
// failure that made foreground-only mileage tracking die mid-drive. The JS
// interval below is only a fallback for phones that never granted "Always".

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { getBackgroundLocationStatus, getForegroundLocationStatus } from './permissions'

const SOS_PING_TASK = 'sos-ping-task'
const ACTIVE_KEY = 'sos:active'
const PING_INTERVAL = 60 * 1000 // 1 minute — an emergency, not a commute

// Hard stop. If an alert is never resolved (owner misses it, crew reinstalls,
// app is killed mid-incident) the trail must not ping the crew member's
// location forever. Four hours is far longer than any real response window.
const MAX_TRAIL_MS = 4 * 60 * 60 * 1000

interface ActiveSOS {
  alertId: string
  startedAt: number
}

let pingTimer: any = null

// Module state dies whenever the OS restarts the process (backgrounding, or a
// headless relaunch to deliver a location update), so the active alert lives
// in AsyncStorage — same pattern as the geofence dismissals.
async function readActive(): Promise<ActiveSOS | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_KEY)
    return raw ? JSON.parse(raw) as ActiveSOS : null
  } catch { return null }
}
async function writeActive(v: ActiveSOS | null) {
  try {
    if (v) await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(v))
    else await AsyncStorage.removeItem(ACTIVE_KEY)
  } catch { /* best-effort */ }
}

// Does this alert still need a trail? Returns false ONLY on a positive read of
// a non-active status. Anything else — offline, request error, no row — counts
// as still open.
//
// Failing open is the deliberate choice here: the cost of a false "resolved"
// is that a crew member in trouble silently stops being tracked, while the
// cost of a false "still open" is some extra pings until "I'm OK" or
// MAX_TRAIL_MS. Those are not close.
async function isAlertStillOpen(alertId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('sos_alerts').select('status').eq('id', alertId).maybeSingle()
    if (error || !data) return true // unreadable ≠ resolved
    return data.status === 'active'
  } catch {
    return true // offline ≠ resolved
  }
}

// One fix → one sos_pings row. RLS `sos_pings_insert` checks the parent alert
// belongs to the caller's tenant, which holds for the crew member who raised
// it. lat/lng/recorded_at are NOT NULL in the DB; recorded_at defaults to now().
async function recordPing(alertId: string, coords: { latitude: number; longitude: number }) {
  await supabase.from('sos_pings').insert({
    alert_id: alertId,
    lat: coords.latitude,
    lng: coords.longitude,
  })
}

// Shared by the JS fallback timer and the OS background task.
async function pingOnce(): Promise<void> {
  const active = await readActive()
  if (!active) { await stopSOSTrail(); return }

  if (Date.now() - active.startedAt > MAX_TRAIL_MS) {
    await stopSOSTrail()
    return
  }
  if (!(await isAlertStillOpen(active.alertId))) {
    await stopSOSTrail()
    return
  }

  try {
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
    await recordPing(active.alertId, loc.coords)
  } catch (e) {
    // A single missed fix is not a reason to tear the trail down — the next
    // tick may well get one.
    console.warn('SOS ping failed:', e)
  }
}

// Begin trailing. Called right after the alert row lands. Never throws: the
// alert itself is already delivered by this point and nothing here is allowed
// to take the SOS screen down with it.
export async function startSOSTrail(alertId: string) {
  try {
    await writeActive({ alertId, startedAt: Date.now() })

    if (await getForegroundLocationStatus() !== 'granted') return

    // Register the OS task if — and only if — "Always" was already granted.
    // Deliberately NOT requesting it here: throwing a permission dialog at
    // someone mid-emergency is the wrong moment to ask, and a denial tap would
    // cost them seconds. Crews who clocked in through JobDetailScreen have
    // already been asked at the right moment.
    if (await getBackgroundLocationStatus() === 'granted') {
      const registered = await TaskManager.isTaskRegisteredAsync(SOS_PING_TASK)
      if (!registered) {
        await Location.startLocationUpdatesAsync(SOS_PING_TASK, {
          accuracy: Location.Accuracy.High,
          timeInterval: PING_INTERVAL,
          distanceInterval: 25, // also fire on movement — being moved is the signal
          showsBackgroundLocationIndicator: true,
          pausesUpdatesAutomatically: false,
          foregroundService: {
            notificationTitle: 'Rinsebase — SOS active',
            notificationBody: 'Sharing your location with your team',
            notificationColor: '#EF4444',
          },
        })
      }
    }

    // Foreground fallback runs regardless. On an "Always" phone it is harmless
    // redundancy; on a "While Using" phone it is the only trail there is, for
    // as long as the screen stays on.
    if (pingTimer) clearInterval(pingTimer)
    await pingOnce()
    pingTimer = setInterval(() => { pingOnce().catch(() => {}) }, PING_INTERVAL)
  } catch (e) {
    console.warn('startSOSTrail failed:', e)
  }
}

export async function stopSOSTrail() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(SOS_PING_TASK)
    if (registered) await Location.stopLocationUpdatesAsync(SOS_PING_TASK)
  } catch { /* best-effort */ }
  await writeActive(null)
}

// Called on app launch. An SOS that survived a process restart (or a phone
// reboot) must keep trailing; one that was resolved while the app was dead
// must not silently resume.
export async function resumeSOSTrailIfOpen() {
  try {
    const active = await readActive()
    if (!active) return
    if (Date.now() - active.startedAt > MAX_TRAIL_MS) { await stopSOSTrail(); return }
    if (!(await isAlertStillOpen(active.alertId))) { await stopSOSTrail(); return }
    await startSOSTrail(active.alertId)
  } catch { /* best-effort */ }
}

// Look up the alert this device just raised. Kept as a separate read rather
// than adding .select() to sendSOS's insert, so that nothing about resolving
// the trail's alert id can throw on the insert path — delivering the alert is
// the part that must not fail, and the trail is best-effort on top of it.
export async function findMyOpenAlertId(userId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('sos_alerts').select('id').eq('user_id', userId).eq('status', 'active')
      .order('triggered_at', { ascending: false }).limit(1).maybeSingle()
    return data?.id ?? null
  } catch { return null }
}

// ── BACKGROUND TASK ──
// Runs even with the app backgrounded or killed — the whole point of this file.
TaskManager.defineTask(SOS_PING_TASK, async ({ data, error }: any) => {
  if (error) { console.warn('SOS background task error:', error); return }

  const active = await readActive()
  if (!active) { await stopSOSTrail(); return }

  if (Date.now() - active.startedAt > MAX_TRAIL_MS) { await stopSOSTrail(); return }
  if (!(await isAlertStillOpen(active.alertId))) { await stopSOSTrail(); return }

  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] }
  if (!locations?.length) return

  try {
    const loc = locations[locations.length - 1]
    await recordPing(active.alertId, loc.coords)
  } catch (e) {
    console.warn('SOS background ping failed:', e)
  }
})
