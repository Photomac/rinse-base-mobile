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
import * as ImagePicker from 'expo-image-picker'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { tStatic } from './i18n'

const FG_LOCATION_ASKED = 'perm:location:fg:asked'
const BG_LOCATION_ASKED = 'perm:location:bg:asked'
const NOTIFICATIONS_ASKED = 'perm:notifications:asked'
const CAMERA_ASKED = 'perm:camera:asked'
const MEDIA_ASKED = 'perm:media:asked'

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
      tStatic('perm_location_off_title'),
      tStatic('perm_location_off_msg'),
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
      tStatic('perm_bg_location_title'),
      Platform.OS === 'ios'
        ? tStatic('perm_bg_location_ios')
        : tStatic('perm_bg_location_android'),
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
      tStatic('perm_notifications_title'),
      tStatic('perm_notifications_msg'),
    )
  }
  return 'denied'
}

// ── Camera ────────────────────────────────────────────────────────
// Call this BEFORE ImagePicker.launchCameraAsync — the picker throws
// "Missing camera or camera roll permission" if launched without it, which
// otherwise surfaces as an uncaught crash.
export async function ensureCamera(opts?: { silent?: boolean }): Promise<Status> {
  const current = await ImagePicker.getCameraPermissionsAsync()
  if (current.status === 'granted') return 'granted'

  if (current.canAskAgain) {
    const requested = await ImagePicker.requestCameraPermissionsAsync()
    await AsyncStorage.setItem(CAMERA_ASKED, '1')
    return requested.status as Status
  }

  if (!opts?.silent) {
    showSettingsAlert(tStatic('perm_camera_title'), tStatic('perm_camera_msg'))
  }
  return 'denied'
}

// ── Camera capture (camera + iOS photo roll) ──────────────────────
// Call this BEFORE ImagePicker.launchCameraAsync instead of bare
// ensureCamera(). On iOS the picker needs BOTH the camera permission and
// photo-library access — its error is literally "Missing camera or camera
// roll permission" — so a user who granted Camera but denied Photos still
// crashed through the ensureCamera-only gate (Sentry RINSEBASE-MOBILE-1
// regression, 2026-08-18: MLC owner on release 1.1.4 (22)). Android's
// camera capture doesn't touch the media library, so it isn't prompted.
export async function ensureCameraCapture(opts?: { silent?: boolean }): Promise<Status> {
  const cam = await ensureCamera(opts)
  if (cam !== 'granted') return cam
  if (Platform.OS !== 'ios') return 'granted'
  return ensureMediaLibrary(opts)
}

// ── Media library (photo roll) ────────────────────────────────────
// Call this BEFORE ImagePicker.launchImageLibraryAsync.
export async function ensureMediaLibrary(opts?: { silent?: boolean }): Promise<Status> {
  const current = await ImagePicker.getMediaLibraryPermissionsAsync()
  if (current.status === 'granted') return 'granted'

  if (current.canAskAgain) {
    const requested = await ImagePicker.requestMediaLibraryPermissionsAsync()
    await AsyncStorage.setItem(MEDIA_ASKED, '1')
    return requested.status as Status
  }

  if (!opts?.silent) {
    showSettingsAlert(tStatic('perm_media_title'), tStatic('perm_media_msg'))
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
