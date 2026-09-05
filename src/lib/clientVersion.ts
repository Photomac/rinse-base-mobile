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
import { supabase } from './supabase'
import { uuid4 } from './outbox'

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
}
