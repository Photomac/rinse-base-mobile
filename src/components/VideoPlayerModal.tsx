// Full-screen video player inside the app, for the arrival prep's videos on a
// turnover (CKS Perfections, 2026-11-11). The phone's own controls do play,
// pause and scrubbing (expo-video's nativeControls: AVPlayerViewController on
// iOS, Media3 on Android); this adds close, the video's title and who/when,
// and ‹ › between the arrival's videos. One player per video: paging remounts
// the stage, so the old player is released and the next one starts playing.
// A video that won't play here offers the phone's player instead.
//
// Renders nothing on a build without expo-video (lib/inAppVideo.ts): callers
// check inAppVideo() first and hand the video to the phone's player there.
import React, { useEffect, useState } from 'react'
import { Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Linking, Alert } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useLang } from '../contexts/LangContext'
import { inAppVideo } from '../lib/inAppVideo'
import type { VideoApi, VideoStatus } from '../lib/videoApi'

export interface PlayerVideo {
  url: string
  title: string
  meta?: string | null
}

const HIT = { top: 12, bottom: 12, left: 12, right: 12 }

export function VideoPlayerModal({ videos, startIndex = 0, onClose }: {
  videos: PlayerVideo[]
  startIndex?: number
  onClose: () => void
}) {
  const { t } = useLang()
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(videos.length - 1, 0)))
  const api = inAppVideo()
  const video = videos[index]
  if (!api || !video) return null
  const many = videos.length > 1
  const go = (dir: -1 | 1) => setIndex(i => (i + dir + videos.length) % videos.length)

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root} testID="video-player">
        <StatusBar style="light" />
        <View style={styles.topBar}>
          <Text style={styles.counter}>{many ? `${index + 1} / ${videos.length}` : ''}</Text>
          <TouchableOpacity onPress={onClose} style={styles.roundBtn} hitSlop={HIT}
            accessibilityRole="button" accessibilityLabel={t('video_close')} testID="video-player-close">
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        <VideoStage key={`${index}:${video.url}`} api={api} url={video.url} />

        <View style={styles.bottomBar}>
          {many && (
            <TouchableOpacity onPress={() => go(-1)} style={styles.roundBtn} hitSlop={HIT}
              accessibilityRole="button" accessibilityLabel={t('video_prev')} testID="video-player-prev">
              <Text style={styles.navText}>‹</Text>
            </TouchableOpacity>
          )}
          <View style={styles.captionBox}>
            <Text style={styles.caption} numberOfLines={2}>{video.title}</Text>
            {!!video.meta && <Text style={styles.meta} numberOfLines={1}>{video.meta}</Text>}
          </View>
          {many && (
            <TouchableOpacity onPress={() => go(1)} style={styles.roundBtn} hitSlop={HIT}
              accessibilityRole="button" accessibilityLabel={t('video_next')} testID="video-player-next">
              <Text style={styles.navText}>›</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  )
}

/** One video. Starts playing as soon as it can; the player is released when
 *  this unmounts (close, or ‹ › to another video). */
function VideoStage({ api, url }: { api: VideoApi; url: string }) {
  const { t } = useLang()
  const player = api.useVideoPlayer({ uri: url }, p => p.play())
  const [status, setStatus] = useState<VideoStatus>(player.status)
  useEffect(() => {
    setStatus(player.status)
    const sub = player.addListener('statusChange', e => setStatus(e.status))
    return () => sub.remove()
  }, [player])
  // The way out when it won't play here: the phone's player (https links only).
  const outside = /^https:\/\/[^\s]+$/i.test(url)
  const openOutside = () => {
    Linking.openURL(url).catch(() => Alert.alert(t('arrival_video_failed')))
  }

  return (
    <View style={styles.stage}>
      {/* On an error the player's own "can't play" glyph would show through
          the message, so the view goes and the message stays. */}
      {status !== 'error' && (
        <api.VideoView player={player} style={styles.video} nativeControls contentFit="contain" allowsPictureInPicture={false} />
      )}
      {(status === 'idle' || status === 'loading') && (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#FFFFFF" />
        </View>
      )}
      {status === 'error' && (
        <View style={styles.overlay}>
          <Text style={styles.errText}>{t('video_cant_play')}</Text>
          {outside && (
            <TouchableOpacity onPress={openOutside} style={styles.errBtn} accessibilityRole="button">
              <Text style={styles.errBtnText}>{t('video_open_phone')}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 52, paddingHorizontal: 16, paddingBottom: 10,
  },
  counter: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', opacity: 0.85 },
  roundBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  closeText: { color: '#FFFFFF', fontSize: 16 },
  navText: { color: '#FFFFFF', fontSize: 26, lineHeight: 28, fontWeight: '400' },
  stage: { flex: 1, justifyContent: 'center' },
  video: { width: '100%', height: '100%' },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', textAlign: 'center', marginBottom: 14 },
  errBtn: { backgroundColor: '#D4A843', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 18 },
  errBtnText: { color: '#1A1408', fontSize: 14, fontWeight: '800' },
  bottomBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingTop: 12, paddingBottom: 40, paddingHorizontal: 16,
  },
  captionBox: { flex: 1, alignItems: 'center' },
  caption: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  meta: { color: 'rgba(255,255,255,0.65)', fontSize: 12, textAlign: 'center', marginTop: 2 },
})
