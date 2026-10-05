import React, { useState, useEffect, useRef } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Image, Alert, ActivityIndicator, TextInput, Modal, KeyboardAvoidingView, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { ensureCameraCapture, ensureMediaLibrary } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import {
  enqueuePhoto, flushQueue, pendingStatus, PendingStatus, queuedJobPhotos, QueuedJobPhoto,
  onPhotoQueueChange, photoQueueActive,
} from '../lib/photoQueue'
import { writeThrough, uuid4 } from '../lib/outbox'
import { queueIncidentNotify, flushIncidentNotifies } from '../lib/incidentNotify'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { PhotoViewer, ViewerPhoto } from '../components/PhotoViewer'

import { SLATE_DARK, GOLD } from '../lib/theme'
const TEAL = GOLD
const NAVY = SLATE_DARK

// One library pick. Each photo is ~1.5–3 MB and a rural bar moves one every
// 30–100 s, so a bigger batch mostly means a longer wait; the crew can always
// pick again.
const LIBRARY_PICK_LIMIT = 30
// iOS formats we can't send as a .jpg. 'compatible' below makes the picker
// convert them, so this only catches a picker that didn't.
const IOS_UNSENDABLE = /\.(heic|heif|avif|tiff?|bmp)$/i

const PHOTO_TYPES: { id: string; emoji: string; key: 'before' | 'after' | 'damage' | 'other_photo'; color: string }[] = [
  { id: 'before',  emoji: '📷', key: 'before',      color: '#3B82F6' },
  { id: 'after',   emoji: '✅', key: 'after',       color: '#10B981' },
  { id: 'damage',  emoji: '⚠',  key: 'damage',      color: '#EF4444' },
  { id: 'general', emoji: '📸', key: 'other_photo', color: '#8B5CF6' },
]

interface Props {
  job: any
  user: any
  onBack: () => void
  preselectedItem?: any
  /** Named property shots this job still owes. Photos taken on THIS screen do
   *  not satisfy them — see the banner. Passed down rather than re-queried:
   *  JobDetailScreen already resolves it, gated on the tenant's enforce flag. */
  requiredOutstanding?: number
}

export function JobPhotosScreen({ job, user, onBack, preselectedItem, requiredOutstanding = 0 }: Props) {
  const { t } = useLang()
  const [serverPhotos, setServerPhotos] = useState<any[]>([])
  const [devicePhotos, setDevicePhotos] = useState<QueuedJobPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedType, setSelectedType] = useState('after')
  const [caption, setCaption] = useState(preselectedItem?.title || '')
  const [visibleToClient, setVisibleToClient] = useState(true)
  const [pending, setPending] = useState<PendingStatus>({ count: 0, serverRejected: 0, lastServerError: null })
  // An upload pass is running: the banner says "uploading", not "waiting".
  const [queueActive, setQueueActive] = useState(photoQueueActive())
  // The camera or library picker is open (or its photos are being queued).
  // Guards a double tap; uploads never hold the buttons.
  const busy = useRef(false)
  // Newest server read wins; an older one finishing late must not overwrite it.
  const loadSeq = useRef(0)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  // Editing a note on a photo that already exists. The capture-time caption
  // field cannot serve this: it is consumed and cleared by uploadPhoto, so a
  // note typed after the shot silently applied to the NEXT one, or to nothing
  // at all. Reported by Cleanfix Squad 2026-08-21 — the crew asked the office a
  // question through it and the text was never saved.
  const [noteFor, setNoteFor] = useState<any | null>(null)
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  const addr = job.client_addresses as any
  const client = job.clients as any
  const addressId = addr?.id || job.address_id || null

  useEffect(() => {
    loadPhotos()
    // Opening the screen in coverage drains any photos captured earlier offline.
    void flushQueue().catch(() => {})
  }, [])

  // Photos still on the device are listed too, from their local file, so a
  // shot that hasn't uploaded doesn't look like it never happened — that is
  // what sent crews to retake photos or give up (Rhyne, 2026-09-23).
  async function loadDevice() {
    const [queued, status] = await Promise.all([
      queuedJobPhotos(job.id).catch((): QueuedJobPhoto[] => []),
      pendingStatus().catch((): PendingStatus => ({ count: 0, serverRejected: 0, lastServerError: null })),
    ])
    return { queued, status }
  }

  async function loadPhotos(silent = false) {
    if (!silent) setLoading(true)
    const seq = ++loadSeq.current
    // Read both sides together, so a photo that just uploaded leaves the
    // on-device list and joins the server list in the same render.
    const [{ data }, device] = await Promise.all([
      supabase.from('job_photos').select('*').eq('job_id', job.id).order('created_at', { ascending: false }),
      loadDevice(),
    ])
    if (seq !== loadSeq.current) return
    setServerPhotos(data ?? [])
    setDevicePhotos(device.queued)
    setPending(device.status)
    setQueueActive(photoQueueActive())
    setLoading(false)
  }

  // Follow the upload queue live: badges flip from waiting → uploading →
  // uploaded without leaving the screen. Coalesced, because a library batch
  // queues many photos at once.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let needServer = false
    const off = onPhotoQueueChange(e => {
      if (e.uploadedJobId === job.id) needServer = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        timer = null
        if (needServer) { needServer = false; loadPhotos(true); return }
        const seq = loadSeq.current
        const device = await loadDevice()
        if (seq !== loadSeq.current) return
        setDevicePhotos(device.queued)
        setPending(device.status)
        setQueueActive(photoQueueActive())
      }, 200)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [job.id])

  const photos = [
    ...[...devicePhotos]
      .sort((a, b) => b.created_at - a.created_at)
      .map(q => ({
        id: `queued:${q.id}`, photo_url: q.localUri, photo_type: q.photo_type, caption: q.caption,
        visible_to_client: q.visible_to_client, queued: true, failing: q.failing, uploading: q.uploading,
      })),
    ...serverPhotos,
  ]

  // Required-shot capture LEFT this screen 2026-08-24 — evidence is taken
  // inside its room on the Turnover checklist (JobDetailScreen), one home not
  // two. This screen is job-level photos only: before/after/general/damage.

  async function takePhoto() {
    if (busy.current) return
    busy.current = true
    try {
      // ensureCameraCapture prompts (camera + iOS photo roll), or shows a
      // Settings deep-link if blocked, and returns non-granted rather than
      // letting launchCameraAsync throw.
      if (await ensureCameraCapture() !== 'granted') return
      let uri: string | undefined
      try {
        const result = await ImagePicker.launchCameraAsync({
          quality: 0.7,
          allowsEditing: false,
        })
        if (result.canceled) return
        uri = result.assets[0]?.uri
      } catch { return /* permission race / camera unavailable — no crash */ }
      if (uri) await addPhotos([uri])
    } finally {
      busy.current = false
    }
  }

  // Several photos from the camera roll in one go, queued exactly like camera
  // shots (same type, note, client toggle). Asked for by CKS Perfections.
  async function pickFromLibrary() {
    if (busy.current) return
    busy.current = true
    try {
      if (await ensureMediaLibrary() !== 'granted') return
      let assets: ImagePicker.ImagePickerAsset[]
      try {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: 'images',
          allowsMultipleSelection: true,
          selectionLimit: LIBRARY_PICK_LIMIT,
          orderedSelection: true,
          quality: 0.7,
          // iPhones keep photos as HEIC, and the multi-select picker hands
          // HEIC straight through unless asked for the compatible (JPEG) form.
          // Uploaded as-is it would be a ".jpg" Android phones and most
          // browsers can't open.
          preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        })
        if (result.canceled) return
        assets = result.assets ?? []
      } catch { return /* permission race / picker unavailable — no crash */ }
      const uris = assets
        .map(a => a.uri)
        .filter(u => !(Platform.OS === 'ios' && IOS_UNSENDABLE.test(u)))
      const skipped = assets.length - uris.length
      await addPhotos(uris)
      if (skipped > 0) Alert.alert(t('photos_skipped_title'), ti(t('photos_skipped_msg'), { n: String(skipped) }))
    } finally {
      busy.current = false
    }
  }

  // Queue the photos and return: they upload in the background while the crew
  // keeps shooting, and each thumbnail shows its own state. Nothing here waits
  // for the network — on one rural bar a single photo took up to 103 s.
  async function addPhotos(uris: string[]) {
    if (!uris.length) return
    const note = caption.trim()
    // Canonical checklist link: this photo satisfies the preselected item as
    // long as the caption still names it (legacy caption-matching wouldn't
    // have counted an edited caption either). The caption itself stays as a
    // dual-write until old bundles that match on it have aged out.
    const checklistItemId =
      preselectedItem?.jobItemId && note === (preselectedItem.title || '').trim()
        ? preselectedItem.jobItemId
        : null

    // Damage: ask before queueing, so a flagged photo is queued already tied
    // to its report and the flag survives no signal and an app restart.
    let report: { id: string; title: string } | null = null
    if (selectedType === 'damage' && await askFlagForReport()) {
      report = await createDamageReport(note)
    }

    setCaption('')
    let failed = 0
    for (const uri of uris) {
      try {
        await enqueuePhoto({
          uri,
          tenant_id: user.tenant_id,
          job_id: job.id,
          user_id: user.id,
          photo_type: selectedType === 'damage' ? 'issue' : selectedType,
          caption: note || null,
          checklist_item_id: checklistItemId,
          visible_to_client: visibleToClient,
          incident_report_id: report?.id ?? null,
        })
        // Start uploading with the first photo; later calls just ask the
        // running pass to pick up what was added since.
        void flushQueue().catch(() => {})
      } catch {
        failed++
      }
    }

    if (report) {
      // Heads-up the cleaning company only — the host is told later, if/when the
      // owner reviews and chooses to send (owner-controlled QC). Deferred until
      // the report AND its photos have landed (lib/incidentNotify), so it
      // survives no signal and still carries the photo.
      await queueIncidentNotify({
        report_id: report.id, job_id: job.id, tenant_id: user.tenant_id,
        report_type: 'damage', severity: 'minor', title: report.title, room: null,
      }).catch(() => {})
      void flushQueue().then(() => flushIncidentNotifies()).catch(() => {})
    }

    if (failed > 0) Alert.alert(t('upload_failed'), t('could_not_upload'))
  }

  function askFlagForReport(): Promise<boolean> {
    return new Promise(resolve => {
      Alert.alert(
        `⚠️ ${t('damage_photo_saved')}`,
        t('damage_flag_msg'),
        [
          { text: t('not_now'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('flag_for_report'), onPress: () => resolve(true) },
        ],
        // Android: tapping outside closes the dialog — treat it as "Not now"
        // so the photo is still queued.
        { cancelable: true, onDismiss: () => resolve(false) },
      )
    })
  }

  // A real damage report the owner can see + send to the host. A tagged damage
  // photo alone lives only in job_photos, which the owner's Issues view and
  // dashboard never read — they're built on job_damage_reports (same as
  // IncidentReportCard). Written through the offline outbox with a client id,
  // exactly like that card: live with signal, queued without. The photos
  // attach to it from the photo queue once they upload.
  async function createDamageReport(note: string): Promise<{ id: string; title: string } | null> {
    const id = uuid4()
    const title = note || 'Incident reported by crew'
    try {
      const { error } = await writeThrough({ table: 'job_damage_reports', op: 'upsert', onConflict: 'id', values: {
        id,
        tenant_id: user.tenant_id,
        job_id: job.id,
        address_id: addressId,
        reported_by: user?.id ?? null,
        report_type: 'damage',
        severity: 'minor',
        title,
        description: note || null,
        // photo_urls omitted (defaults to '{}'): photos are appended as they
        // upload, and a replayed upsert that re-sent [] would wipe them.
        status: 'reported',
      } })
      if (error) throw error
      return { id, title }
    } catch (e: any) {
      // The photo still goes in as a damage photo; only the report failed.
      Alert.alert(t('error'), e?.message || t('could_not_save'))
      return null
    }
  }

  function openPhotoOptions(photo: any) {
    Alert.alert(t('photo_options'), photo.caption || undefined, [
      { text: t('cancel'), style: 'cancel' },
      {
        text: photo.caption ? t('photo_edit_note') : t('photo_add_note'),
        onPress: () => { setNoteFor(photo); setNoteText(photo.caption || '') },
      },
      { text: t('delete_btn'), style: 'destructive', onPress: () => deletePhoto(photo) },
    ])
  }

  async function saveNote() {
    if (!noteFor) return
    setSavingNote(true)
    const next = noteText.trim() || null
    const { error } = await supabase.from('job_photos').update({ caption: next }).eq('id', noteFor.id)
    setSavingNote(false)
    if (error) { Alert.alert(t('could_not_save'), error.message); return }
    setNoteFor(null)
    setNoteText('')
    loadPhotos()
  }

  async function deletePhoto(photo: any) {
    Alert.alert(t('delete_photo'), t('delete_confirm'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete_btn'), style: 'destructive', onPress: async () => {
          await supabase.from('job_photos').delete().eq('id', photo.id)
          loadPhotos()
        }
      }
    ])
  }

  const beforePhotos  = photos.filter(p => p.photo_type === 'before')
  const afterPhotos   = photos.filter(p => p.photo_type === 'after')
  const damagePhotos  = photos.filter(p => p.photo_type === 'issue' || p.photo_type === 'damage')
  const generalPhotos = photos.filter(p => p.photo_type === 'general')

  // Flattened in section render order, so tapping a thumbnail opens the
  // viewer on that photo.
  const galleryPhotos = [...beforePhotos, ...afterPhotos, ...damagePhotos, ...generalPhotos]
  const galleryItems: ViewerPhoto[] = galleryPhotos.map(p => ({
    url: p.photo_url,
    caption: p.caption || null,
    meta: p.photo_type ? p.photo_type.charAt(0).toUpperCase() + p.photo_type.slice(1) : null,
  }))

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>← {t('back')}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>📸 {t('job_photos')}</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.jobInfo}>
        <Text style={styles.jobName}>{addr?.nickname || client?.full_name}</Text>
        <Text style={styles.jobAddr}>{addr?.street}, {addr?.city}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* A photo taken on this screen carries NO photo_requirement_id — only
            captureRequiredPhoto() sets that, and it is reached from the room
            checklist on the job screen. So a crew member can fill this screen
            with pictures and still be refused completion for missing required
            area photos. Measured on one account: 264 of 1,665 photos (16%)
            across 22 jobs counted for nothing, and the crew member with the
            most wasted shots was on this app, not the web. Say so here. */}
        {requiredOutstanding > 0 && (
          <TouchableOpacity onPress={onBack} style={styles.reqWarn} activeOpacity={0.7}>
            <Text style={styles.reqWarnTitle}>
              📷 {ti(t('photos_dont_count_title'), { n: String(requiredOutstanding) })}
            </Text>
            <Text style={styles.reqWarnBody}>{t('photos_dont_count_body')}</Text>
            <Text style={styles.reqWarnCta}>← {t('photos_dont_count_cta')}</Text>
          </TouchableOpacity>
        )}

        {/* Pending queue status — crew proof-of-work must never feel uncertain.
            Blue = uploading now, keep shooting; yellow = waiting on signal;
            red = the server is rejecting uploads (shows the error, so it's not
            mistaken for coverage). Tap retries. Never a blocking dialog. */}
        {pending.count > 0 && (() => {
          const tone = pending.serverRejected > 0 ? 'fail' : queueActive ? 'busy' : 'wait'
          const c = BANNER[tone]
          return (
            <TouchableOpacity
              onPress={() => { void flushQueue({ force: true }).catch(() => {}) }}
              style={[styles.banner, { backgroundColor: c.bg, borderColor: c.border }]}>
              <Text style={{ fontSize: 16 }}>{tone === 'fail' ? '⚠️' : tone === 'busy' ? '⬆️' : '📥'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>
                  {pending.count} 📷 {tone === 'fail' ? t('pending_upload_failing') : tone === 'busy' ? t('pending_uploading') : t('pending_upload')}
                </Text>
                {tone === 'fail' && !!pending.lastServerError && (
                  <Text style={{ fontSize: 10, color: c.text, marginTop: 2 }} numberOfLines={2}>
                    {pending.lastServerError}
                  </Text>
                )}
              </View>
              {tone === 'busy'
                ? <ActivityIndicator color={c.text} size="small" />
                : <Text style={{ fontSize: 11, fontWeight: '700', color: c.text }}>↻</Text>}
            </TouchableOpacity>
          )
        })()}
        {/* Photo type selector */}
        <View style={styles.typeRow}>
          {PHOTO_TYPES.map(pt => (
            <TouchableOpacity
              key={pt.id}
              style={[styles.typeBtn, selectedType === pt.id && { backgroundColor: pt.color, borderColor: pt.color }]}
              onPress={() => setSelectedType(pt.id)}
            >
              <Text style={[styles.typeBtnText, selectedType === pt.id && { color: '#fff' }]}>{pt.emoji} {t(pt.key)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Caption */}
        <TextInput
          style={styles.captionInput}
          value={caption}
          onChangeText={setCaption}
          placeholder={t('add_caption')}
          placeholderTextColor="#9CA3AF"
        />

        {/* Visible to client toggle */}
        <TouchableOpacity style={styles.toggleRow} onPress={() => setVisibleToClient(v => !v)}>
          <Text style={styles.toggleLabel}>{t('visible_to_client')}</Text>
          <View style={[styles.toggle, visibleToClient && styles.toggleOn]}>
            <View style={[styles.toggleThumb, visibleToClient && styles.toggleThumbOn]} />
          </View>
        </TouchableOpacity>

        {/* Capture buttons — never disabled by an upload in progress. */}
        <View style={styles.uploadRow}>
          <TouchableOpacity style={styles.cameraBtn} onPress={takePhoto}>
            <Text style={styles.cameraBtnText}>📷 {t('take_photo')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.galleryBtn} onPress={pickFromLibrary}>
            <Text style={styles.galleryBtnText}>🖼 {t('choose_photos')}</Text>
          </TouchableOpacity>
        </View>

        {/* Photo sections */}
        {loading ? (
          <ActivityIndicator color={TEAL} style={{ marginTop: 40 }} />
        ) : photos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📸</Text>
            <Text style={styles.emptyTitle}>{t('no_photos')}</Text>
            <Text style={styles.emptyText}>{t('no_photos_sub')}</Text>
          </View>
        ) : (
          <>
            {([
              { emoji: '📷', key: 'before' as const,      photos: beforePhotos,  color: '#3B82F6' },
              { emoji: '✅', key: 'after' as const,       photos: afterPhotos,   color: '#10B981' },
              { emoji: '⚠',  key: 'damage' as const,      photos: damagePhotos,  color: '#EF4444' },
              { emoji: '📸', key: 'other_photo' as const, photos: generalPhotos, color: '#8B5CF6' },
            ]).filter(s => s.photos.length > 0).map(section => (
              <View key={section.key} style={styles.section}>
                <Text style={[styles.sectionTitle, { color: section.color }]}>
                  {section.emoji} {t(section.key)} ({section.photos.length})
                </Text>
                <View style={styles.photoGrid}>
                  {section.photos.map(photo => (
                    <TouchableOpacity
                      key={photo.id}
                      style={styles.photoWrapper}
                      onPress={() => setViewerIndex(galleryPhotos.findIndex(p => p.id === photo.id))}
                      // A queued photo has no job_photos row yet, so note/delete
                      // don't apply; the banner above is where its retry lives.
                      onLongPress={() => { if (!photo.queued) openPhotoOptions(photo) }}
                    >
                      <Image source={{ uri: photo.photo_url }} style={[styles.photo, photo.queued && { opacity: 0.75 }]} />
                      {/* Every thumbnail says where its photo is: waiting,
                          uploading, failing, or safely uploaded. */}
                      {photo.queued ? (
                        <View style={[
                          styles.statusBadge,
                          photo.failing ? styles.badgeFailing : photo.uploading ? styles.badgeUploading : styles.badgeWaiting,
                        ]}>
                          <Text style={styles.statusBadgeText}>
                            {photo.failing ? `⚠️ ${t('pending_upload')}` : photo.uploading ? `⬆️ ${t('photo_uploading_badge')}` : `⏳ ${t('pending_upload')}`}
                          </Text>
                        </View>
                      ) : (
                        <View style={[styles.statusBadge, styles.badgeUploaded]}>
                          <Text style={styles.statusBadgeText}>✓ {t('uploaded_ok')}</Text>
                        </View>
                      )}
                      {photo.caption && (
                        <Text style={styles.photoCaption} numberOfLines={1}>{photo.caption}</Text>
                      )}
                      {photo.visible_to_client && (
                        <View style={styles.clientBadge}>
                          <Text style={styles.clientBadgeText}>{t('client_badge')}</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}
          </>
        )}

        <Text style={styles.hint}>{t('long_press_delete')}</Text>
      </ScrollView>

      {viewerIndex !== null && viewerIndex >= 0 && (
        <PhotoViewer photos={galleryItems} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />
      )}

      {/* Note editor for an EXISTING photo. A plain Modal rather than
          Alert.prompt, which is iOS-only — the crews reporting this are on
          Android. Shows the photo so it is obvious which one is being annotated. */}
      <Modal visible={noteFor !== null} transparent animationType="fade" onRequestClose={() => setNoteFor(null)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.noteBackdrop}
        >
          <View style={styles.noteCard}>
            <Text style={styles.noteTitle}>{t('photo_note_title')}</Text>
            {noteFor?.photo_url && <Image source={{ uri: noteFor.photo_url }} style={styles.noteThumb} />}
            <TextInput
              style={styles.noteInput}
              value={noteText}
              onChangeText={setNoteText}
              placeholder={t('photo_note_placeholder')}
              placeholderTextColor="#9CA3AF"
              multiline
              autoFocus
            />
            <View style={styles.noteBtnRow}>
              <TouchableOpacity style={styles.noteCancelBtn} onPress={() => setNoteFor(null)} disabled={savingNote}>
                <Text style={styles.noteCancelText}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.noteSaveBtn, savingNote && { opacity: 0.6 }]} onPress={saveNote} disabled={savingNote}>
                <Text style={styles.noteSaveText}>{savingNote ? t('saving') : t('save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  )
}

const BANNER = {
  busy: { bg: '#EFF6FF', border: '#BFDBFE', text: '#1E40AF' },
  wait: { bg: '#FEF9C3', border: '#FCD34D', text: '#854D0E' },
  fail: { bg: '#FEE2E2', border: '#FCA5A5', text: '#991B1B' },
} as const

const styles = StyleSheet.create({
  // Violet, matching the required-shot affordance on the job screen this sends
  // them back to — deliberately not the yellow/red used for upload trouble,
  // because nothing here has failed; it just doesn't count.
  reqWarn: { backgroundColor: '#F5F3FF', borderWidth: 1, borderColor: '#DDD6FE', borderRadius: 10, padding: 12, marginBottom: 10 },
  reqWarnTitle: { fontSize: 14, fontWeight: '700', color: '#5B21B6', marginBottom: 3 },
  reqWarnBody: { fontSize: 12, color: '#6D28D9', lineHeight: 17 },
  reqWarnCta: { fontSize: 12, fontWeight: '700', color: '#7C3AED', marginTop: 7 },
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  noteBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 },
  noteCard: { backgroundColor: '#fff', borderRadius: 16, padding: 18 },
  noteTitle: { fontSize: 15, fontWeight: '800', color: '#111827', marginBottom: 12 },
  noteThumb: { width: '100%', height: 150, borderRadius: 10, marginBottom: 12, backgroundColor: '#E5E7EB' },
  noteInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, padding: 12, fontSize: 14, color: '#111827', minHeight: 80, textAlignVertical: 'top' },
  noteBtnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  noteCancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB', alignItems: 'center' },
  noteCancelText: { fontSize: 14, fontWeight: '700', color: '#6B7280' },
  noteSaveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: NAVY, alignItems: 'center' },
  noteSaveText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  backBtn: { padding: 4 },
  backText: { color: TEAL, fontSize: 14, fontWeight: '600' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  jobInfo: { backgroundColor: NAVY, paddingHorizontal: 16, paddingBottom: 14 },
  jobName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  jobAddr: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 },
  scroll: { padding: 16, paddingBottom: 40 },
  reqCard: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: '#E5E7EB' },
  reqHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  reqTitle: { fontSize: 13, fontWeight: '800', color: '#111827' },
  reqCount: { fontSize: 11, fontWeight: '700', color: '#92400E' },
  reqSectionLabel: { fontSize: 10, fontWeight: '700', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
  reqRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 9, marginBottom: 5, borderWidth: 1, borderColor: '#E5E7EB', backgroundColor: '#F9FAFB' },
  reqRowDone: { backgroundColor: '#ECFDF5', borderColor: '#A7F3D0' },
  reqRowMissing: { backgroundColor: '#FFFBEB', borderColor: '#FCD34D' },
  reqThumb: { width: 34, height: 34, borderRadius: 7, backgroundColor: '#F3F4F6' },
  reqThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  reqName: { fontSize: 12.5, color: '#111827', fontWeight: '600' },
  reqOptional: { color: '#9CA3AF', fontStyle: 'italic', fontWeight: '400' },
  reqAction: { fontSize: 11, fontWeight: '800', color: '#78350F' },
  typeRow: { flexDirection: 'row', gap: 6, marginBottom: 12, flexWrap: 'wrap' },
  typeBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: '#E5E7EB', backgroundColor: '#fff' },
  typeBtnText: { fontSize: 12, fontWeight: '600', color: '#374151' },
  captionInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, padding: 12, fontSize: 13, color: '#111827', backgroundColor: '#fff', marginBottom: 10 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E5E7EB' },
  toggleLabel: { fontSize: 13, color: '#374151', fontWeight: '500' },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#E5E7EB', justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: TEAL },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 2 },
  toggleThumbOn: { alignSelf: 'flex-end' },
  uploadRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  cameraBtn: { flex: 1, backgroundColor: NAVY, borderRadius: 12, padding: 14, alignItems: 'center' },
  cameraBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  galleryBtn: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: TEAL },
  galleryBtnText: { color: TEAL, fontSize: 14, fontWeight: '700' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 10 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12, opacity: 0.3 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 4 },
  emptyText: { fontSize: 13, color: '#9CA3AF' },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 14, fontWeight: '800', marginBottom: 10 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photoWrapper: { width: '47%', borderRadius: 10, overflow: 'hidden', backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB' },
  photo: { width: '100%', aspectRatio: 1, backgroundColor: '#F3F4F6' },
  photoCaption: { fontSize: 10, color: '#6B7280', padding: 4, textAlign: 'center' },
  statusBadge: { position: 'absolute', top: 6, left: 6, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  statusBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  badgeWaiting: { backgroundColor: 'rgba(146, 64, 14, 0.9)' },
  badgeUploading: { backgroundColor: 'rgba(37, 99, 235, 0.92)' },
  badgeFailing: { backgroundColor: '#DC2626' },
  badgeUploaded: { backgroundColor: 'rgba(22, 163, 74, 0.9)' },
  clientBadge: { position: 'absolute', top: 6, right: 6, backgroundColor: TEAL, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  clientBadgeText: { color: '#fff', fontSize: 8, fontWeight: '700' },
  hint: { textAlign: 'center', fontSize: 11, color: '#9CA3AF', marginTop: 16 },
})
