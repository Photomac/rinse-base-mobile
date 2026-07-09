// src/lib/mileageTracker.ts
// Background GPS odometer for crew mileage trips.
//
// The old implementation was a foreground-only watchPositionAsync inside
// MileageScreen: the moment the crew member opened Google Maps to navigate
// (the normal thing to do on a drive) the app suspended and miles silently
// stopped counting; an OS kill lost the whole trip ("it stopped tracking
// because of Google Maps"). This runs as an OS background task — same
// infrastructure the geofence tracker uses — and persists the running total,
// so navigation, screen-off, and process death all keep the odometer honest.
import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { ensureForegroundLocation, ensureBackgroundLocation } from './permissions'

const MILEAGE_TASK = 'mileage-trip-task'
const STATE_KEY = 'mileage_trip_state'

export interface MileageTripState {
  startedAt: string
  miles: number
  lastLat: number | null
  lastLng: number | null
  background: boolean // OS task running vs foreground-only fallback
}

export async function getTripState(): Promise<MileageTripState | null> {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function setTripState(s: MileageTripState) {
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(s))
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Fold GPS points into the persisted trip total. Used by both the background
// task and the foreground fallback watcher, so there is exactly one odometer.
export async function accumulate(points: { latitude: number; longitude: number }[]) {
  const s = await getTripState()
  if (!s) return
  for (const p of points) {
    if (s.lastLat != null && s.lastLng != null) {
      const d = haversineMiles(s.lastLat, s.lastLng, p.latitude, p.longitude)
      if (d > 0.01) s.miles += d // ignore < ~50ft jitter
    }
    s.lastLat = p.latitude
    s.lastLng = p.longitude
  }
  s.miles = Math.round(s.miles * 100) / 100
  await setTripState(s)
}

// Runs headless — even with the app backgrounded or relaunched by the OS.
TaskManager.defineTask(MILEAGE_TASK, async ({ data, error }: any) => {
  if (error || !data) return
  const { locations } = data as { locations: Location.LocationObject[] }
  if (!locations?.length) return
  try { await accumulate(locations.map(l => l.coords)) } catch { /* next batch retries */ }
})

// Android's persistent notification text is passed in so it's localized.
export async function startTrip(strings: { title: string; body: string }): Promise<'background' | 'foreground' | 'denied'> {
  const fg = await ensureForegroundLocation()
  if (fg !== 'granted') return 'denied'

  await setTripState({ startedAt: new Date().toISOString(), miles: 0, lastLat: null, lastLng: null, background: false })

  // "Always" permission unlocks true background tracking. Starting a tracked
  // drive is a user-initiated moment, so the OS prompt is appropriate here —
  // but a past hard denial stays silent (the screen shows the fallback notice).
  const bg = await ensureBackgroundLocation({ silent: true })
  if (bg === 'granted') {
    if (!(await TaskManager.isTaskRegisteredAsync(MILEAGE_TASK))) {
      await Location.startLocationUpdatesAsync(MILEAGE_TASK, {
        accuracy: Location.Accuracy.High,
        distanceInterval: 25, // meters — smooth odometer without battery burn
        timeInterval: 5000,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: strings.title,
          notificationBody: strings.body,
          notificationColor: '#D4A843',
        },
      })
    }
    const s = await getTripState()
    if (s) await setTripState({ ...s, background: true })
    return 'background'
  }
  return 'foreground' // caller keeps a foreground watcher as the fallback
}

export async function stopTrip(): Promise<MileageTripState | null> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(MILEAGE_TASK)) {
      await Location.stopLocationUpdatesAsync(MILEAGE_TASK)
    }
  } catch { /* task may already be gone */ }
  const s = await getTripState()
  await AsyncStorage.removeItem(STATE_KEY)
  return s
}
