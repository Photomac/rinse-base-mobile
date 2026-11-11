// The in-app video player (expo-video) on a build that has it; null on the
// 1.1.5 / 1.1.6 store builds, which don't, so callers use the phone's own
// player there. Why it is loaded this way: lib/videoApi.ts.
//
// This is the ONLY file that names 'expo-video' outside a type, and it must
// stay inside the try below (scripts/test-in-app-video.mjs checks both).
import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo'
import { pickVideoApi, type VideoApi } from './videoApi'

let api: VideoApi | null | undefined

export function inAppVideo(): VideoApi | null {
  if (api === undefined) {
    api = pickVideoApi({
      platform: Platform.OS,
      hasNative: () => requireOptionalNativeModule('ExpoVideo') != null,
      load: () => {
        try {
          return require('expo-video')
        } catch {
          return null
        }
      },
    })
  }
  return api
}
