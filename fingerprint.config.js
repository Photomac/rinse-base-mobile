// Fingerprint runtime policy — what the native hash must IGNORE.
//
// runtimeVersion.policy is "fingerprint" so the OTA lane tracks native code,
// not the marketing version. But @expo/fingerprint hashes the resolved Expo
// config as a source and, by default, does NOT strip version-like fields from
// it. Measured 2026-09-05: bumping app.json version 1.1.4 → 1.1.5 changed the
// iOS hash 7f455e07… → 105a4bb1… and Android 79d740a4… → d1cb140e…, with the
// ONLY changed source being `expoConfig`. Without this file the policy switch
// is a rename — every store release still splits the fleet, exactly as under
// appVersion, just with an opaque hash.
//
// ExpoConfigVersions skips `version`, `ios.buildNumber`, `android.versionCode`.
// With it, 1.1.4 and 1.1.5 hash identically (verified before the first build
// that used this file). The runtime then moves only when native code does.
//
// Adding this file itself changes the hash once (the inputs changed) — build
// 25's `7f455e07…` is a dead-end lane nobody is on. That is expected.
const { SourceSkips } = require('@expo/fingerprint')

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips:
    SourceSkips.ExpoConfigVersions |
    // The library DEFAULT. Setting sourceSkips REPLACES the default rather than
    // adding to it, and without this flag EAS builds fail at Configure expo-updates
    // with "Runtime version mismatch": prebuild rewrites the android/ios scripts
    // in package.json (expo start --ios -> expo run:ios) on the build server, so
    // the hash computed there differs from the one computed here (builds 26/29,
    // 2026-09-05). This flag skips those two scripts unless they already run.
    SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun,
}
