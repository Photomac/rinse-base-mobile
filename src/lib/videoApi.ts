// Whether this build can play a video inside the app, and the player when it
// can. Pure: no React Native, no expo (scripts/test-in-app-video.mjs runs it);
// lib/inAppVideo.ts hands it the real platform, module check and loader.
//
// The in-app player is expo-video, a NATIVE module. Store builds from 1.1.7 on
// carry it; the 1.1.5 and 1.1.6 builds in the field don't, and the same JS has
// to run on both. So:
//   • nothing imports 'expo-video' at the top of a file. Metro bundles with
//     inlineRequires off, so a top-level import runs at startup, and expo-video
//     calls requireNativeModule('ExpoVideo'), which THROWS on a build without
//     it (the app would not open);
//   • lib/inAppVideo.ts asks whether the native module is there first, and only
//     then requires the package, inside a try. Expo's Metro config allows
//     optional dependencies, so a tree without the package installed (an older
//     lane's OTA tree) still bundles;
//   • with no player, callers hand the video to the phone's own player
//     (Linking.openURL), as before.
//
// Asked for by CKS Perfections (2026-11-11): the turnover crew watch the
// arrival prep's videos (components/ArrivalPrepCard, components/VideoPlayerModal).
import type { ComponentType } from 'react'

export type VideoStatus = 'idle' | 'loading' | 'readyToPlay' | 'error'

/** The part of expo-video's VideoPlayer the app uses. */
export interface InAppPlayer {
  play(): void
  pause(): void
  readonly status: VideoStatus
  addListener(event: 'statusChange', listener: (e: { status: VideoStatus }) => void): { remove(): void }
}

/** The part of expo-video's VideoView props the app uses. */
export interface InAppVideoViewProps {
  player: InAppPlayer
  style?: unknown
  nativeControls?: boolean
  contentFit?: 'contain' | 'cover' | 'fill'
  allowsPictureInPicture?: boolean
}

export interface VideoApi {
  useVideoPlayer(source: { uri: string }, setup?: (player: InAppPlayer) => void): InAppPlayer
  VideoView: ComponentType<InAppVideoViewProps>
}

export interface VideoEnv {
  /** Platform.OS. */
  platform: string
  /** Is expo-video's native module in this build? */
  hasNative: () => boolean
  /** The expo-video package, or null when it isn't installed. */
  load: () => unknown
}

/** expo-video when this build can play a video inside the app, else null.
 *  Never loads the package on a build without its native module, and never
 *  throws: anything unexpected means the phone's player. */
export function pickVideoApi(env: VideoEnv): VideoApi | null {
  // Phones only: the web export (the screenshot harness) uses the browser.
  if (env.platform !== 'ios' && env.platform !== 'android') return null
  let present = false
  try { present = env.hasNative() === true } catch { present = false }
  if (!present) return null
  let mod: any = null
  try { mod = env.load() } catch { return null }
  if (!mod || typeof mod.useVideoPlayer !== 'function' || !mod.VideoView) return null
  return { useVideoPlayer: mod.useVideoPlayer, VideoView: mod.VideoView }
}
