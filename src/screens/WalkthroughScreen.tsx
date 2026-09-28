// Walkthrough video: the crew records the property as found (arrival) or as
// left (finished), as proof for the owner and their client. Recorded inside
// the app — never picked from the camera roll — so it can't be an old video.
//
// Everything here uses native modules already in the store builds (expo-camera
// has shipped since v1, expo-keep-awake comes with expo), so it ships over the
// air. Recording is MUTED: no microphone prompt (the app's microphone text
// describes SOS, not video), no crew conversations recorded in a client's home,
// smaller files.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Platform, ScrollView, Alert, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { CameraView } from 'expo-camera'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import * as FileSystem from 'expo-file-system/legacy'
import { ensureCamera } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import {
  enqueueVideo, flushVideoQueue, queuedJobVideos, QueuedJobVideo, WalkthroughType,
  WALKTHROUGH_MAX_SECONDS, WALKTHROUGH_MAX_BYTES, WALKTHROUGH_BITRATE,
} from '../lib/videoQueue'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { SLATE_DARK, GOLD } from '../lib/theme'

const NAVY = SLATE_DARK
const KEEP_AWAKE_TAG = 'walkthrough-recording'

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function fmtMb(bytes: number | null): string {
  return bytes == null ? '' : `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`
}

interface Props {
  job: any
  user: any
  /** Arrival when the clean hasn't started (or just has), finished otherwise. */
  defaultType: WalkthroughType
  onBack: () => void
}

interface Row {
  key: string
  video_type: WalkthroughType
  duration_seconds: number | null
  size_bytes: number | null
  state: 'uploaded' | 'waiting' | 'failing'
  lastError?: string | null
}

export function WalkthroughScreen({ job, user, defaultType, onBack }: Props) {
  const { t } = useLang()
  const cameraRef = useRef<CameraView>(null)
  const [perm, setPerm] = useState<'checking' | 'granted' | 'denied'>('checking')
  // The camera opens in picture mode with mute already applied and switches to
  // video once ready. On iOS, entering video mode while mute is still unset
  // attaches the microphone (and prompts for it) before mute can remove it.
  const [mode, setMode] = useState<'picture' | 'video'>('picture')
  const [videoReady, setVideoReady] = useState(false)
  const [videoType, setVideoType] = useState<WalkthroughType>(defaultType)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(0)
  const [recorded, setRecorded] = useState<{ uri: string; duration: number; recordedAt: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [retrying, setRetrying] = useState(false)

  const addr = job.client_addresses as any
  const client = job.clients as any
  const typeLabel = (tp: WalkthroughType) => t(tp === 'before' ? 'walkthrough_type_before' : 'walkthrough_type_after')

  useEffect(() => {
    ensureCamera().then(s => setPerm(s === 'granted' ? 'granted' : 'denied')).catch(() => setPerm('denied'))
  }, [])

  const loadList = useCallback(async () => {
    const [serverRes, queued] = await Promise.all([
      supabase.from('job_videos')
        .select('id, video_type, duration_seconds, size_bytes, created_at')
        .eq('job_id', job.id).order('created_at', { ascending: false }),
      queuedJobVideos(job.id).catch((): QueuedJobVideo[] => []),
    ])
    const server = ((serverRes.data as any[]) ?? [])
    const serverIds = new Set(server.map(r => r.id))
    // A queued entry whose row already landed (response lost) shows once, as uploaded.
    const onDevice: Row[] = queued
      .filter(v => !serverIds.has(v.id))
      .sort((a, b) => b.created_at - a.created_at)
      .map(v => ({
        key: `q:${v.id}`, video_type: v.video_type, duration_seconds: v.duration_seconds, size_bytes: v.size_bytes,
        state: v.failing ? 'failing' : 'waiting', lastError: v.lastError,
      }))
    const uploaded: Row[] = server.map(r => ({
      key: r.id, video_type: r.video_type, duration_seconds: r.duration_seconds, size_bytes: r.size_bytes, state: 'uploaded',
    }))
    setRows([...onDevice, ...uploaded])
  }, [job.id])

  useEffect(() => {
    loadList().catch(() => {})
    flushVideoQueue().then(({ uploaded }) => { if (uploaded > 0) loadList().catch(() => {}) }).catch(() => {})
  }, [loadList])

  // While anything is still on the phone, keep trying and keep the list honest.
  const hasWaiting = rows.some(r => r.state !== 'uploaded')
  useEffect(() => {
    if (!hasWaiting) return
    const iv = setInterval(() => {
      flushVideoQueue().catch(() => {}).finally(() => { loadList().catch(() => {}) })
    }, 15_000)
    return () => clearInterval(iv)
  }, [hasWaiting, loadList])

  useEffect(() => {
    if (!recording) return
    const iv = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250)
    return () => clearInterval(iv)
  }, [recording])

  useEffect(() => {
    if (mode !== 'video') return
    // The capture session reconfigures asynchronously after the switch;
    // recording before it settles fails on some devices.
    const tmr = setTimeout(() => setVideoReady(true), 800)
    return () => clearTimeout(tmr)
  }, [mode])

  // Leaving mid-recording: stop the camera and release the screen lock.
  useEffect(() => () => {
    try { cameraRef.current?.stopRecording() } catch { /* not recording */ }
    deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
  }, [])

  async function startRecording() {
    if (!cameraRef.current || !videoReady || recording) return
    setJustSaved(false)
    startedAt.current = Date.now()
    setElapsed(0)
    setRecording(true)
    // A walkthrough runs longer than a phone's auto-lock; locking would stop it.
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {})
    const recordedAt = new Date().toISOString()
    try {
      const res = await cameraRef.current.recordAsync({
        maxDuration: WALKTHROUGH_MAX_SECONDS,
        maxFileSize: WALKTHROUGH_MAX_BYTES,
        // H.264. iPhones default to HEVC, which Firefox and many Windows PCs
        // can't play; the bitrate cap also only applies with a codec set.
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      })
      const secs = Math.min(WALKTHROUGH_MAX_SECONDS, (Date.now() - startedAt.current) / 1000)
      if (res?.uri) setRecorded({ uri: res.uri, duration: secs, recordedAt })
    } catch (e: any) {
      Alert.alert(t('walkthrough_failed'), e?.message ? String(e.message) : '')
    } finally {
      setRecording(false)
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
  }

  function stopRecording() {
    try { cameraRef.current?.stopRecording() } catch { /* already stopped */ }
  }

  async function save() {
    if (!recorded || saving) return
    setSaving(true)
    try {
      await enqueueVideo({
        uri: recorded.uri, tenant_id: user.tenant_id, job_id: job.id, user_id: user.id,
        video_type: videoType, duration_seconds: recorded.duration, recorded_at: recorded.recordedAt,
      })
      setRecorded(null)
      setJustSaved(true)
      await loadList()
      flushVideoQueue().catch(() => {}).finally(() => { loadList().catch(() => {}) })
    } catch (e: any) {
      Alert.alert(t('walkthrough_failed'), e?.message ? String(e.message) : '')
    } finally {
      setSaving(false)
    }
  }

  function retake() {
    const uri = recorded?.uri
    setRecorded(null)
    if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }

  async function retry() {
    setRetrying(true)
    try { await flushVideoQueue({ force: true }) } catch { /* list shows the state */ }
    await loadList().catch(() => {})
    setRetrying(false)
  }

  function goBack() {
    if (recording) return
    if (!recorded) { onBack(); return }
    Alert.alert(t('walkthrough_discard_confirm'), '', [
      { text: t('cancel'), style: 'cancel' },
      { text: t('walkthrough_discard'), style: 'destructive', onPress: () => { retake(); onBack() } },
    ])
  }

  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={goBack} style={styles.backBtn} disabled={recording}>
        <Text style={[styles.backText, recording && { opacity: 0.35 }]}>← {t('back')}</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>🎥 {t('walkthrough_title')}</Text>
      <View style={{ width: 60 }} />
    </View>
  )

  if (perm !== 'granted') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
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
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <View style={styles.jobInfo}>
        <Text style={styles.jobName}>{addr?.nickname || client?.full_name}</Text>
        {!!addr?.street && <Text style={styles.jobAddr}>{addr.street}{addr?.city ? `, ${addr.city}` : ''}</Text>}
      </View>

      <View style={styles.typeRow}>
        {(['before', 'after'] as const).map(tp => (
          <TouchableOpacity key={tp} disabled={recording || !!recorded} onPress={() => setVideoType(tp)}
            style={[styles.typeBtn, videoType === tp && styles.typeBtnOn, (recording || !!recorded) && videoType !== tp && { opacity: 0.4 }]}>
            <Text style={[styles.typeBtnText, videoType === tp && styles.typeBtnTextOn]} numberOfLines={1}>{typeLabel(tp)}</Text>
          </TouchableOpacity>
        ))}
      </View>

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
              {fmtClock(elapsed)} · {ti(t('walkthrough_time_left'), { time: fmtClock(WALKTHROUGH_MAX_SECONDS - elapsed) })}
            </Text>
          </View>
        )}
        {recorded ? (
          <View style={styles.reviewOverlay}>
            <Text style={styles.reviewTitle}>{ti(t('walkthrough_recorded'), { time: fmtClock(recorded.duration) })}</Text>
            <Text style={styles.reviewSub}>{typeLabel(videoType)}</Text>
            <View style={styles.reviewBtns}>
              <TouchableOpacity style={styles.secondaryBtn} onPress={retake} disabled={saving}>
                <Text style={styles.secondaryBtnText}>{t('walkthrough_retake')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.primaryBtn, { flex: 1 }]} onPress={save} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>{t('walkthrough_save')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.controls}>
            <TouchableOpacity
              onPress={recording ? stopRecording : startRecording}
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

      {!recording && (
        <ScrollView style={styles.list} contentContainerStyle={{ padding: 14, paddingBottom: 28 }}>
          <Text style={styles.intro}>{t('walkthrough_intro')}</Text>
          {justSaved && <Text style={styles.savedNote}>✓ {t('walkthrough_saved_note')}</Text>}
          <Text style={styles.listTitle}>{t('walkthrough_list_title')}</Text>
          {rows.length === 0 ? (
            <Text style={styles.empty}>{t('walkthrough_none')}</Text>
          ) : rows.map(r => (
            <View key={r.key} style={[styles.row, r.state === 'failing' && styles.rowFailing]}>
              <Text style={styles.rowIcon}>{r.state === 'uploaded' ? '✅' : r.state === 'failing' ? '⚠️' : '⏳'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {typeLabel(r.video_type)}{r.duration_seconds != null ? ` · ${fmtClock(r.duration_seconds)}` : ''}
                </Text>
                <Text style={[styles.rowSub, r.state === 'failing' && { color: '#B91C1C' }]} numberOfLines={2}>
                  {r.state === 'uploaded' ? t('walkthrough_status_uploaded')
                    : r.state === 'failing' ? `${t('walkthrough_status_rejected')}${r.lastError ? ` (${r.lastError})` : ''}`
                    : `${t('walkthrough_status_waiting')}${r.size_bytes ? ` · ${fmtMb(r.size_bytes)}` : ''}`}
                </Text>
              </View>
            </View>
          ))}
          {hasWaiting && (
            <TouchableOpacity style={styles.retryBtn} onPress={retry} disabled={retrying}>
              {retrying ? <ActivityIndicator color={NAVY} /> : <Text style={styles.retryText}>↻ {t('walkthrough_retry')}</Text>}
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  backBtn: { padding: 4 },
  backText: { color: GOLD, fontSize: 14, fontWeight: '600' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  jobInfo: { backgroundColor: NAVY, paddingHorizontal: 16, paddingBottom: 12 },
  jobName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  jobAddr: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 },
  permText: { fontSize: 15, color: '#374151', textAlign: 'center', lineHeight: 21 },
  typeRow: { flexDirection: 'row', gap: 8, padding: 10, backgroundColor: NAVY },
  typeBtn: { flex: 1, paddingVertical: 9, paddingHorizontal: 8, borderRadius: 20, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.25)', alignItems: 'center' },
  typeBtnOn: { backgroundColor: GOLD, borderColor: GOLD },
  typeBtnText: { fontSize: 12.5, fontWeight: '700', color: 'rgba(255,255,255,0.8)' },
  typeBtnTextOn: { color: NAVY },
  cameraWrap: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  recBadge: { position: 'absolute', top: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#EF4444' },
  recText: { color: '#fff', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  controls: { position: 'absolute', bottom: 18, left: 0, right: 0, alignItems: 'center' },
  recBtn: { width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  recCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#EF4444' },
  stopSquare: { width: 30, height: 30, borderRadius: 6, backgroundColor: '#EF4444' },
  recLabel: { color: '#fff', fontSize: 13, fontWeight: '700', marginTop: 6, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  reviewOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, backgroundColor: 'rgba(15,23,42,0.92)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  reviewTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  reviewSub: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 4, marginBottom: 20 },
  reviewBtns: { flexDirection: 'row', gap: 10, alignSelf: 'stretch' },
  primaryBtn: { backgroundColor: GOLD, paddingVertical: 13, paddingHorizontal: 18, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: NAVY, fontSize: 15, fontWeight: '800' },
  secondaryBtn: { paddingVertical: 13, paddingHorizontal: 18, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)', alignItems: 'center' },
  secondaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  list: { maxHeight: 250, backgroundColor: '#F8F9FA' },
  intro: { fontSize: 12.5, color: '#4B5563', lineHeight: 18, marginBottom: 10 },
  savedNote: { fontSize: 12.5, color: '#065F46', backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#A7F3D0', borderRadius: 9, padding: 10, marginBottom: 10, lineHeight: 18 },
  listTitle: { fontSize: 11, fontWeight: '800', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  empty: { fontSize: 13, color: '#6B7280' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB', padding: 10, marginBottom: 6 },
  rowFailing: { borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  rowIcon: { fontSize: 16 },
  rowTitle: { fontSize: 13, fontWeight: '700', color: '#111827' },
  rowSub: { fontSize: 11.5, color: '#6B7280', marginTop: 1 },
  retryBtn: { marginTop: 6, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB', backgroundColor: '#fff', alignItems: 'center' },
  retryText: { fontSize: 13, fontWeight: '700', color: NAVY },
})
