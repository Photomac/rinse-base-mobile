// src/lib/clientVersion.ts
// Reports which bundle this device is actually running.
//
// Written 2026-08-28, when "did some of Annelise's crew miss the OTA?" turned
// out to be unanswerable — nothing in the schema recorded a version, and
// push_tokens carries only `platform`. OTA is how mobile ships, so "which
// devices took the update" has to be answerable before any OTA-timed regression
// can be attributed.
//
// updateId is the field that actually answers it: it matches the EAS update
// group published to a channel, so a device can be checked against a specific
// publish. embeddedLaunch === true means the device is running the bundle baked
// into its binary, i.e. it has taken NO OTA at all.
//
// Originally used ONLY expo-updates so this could ship over the air without a
// store build. expo-application was added later at a rebuild that was happening
// anyway (runtimeVersion → fingerprint policy), because under that policy
// Updates.runtimeVersion is a native-code hash, not the app version, and
// app_version must keep meaning "which store build" — otherwise the question
// this file exists to answer ("did these devices take the OTA?") collapses
// runtime and version into one unreadable column.

import * as Updates from 'expo-updates'
import * as Application from 'expo-application'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Location from 'expo-location'
import { supabase } from './supabase'
import { uuid4 } from './outbox'
import { locationSettingFrom, preciseFrom, shouldReportLocation } from './locationSettingRules'

const INSTALL_KEY = 'rb_install_id'

/** Stable per install. Cleared only by a reinstall, which is correct: a
 *  reinstall genuinely is a new install. Not tied to the signed-in person —
 *  a shared crew phone is one install with several users over time. */
async function installId(): Promise<string> {
  try {
    let id = await AsyncStorage.getItem(INSTALL_KEY)
    if (!id) {
      id = uuid4()
      await AsyncStorage.setItem(INSTALL_KEY, id)
    }
    return id
  } catch {
    return uuid4()
  }
}

/** Fire-and-forget on launch. Never throws — telemetry must not be able to keep
 *  a crew member out of the app in a dead zone. */
export async function reportClientVersion(): Promise<void> {
  try {
    await supabase.rpc('record_client_version', {
      p_surface: Platform.OS === 'ios' ? 'ios' : 'android',
      p_install_id: await installId(),
      p_app_version: Application.nativeApplicationVersion ?? null,  // store version, e.g. 1.1.4
      p_runtime_version: Updates.runtimeVersion ?? null,             // OTA lane: fingerprint hash
      p_update_id: Updates.updateId ?? null,           // null in dev / Expo Go
      p_channel: Updates.channel ?? null,
      p_embedded: Updates.isEmbeddedLaunch ?? null,
    })
  } catch {
    /* ignore */
  }
  // On the row that call keeps: whose location the office can rely on.
  await reportLocationSetting(true)
}

const LOCATION_SENT_KEY = 'rb_location_setting_sent'

/** This phone's location setting (lib/locationSettingRules) on its install row
 *  (record_location_setting, rinsebase-app 20261023210300), for the Team page.
 *  On launch, and on each return to the app (they may have just changed it
 *  in Settings); sent when it changed, or twice a day. Never throws, never
 *  asks for anything: it only reads what the phone already says. */
export async function reportLocationSetting(force = false): Promise<void> {
  try {
    const [servicesOn, fg, bg] = await Promise.all([
      Location.hasServicesEnabledAsync().catch(() => true),
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync().catch(() => null),
    ])
    const setting = locationSettingFrom({ servicesOn, fg: fg?.status, bg: bg?.status })
    const precise = setting === 'off' || setting === 'not_asked' ? null : preciseFrom(Platform.OS, fg as any)
    const key = `${setting}|${precise}`
    const last = JSON.parse((await AsyncStorage.getItem(LOCATION_SENT_KEY)) || 'null')
    if (!force && !shouldReportLocation(last, key, Date.now())) return
    const { error } = await supabase.rpc('record_location_setting', {
      p_install_id: await installId(), p_setting: setting, p_precise: precise,
    })
    if (!error) await AsyncStorage.setItem(LOCATION_SENT_KEY, JSON.stringify({ key, at: Date.now() }))
  } catch {
    /* ignore */
  }
}
