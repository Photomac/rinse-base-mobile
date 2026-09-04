import * as Sentry from '@sentry/react-native'
// JS-only: expo-updates is already in the native binary (it is what delivers
// OTAs), so reading it here costs no new native dependency and this file can
// still ship over the air.
import * as Updates from 'expo-updates'

// Which JS BUNDLE this device is running.
//
// WHY THIS EXISTS: Sentry's own `release` tag CANNOT answer that. On React
// Native `release` is the native store binary — `1.1.4 (22)`, built
// 2026-07-01 — and every OTA update inherits it unchanged, so an issue whose
// events are 100% `1.1.4 (22)` has told you nothing at all. `dist` is the
// build number, same problem.
//
// That cost real time on 2026-09-04: a `Missing camera or camera roll
// permission` event on 8/29, ten days after the fix for it shipped, and no way
// from the crash itself to tell "this phone never took the update" from "the
// fix has a hole". Those need opposite responses. Answering it meant going to
// `client_versions` — which only covers devices running #94 or later, i.e. not
// the stuck ones, which are exactly the ones in question.
//
// updateId matches the EAS update group published to a channel, so a crash can
// be checked against a specific publish. Read synchronously: these are
// constants, and the tags must exist before the first event, which is why they
// go in initialScope rather than a later setTag.
//
// `embedded` is a real answer, not a missing one — it means the device is
// running the bundle baked into its binary and has taken NO OTA. Kept distinct
// from `unknown` (a dev client or Expo Go, where the module is absent).
function bundleTags(): Record<string, string> {
  try {
    const tags: Record<string, string> = {
      'ota.update_id': (Updates.isEmbeddedLaunch || !Updates.updateId) ? 'embedded' : Updates.updateId,
    }
    // The channel distinguishes a stale device from one on the wrong lane
    // entirely — and those look identical if you only read a date.
    if (Updates.channel) tags['ota.channel'] = Updates.channel
    if (Updates.runtimeVersion) tags['ota.runtime'] = Updates.runtimeVersion
    if (Updates.createdAt) {
      tags['ota.published'] = new Date(Updates.createdAt).toISOString().slice(0, 10)
    }
    return tags
  } catch {
    // Never let telemetry setup keep the app from starting.
    return { 'ota.update_id': 'unknown' }
  }
}

// Dedicated "rinsebase-mobile" Sentry project (org rinsebase-app). Previously this
// reused the WEB app's DSN, which commingled mobile + web issues in one project;
// mobile now reports to its own project so crashes are cleanly separated (and show
// up tagged as mobile on the admin System Health "Live Errors" card). DSN is public
// (it ships in the client). (Source-map upload during builds still needs
// SENTRY_AUTH_TOKEN + org/project on the app.json plugin; add when ready —
// intentionally disabled for now per SENTRY_DISABLE_AUTO_UPLOAD in eas.json.)
Sentry.init({
  dsn: 'https://f58499b805c5368ac611bb0e837a6008@o4511111110459392.ingest.us.sentry.io/4511586838511616',
  environment: 'production',
  // Tags on initialScope apply to EVERY event, including any thrown before the
  // first render — which is where a bad bundle is most likely to fail.
  initialScope: { tags: bundleTags() },
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  ignoreErrors: [
    // "Calling the 'getRegistrationInfoAsync' function has failed"
    //
    // Upstream noise, not ours. expo-notifications' DevicePushTokenAutoRegistration.fx
    // module calls getRegistrationInfoAsync() at IMPORT time with a bare .then() and
    // no .catch(), so any rejection is unhandled and lands here. It runs on every
    // bundle load — including the headless background launches this app lives on
    // (arrivalGeofence / locationTracker / mileageTracker / sosTracker all define
    // TaskManager tasks, and arrivalGeofence imports expo-notifications).
    //
    // On iOS the native module reads the Keychain, and the registration-info item is
    // written with kSecAttrAccessibleWhenUnlockedThisDeviceOnly — unlike the
    // installation ID, which uses AfterFirstUnlock. So a crew phone locked in a
    // pocket that crosses a property geofence wakes us headless, the Keychain read
    // returns errSecInteractionNotAllowed (or errSecMissingEntitlement, the classic
    // -34018 background-launch case), and the Swift side throws instead of returning
    // nil. Android can hit the same line via a failed file read in noBackupFilesDir.
    //
    // Harmless: it's retrying EXPO's server-registration endpoint, which we don't use
    // — our push tokens go straight to push_tokens in Supabase from registerPushToken(),
    // which has its own try/catch and re-registers on the next foreground launch. No
    // crash, nothing the crew member sees, no push lost.
    //
    // Note this is NOT the getExpoPushTokenAsync path guarded in notifications.ts (#38);
    // that guard still stands and is unrelated. Revisit if expo-notifications ever
    // adds the missing .catch() upstream (last checked on 0.32.16 / SDK 54).
    /getRegistrationInfoAsync/,
  ],
})

export { Sentry }
export default Sentry
