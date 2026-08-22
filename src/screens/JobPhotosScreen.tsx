import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Image, Alert, ActivityIndicator, TextInput, Modal, KeyboardAvoidingView, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { ensureCameraCapture } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { enqueuePhoto, flushQueue, pendingStatus, PendingStatus } from '../lib/photoQueue'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { PhotoViewer, ViewerPhoto } from '../components/PhotoViewer'

import { SLATE_DARK, GOLD } from '../lib/theme'
const TEAL = GOLD
const NAVY = SLATE_DARK

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
}

export function JobPhotosScreen({ job, user, onBack, preselectedItem }: Props) {
  const { t } = useLang()
  const [photos, setPhotos] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [selectedType, setSelectedType] = useState('after')
  const [caption, setCaption] = useState(preselectedItem?.title || '')
  const [visibleToClient, setVisibleToClient] = useState(true)
  const [pending, setPending] = useState<PendingStatus>({ count: 0, serverRejected: 0, lastServerError: null })
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  // Editing a note on a photo that already exists. The capture-time caption
  // field cannot serve this: it is consumed and cleared by uploadPhoto, so a
  // note typed after the shot silently applied to the NEXT one, or to nothing
  // at all. Reported by Cleanfix Squad 2026-08-21 — the crew asked the office a
  // question through it and the text was never saved.
  const [noteFor, setNoteFor] = useState<any | null>(null)
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  // The owner's named shot list for this property + which shots are already in.
  const [reqs, setReqs] = useState<any[]>([])
  const [shotByReq, setShotByReq] = useState<Record<string, string>>({})

  const addr = job.client_addresses as any
  const client = job.clients as any
  const addressId = addr?.id || job.address_id || null

  useEffect(() => {
    loadPhotos()
    loadRequirements()
    // Opening the screen in coverage drains any photos captured earlier offline.
    flushQueue().then(({ uploaded }) => { if (uploaded > 0) loadPhotos() }).catch(() => {})
      .finally(() => { pendingStatus().then(setPending).catch(() => {}) })
  }, [])

  async function loadRequirements() {
    if (!addressId) return
    const { data } = await supabase
      .from('property_photo_requirements')
      .select('id, area_name, section, required, sort_order')
      .eq('address_id', addressId)
      .order('sort_order')
    setReqs(data ?? [])
  }

  async function loadPhotos() {
    setLoading(true)
    const { data } = await supabase
      .from('job_photos')
      .select('*')
      .eq('job_id', job.id)
      .order('created_at', { ascending: false })
    const rows = data ?? []
    setPhotos(rows)
    // Newest-first ordering above means the first hit per requirement is the
    // latest shot — a retake replaces the thumbnail.
    const map: Record<string, string> = {}
    for (const p of rows as any[]) {
      if (p.photo_requirement_id && !map[p.photo_requirement_id]) map[p.photo_requirement_id] = p.photo_url
    }
    setShotByReq(map)
    setLoading(false)
  }

  // Shoot against a named requirement. Tagged with photo_requirement_id (the
  // only thing the gate accepts) and typed 'after' so one capture also clears
  // the baseline after-photo rule.
  async function takeRequiredPhoto(req: any) {
    if (await ensureCameraCapture() !== 'granted') return
    try {
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false })
      if (result.canceled) return
      setUploading(true)
      try {
        await enqueuePhoto({
          uri: result.assets[0].uri,
          tenant_id: user.tenant_id,
          job_id: job.id,
          user_id: user.id,
          photo_type: 'after',
          caption: req.area_name,
          photo_requirement_id: req.id,
          visible_to_client: true,
        })
        const flushed = await flushQueue()
        setPending({ count: flushed.remaining, serverRejected: flushed.serverRejected, lastServerError: flushed.lastServerError })
        loadPhotos()
        if (flushed.remaining > 0 && flushed.serverRejected === 0) {
          Alert.alert(`📥 ${t('photo_saved_offline_title')}`, t('photo_saved_offline_msg'))
        }
      } catch (e: any) {
        Alert.alert(t('upload_failed'), e.message || t('could_not_upload'))
      }
      setUploading(false)
    } catch { /* permission race / camera unavailable — no crash */ }
  }


  async function takePhoto() {
    // ensureCameraCapture prompts (camera + iOS photo roll), or shows a
    // Settings deep-link if blocked, and returns non-granted rather than
    // letting launchCameraAsync throw.
    if (await ensureCameraCapture() !== 'granted') return
    try {
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        allowsEditing: false,
      })
      if (result.canceled) return
      await uploadPhoto(result.assets[0].uri)
    } catch { /* permission race / camera unavailable — no crash */ }
  }

  async function uploadPhoto(uri: string) {
    setUploading(true)
    // Capture before setCaption('') clears it — a damage report reuses it as the note/title.
    const damageCaption = caption.trim()
    try {
      // Persist + queue first so the photo is never lost, then try to send it now.
      // Offline → it stays queued and uploads automatically once back in coverage.
      // Canonical checklist link: this photo satisfies the preselected item as
      // long as the caption still names it (legacy caption-matching wouldn't
      // have counted an edited caption either). The caption itself stays as a
      // dual-write until old bundles that match on it have aged out.
      const checklistItemId =
        preselectedItem?.jobItemId && caption.trim() === (preselectedItem.title || '').trim()
          ? preselectedItem.jobItemId
          : null
      await enqueuePhoto({
        uri,
        tenant_id: user.tenant_id,
        job_id: job.id,
        user_id: user.id,
        photo_type: selectedType === 'damage' ? 'issue' : selectedType,
        caption: caption.trim() || null,
        checklist_item_id: checklistItemId,
        visible_to_client: visibleToClient,
      })
      const result = await flushQueue()
      setPending({ count: result.remaining, serverRejected: result.serverRejected, lastServerError: result.lastServerError })

      setCaption('')
      loadPhotos()

      if (result.remaining > 0) {
        if (result.serverRejected > 0) {
          // The server heard us and said no (auth/policy/etc). Signal is fine —
          // don't tell the crew to wait for coverage; tell them who can fix it.
          Alert.alert(
            `⚠️ ${t('photo_upload_failing_title')}`,
            ti(t('photo_upload_failing_msg'), { error: result.lastServerError || '?' }),
          )
        } else {
          // No signal — the photo is safely saved on the device and will sync itself.
          Alert.alert(`📥 ${t('photo_saved_offline_title')}`, t('photo_saved_offline_msg'))
        }
        setUploading(false)
        return
      }
      
      if (selectedType === 'damage') {
        Alert.alert(
          `⚠️ ${t('damage_photo_saved')}`,
          t('damage_flag_msg'),
          [
            { text: t('not_now'), style: 'cancel' },
            {
              text: t('flag_for_report'),
              onPress: () => submitDamageReport(damageCaption),
            }
          ]
        )
      } else {
        Alert.alert(`✅ ${t('uploaded_ok')}`, t('photo_saved'))
      }
    } catch (e: any) {
      Alert.alert(t('upload_failed'), e.message || t('could_not_upload'))
    }
    setUploading(false)
  }

  // Create a real damage report the owner can see + send to the host. A tagged
  // damage photo alone lives only in job_photos, which the owner's Issues view and
  // dashboard never read — they're built on job_damage_reports (same as IncidentReportCard).
  async function submitDamageReport(captionText: string) {
    try {
      // The damage photo was saved as photo_type 'issue' — grab its URL for the report.
      const { data: latest } = await supabase
        .from('job_photos')
        .select('photo_url')
        .eq('job_id', job.id)
        .eq('photo_type', 'issue')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const photoUrl = (latest as any)?.photo_url || null

      const addressId = job.client_addresses?.id || job.address_id || null
      const title = captionText || 'Incident reported by crew'
      const { error } = await supabase.from('job_damage_reports').insert({
        tenant_id: user.tenant_id,
        job_id: job.id,
        address_id: addressId,
        reported_by: user?.id ?? null,
        report_type: 'damage',
        severity: 'minor',
        title,
        description: captionText || null,
        photo_urls: photoUrl ? [photoUrl] : [],
        status: 'reported',
      })
      if (error) throw error

      // Heads-up the cleaning company only — the host is told later, if/when the
      // owner reviews and chooses to send (owner-controlled QC).
      try {
        await supabase.functions.invoke('notify-damage-report', {
          body: { job_id: job.id, tenant_id: user.tenant_id, report_type: 'damage', severity: 'minor', title, photo_url: photoUrl, recipients: 'owner' },
        })
      } catch { /* report is saved; notify is best-effort */ }

      Alert.alert(`✓ ${t('photo_flagged')}`, t('damage_report_sent'))
    } catch (e: any) {
      Alert.alert(t('error'), e?.message || t('could_not_upload'))
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

  // Required-shot progress. Optional shots are shown but never counted against
  // the crew — only `required` rows gate completion.
  const requiredReqs = reqs.filter(r => r.required)
  const requiredTotal = requiredReqs.length
  const requiredDone = requiredReqs.filter(r => shotByReq[r.id]).length
  const requiredRemaining = requiredTotal - requiredDone

  // Group by the owner's section, preserving sort_order within each. Manual
  // "+ Add area" rows have section=null and fall under General.
  const reqSections: { name: string; items: any[] }[] = []
  for (const r of reqs) {
    const name = r.section || 'General'
    let s = reqSections.find(x => x.name === name)
    if (!s) { s = { name, items: [] }; reqSections.push(s) }
    s.items.push(r)
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
        {/* Pending queue status — crew proof-of-work must never feel uncertain.
            Yellow = waiting on signal; red = the server is rejecting uploads
            (shows the error, so it's not mistaken for coverage). Tap retries. */}
        {pending.count > 0 && (
          <TouchableOpacity
            onPress={() => flushQueue({ force: true }).then(r => { setPending({ count: r.remaining, serverRejected: r.serverRejected, lastServerError: r.lastServerError }); if (r.uploaded > 0) loadPhotos() }).catch(() => {})}
            style={pending.serverRejected > 0
              ? { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FCA5A5', borderRadius: 10, padding: 10, marginBottom: 10 }
              : { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEF9C3', borderWidth: 1, borderColor: '#FCD34D', borderRadius: 10, padding: 10, marginBottom: 10 }}>
            <Text style={{ fontSize: 16 }}>{pending.serverRejected > 0 ? '⚠️' : '📥'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: pending.serverRejected > 0 ? '#991B1B' : '#854D0E' }}>
                {pending.count} 📷 {pending.serverRejected > 0 ? t('pending_upload_failing') : t('pending_upload')}
              </Text>
              {pending.serverRejected > 0 && !!pending.lastServerError && (
                <Text style={{ fontSize: 10, color: '#991B1B', marginTop: 2 }} numberOfLines={2}>
                  {pending.lastServerError}
                </Text>
              )}
            </View>
            <Text style={{ fontSize: 11, fontWeight: '700', color: pending.serverRejected > 0 ? '#991B1B' : '#854D0E' }}>↻</Text>
          </TouchableOpacity>
        )}
        {/* Required shots — the owner's named list for this property. Sits above
            free-form capture because it's the work the crew is actually
            accountable for; free-form before/after stays available below. */}
        {reqs.length > 0 && (
          <View style={styles.reqCard}>
            <View style={styles.reqHeader}>
              <Text style={styles.reqTitle}>📋 {t('required_photos')}</Text>
              <Text style={[styles.reqCount, requiredRemaining === 0 && { color: '#166534' }]}>
                {requiredRemaining === 0
                  ? `✓ ${t('all_required_done')}`
                  : ti(t('required_photos_left'), { done: String(requiredDone), total: String(requiredTotal) })}
              </Text>
            </View>
            {reqSections.map(section => (
              <View key={section.name} style={{ marginTop: 8 }}>
                <Text style={styles.reqSectionLabel}>{section.name}</Text>
                {section.items.map((req: any) => {
                  const shot = shotByReq[req.id]
                  const missing = req.required && !shot
                  return (
                    <TouchableOpacity
                      key={req.id}
                      onPress={() => takeRequiredPhoto(req)}
                      disabled={uploading}
                      style={[
                        styles.reqRow,
                        shot ? styles.reqRowDone : missing ? styles.reqRowMissing : null,
                      ]}>
                      {shot
                        ? <Image source={{ uri: shot }} style={styles.reqThumb} />
                        : <View style={[styles.reqThumb, styles.reqThumbEmpty]}><Text style={{ fontSize: 13, opacity: 0.5 }}>📷</Text></View>}
                      <View style={{ flex: 1 }}>
                        <Text style={styles.reqName}>
                          {req.area_name}
                          {!req.required && <Text style={styles.reqOptional}> · {t('optional_photo')}</Text>}
                        </Text>
                      </View>
                      <Text style={[styles.reqAction, shot && { color: '#6B7280' }]}>
                        {shot ? t('retake_photo') : t('take_photo')}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            ))}
          </View>
        )}

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

        {/* Upload buttons */}
        <View style={styles.uploadRow}>
          <TouchableOpacity style={styles.cameraBtn} onPress={takePhoto} disabled={uploading}>
            <Text style={styles.cameraBtnText}>📷 {t('take_photo')}</Text>
          </TouchableOpacity>
        </View>

        {uploading && (
          <View style={styles.uploadingBar}>
            <ActivityIndicator color={TEAL} size="small" />
            <Text style={styles.uploadingText}>{t('uploading')}</Text>
          </View>
        )}

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
                      onLongPress={() => openPhotoOptions(photo)}
                    >
                      <Image source={{ uri: photo.photo_url }} style={styles.photo} />
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

const styles = StyleSheet.create({
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
  uploadingBar: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#ECFDF5', borderRadius: 10, padding: 12, marginBottom: 12 },
  uploadingText: { color: '#065F46', fontSize: 13, fontWeight: '600' },
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
  clientBadge: { position: 'absolute', top: 6, right: 6, backgroundColor: TEAL, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  clientBadgeText: { color: '#fff', fontSize: 8, fontWeight: '700' },
  hint: { textAlign: 'center', fontSize: 11, color: '#9CA3AF', marginTop: 16 },
})
