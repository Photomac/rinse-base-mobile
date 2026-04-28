// src/lib/permissions.ts
// Centralized permission flow so we don't fire request*PermissionsAsync on
// every screen mount / app launch. Each helper:
//   1. Reads the current OS permission state (no prompt).
//   2. If undetermined, requests once.
//   3. If denied/blocked, surfaces a Settings deep-link Alert instead of
//      re-firing the request (which on iOS silently no-ops anyway).
//   4. Persists an "asked once" flag so multi-screen flows don't show the
//      request prompt again on the same install.

import { Alert, Linking, Platform } from 'react-native'
import * as Location from 'expo-location'
import * as Notifications from 'expo-notifications'
import AsyncStorage from '@react-native-async-storage/async-storage'

const FG_LOCATION_ASKED = 'perm:location:fg:asked'
const BG_LOCATION_ASKED = 'perm:location:bg:asked'
const NOTIFICATIONS_ASKED = 'perm:notifications:asked'

type Status = 'granted' | 'denied' | 'undetermined'

async function openAppSettings() {
  if (Platform.OS === 'ios') await Linking.openURL('app-settings:')
  else await Linking.openSettings()
}

function showSettingsAlert(title: string, body: string) {
  Alert.alert(title, body, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: openAppSettings },
  ])
}

// ── Foreground location ───────────────────────────────────────────
export async function ensureForegroundLocation(opts?: { silent?: boolean }): Promise<Status> {
  const current = await Location.getForegroundPermissionsAsync()
  if (current.status === 'granted') return 'granted'

  // If iOS reports we can ask again, do so. Same for Android.
  if (current.canAskAgain) {
    const requested = await Location.requestForegroundPermissionsAsync()
    await AsyncStorage.setItem(FG_LOCATION_ASKED, '1')
    return requested.status as Status
  }

  // Permission was denied and OS won't show the prompt again — only Settings can fix it.
  if (!opts?.silent) {
    showSettingsAlert(
      'Location is off for Rinsebase',
      'Turn on Location in Settings → Rinsebase Crew to use the GPS-based features.',
    )
  }
  return 'denied'
}

// ── Background location ───────────────────────────────────────────
// Only call this AFTER foreground is granted. Background requires the user
// to choose "Always" on iOS or "Allow all the time" on Android, which is a
// stronger ask — gate it behind a button or onboarding step, not a startup
// barrage.
export async function ensureBackgroundLocation(opts?: { silent?: boolean }): Promise<Status> {
  const fg = await Location.getForegroundPermissionsAsync()
  if (fg.status !== 'granted') return 'denied'

  const current = await Location.getBackgroundPermissionsAsync()
  if (current.status === 'granted') return 'granted'

  if (current.canAskAgain) {
    const requested = await Location.requestBackgroundPermissionsAsync()
    await AsyncStorage.setItem(BG_LOCATION_ASKED, '1')
    return requested.status as Status
  }

  if (!opts?.silent) {
    showSettingsAlert(
      'Background location off',
      Platform.OS === 'ios'
        ? 'To get auto clock-out reminders when you leave a job site, set Location to "Always Allow" in Settings → Rinsebase Crew → Location.'
        : 'To get auto clock-out reminders when you leave a job site, set Location to "Allow all the time" in Settings → Apps → Rinsebase Crew → Permissions → Location.',
    )
  }
  return 'denied'
}

// ── Notifications (push) ──────────────────────────────────────────
export async function ensureNotifications(opts?: { silent?: boolean }): Promise<Status> {
  const current = await Notifications.getPermissionsAsync()
  if (current.status === 'granted') return 'granted'

  if (current.canAskAgain) {
    const requested = await Notifications.requestPermissionsAsync()
    await AsyncStorage.setItem(NOTIFICATIONS_ASKED, '1')
    return requested.status as Status
  }

  if (!opts?.silent) {
    showSettingsAlert(
      'Notifications are off',
      'Turn on Notifications in Settings → Rinsebase Crew so you get job updates and SOS alerts.',
    )
  }
  return 'denied'
}

// ── Read-only helpers (no prompt, no Settings alert) ──────────────
export async function getForegroundLocationStatus(): Promise<Status> {
  const r = await Location.getForegroundPermissionsAsync()
  return r.status as Status
}

export async function getBackgroundLocationStatus(): Promise<Status> {
  const r = await Location.getBackgroundPermissionsAsync()
  return r.status as Status
}
