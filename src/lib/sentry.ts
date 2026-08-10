import * as Sentry from '@sentry/react-native'

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
