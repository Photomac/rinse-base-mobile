// A video for an incident report (CKS Perfections 2026-11-12): recorded inside
// the app, over the report form, so the form keeps what was typed and the clip
// can't be an old one from the camera roll. The walkthrough's camera
// (WalkthroughScreen): muted (no microphone prompt, no conversations recorded
// in a client's home), 720p H.264 at the walkthrough bitrate, at most a
// minute. The clip is handed back to the form, which queues it with the report
// on Save (lib/videoQueue, video_type 'report'); closing without using it
// deletes the file.
//
// expo-camera and expo-keep-awake are in every store build: this ships over
// the air.
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator, Modal } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { CameraView } from 'expo-camera'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as FileSystem from 'expo-file-system/legacy'
import { ensureCamera } from '../lib/permissions'
import { REPORT_CLIP_MAX_SECONDS, WALKTHROUGH_MAX_BYTES, WALKTHROUGH_BITRATE } from '../lib/videoQueue'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { SLATE_DARK, GOLD } from '../lib/theme'

const NAVY = SLATE_DARK
const KEEP_AWAKE_TAG = 'report-clip-recording'

export type ReportClip = { uri: string; duration: number; recordedAt: string }

export function reportClipClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function ReportClipRecorder({ visible, onClose, onUse }: {
  visible: boolean
  onClose: () => void
  /** The clip to put on the report (the form queues it on Save). */
  onUse: (clip: ReportClip) => void
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {visible && <Recorder onClose={onClose} onUse={onUse} />}
    </Modal>
  )
}

function Recorder({ onClose, onUse }: { onClose: () => void; onUse: (clip: ReportClip) => void }) {
  const { t } = useLang()
  const cameraRef = useRef<CameraView>(null)
  const [perm, setPerm] = useState<'checking' | 'granted' | 'denied'>('checking')
  // Picture mode first with mute applied, then video once the camera is ready:
  // entering video mode before mute is set attaches the microphone on iOS
  // (WalkthroughScreen).
  const [mode, setMode] = useState<'picture' | 'video'>('picture')
  const [videoReady, setVideoReady] = useState(false)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(0)
  const [recorded, setRecorded] = useState<ReportClip | null>(null)
  const used = useRef(false)

  useEffect(() => {
    ensureCamera().then(s => setPerm(s === 'granted' ? 'granted' : 'denied')).catch(() => setPerm('denied'))
  }, [])
  useEffect(() => {
    if (!recording) return
    const iv = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250)
    return () => clearInterval(iv)
  }, [recording])
  useEffect(() => {
    if (mode !== 'video') return
    const tmr = setTimeout(() => setVideoReady(true), 800)
    return () => clearTimeout(tmr)
  }, [mode])
  // Leaving mid-recording: stop the camera and release the screen lock.
  useEffect(() => () => {
    try { cameraRef.current?.stopRecording() } catch { /* not recording */ }
    deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
  }, [])

  async function start() {
    if (!cameraRef.current || !videoReady || recording) return
    startedAt.current = Date.now()
    setElapsed(0)
    setRecording(true)
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {})
    const recordedAt = new Date().toISOString()
    try {
      const res = await cameraRef.current.recordAsync({
        maxDuration: REPORT_CLIP_MAX_SECONDS,
        maxFileSize: WALKTHROUGH_MAX_BYTES,
        // H.264: iPhones default to HEVC, which Firefox and many Windows PCs can't play.
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      })
      const secs = Math.min(REPORT_CLIP_MAX_SECONDS, (Date.now() - startedAt.current) / 1000)
      if (res?.uri) setRecorded({ uri: res.uri, duration: secs, recordedAt })
    } catch (e: any) {
      Alert.alert(t('walkthrough_failed'), e?.message ? String(e.message) : '')
    } finally {
      setRecording(false)
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
  }

  function stop() {
    try { cameraRef.current?.stopRecording() } catch { /* already stopped */ }
  }

  function retake() {
    const uri = recorded?.uri
    setRecorded(null)
    if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }

  function use() {
    if (!recorded || used.current) return
    used.current = true
    onUse(recorded)
  }

  function close() {
    if (recording) return
    if (!recorded) { onClose(); return }
    Alert.alert(t('walkthrough_discard_confirm'), '', [
      { text: t('cancel'), style: 'cancel' },
      { text: t('walkthrough_discard'), style: 'destructive', onPress: () => { retake(); onClose() } },
    ])
  }

  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={close} style={styles.backBtn} disabled={recording}>
        <Text style={[styles.backText, recording && { opacity: 0.35 }]}>← {t('back')}</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle} numberOfLines={1}>🎥 {t('ir_video_title')}</Text>
      <View style={{ width: 60 }} />
    </View>
  )

  if (perm !== 'granted') {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {header}
        <View style={styles.center}>
          {perm === 'checking' ? <ActivityIndicator color={GOLD} /> : (
            <>
              <Text style={styles.permText}>{t('walkthrough_camera_needed')}</Text>
              <TouchableOpacity style={styles.primaryBtn}
                onPress={() => { ensureCamera().then(s => setPerm(s === 'granted' ? 'granted' : 'denied')).catch(() => {}) }}>
                <Text style={styles.primaryBtnText}>{t('walkthrough_allow_camera')}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {header}
      <View style={styles.cameraWrap}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          mode={mode}
          mute
          videoQuality="720p"
          videoBitrate={WALKTHROUGH_BITRATE}
          responsiveOrientationWhenOrientationLocked
          onCameraReady={() => { if (mode === 'picture') setMode('video') }}
          onMountError={e => Alert.alert(t('walkthrough_failed'), e?.message || '')}
        />
        {recording && (
          <View style={styles.recBadge}>
            <View style={styles.recDot} />
            <Text style={styles.recText}>
              {reportClipClock(elapsed)} · {ti(t('walkthrough_time_left'), { time: reportClipClock(REPORT_CLIP_MAX_SECONDS - elapsed) })}
            </Text>
          </View>
        )}
        {recorded ? (
          <View style={styles.reviewOverlay}>
            <Text style={styles.reviewTitle}>{ti(t('walkthrough_recorded'), { time: reportClipClock(recorded.duration) })}</Text>
            <Text style={styles.reviewSub}>{t('ir_video_hint')}</Text>
            <View style={styles.reviewBtns}>
              <TouchableOpacity style={styles.secondaryBtn} onPress={retake}>
                <Text style={styles.secondaryBtnText}>{t('walkthrough_retake')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.primaryBtn, { flex: 1 }]} onPress={use}>
                <Text style={styles.primaryBtnText}>{t('ir_video_use')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.controls}>
            <TouchableOpacity
              onPress={recording ? stop : start}
              disabled={!recording && !videoReady}
              style={[styles.recBtn, !recording && !videoReady && { opacity: 0.4 }]}
              accessibilityRole="button"
              accessibilityLabel={recording ? t('walkthrough_stop') : t('walkthrough_record')}>
              <View style={recording ? styles.stopSquare : styles.recCircle} />
            </TouchableOpacity>
            <Text style={styles.recLabel}>{recording ? t('walkthrough_stop') : t('walkthrough_record')}</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: NAVY },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  backBtn: { padding: 4, width: 60 },
  backText: { color: GOLD, fontSize: 14, fontWeight: '600' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700', flexShrink: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16, backgroundColor: '#F8F9FA' },
  permText: { fontSize: 15, color: '#374151', textAlign: 'center', lineHeight: 21 },
  cameraWrap: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  recBadge: { position: 'absolute', top: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#EF4444' },
  recText: { color: '#fff', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  controls: { position: 'absolute', bottom: 18, left: 0, right: 0, alignItems: 'center' },
  recBtn: { width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  recCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#EF4444' },
  stopSquare: { width: 30, height: 30, borderRadius: 6, backgroundColor: '#EF4444' },
  recLabel: { color: '#fff', fontSize: 13, fontWeight: '700', marginTop: 6, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  reviewOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, backgroundColor: 'rgba(15,23,42,0.92)', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  reviewTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  reviewSub: { color: 'rgba(255,255,255,0.75)', fontSize: 13, textAlign: 'center', marginBottom: 8 },
  reviewBtns: { flexDirection: 'row', gap: 10, alignSelf: 'stretch' },
  primaryBtn: { backgroundColor: GOLD, paddingVertical: 13, paddingHorizontal: 18, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: NAVY, fontSize: 15, fontWeight: '800' },
  secondaryBtn: { paddingVertical: 13, paddingHorizontal: 18, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)', alignItems: 'center' },
  secondaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
})
