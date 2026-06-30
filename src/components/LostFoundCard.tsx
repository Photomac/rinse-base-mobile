// src/components/LostFoundCard.tsx
// Lost & found — the crew logs a guest belonging left behind (e.g. a jacket
// found during a turnover). Writes a job_damage_reports row with
// report_type:'lost_found', then heads-up the cleaning company ONLY
// (notify-damage-report recipients:'owner'). It's owner-controlled: the manager
// reviews it in the web Issues view and chooses whether to send it to the host.
// Shown on JobDetailScreen. Bilingual via useLang. Mirrors the web DamageReportTab
// lost & found flow.

import React, { useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Image, Alert } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { CARD, BORDER, TEXT, TEXT_MUTED, TEXT_LIGHT } from '../lib/theme'

const PURPLE = '#8B5CF6'

export function LostFoundCard({ job, user }: { job: any; user: any }) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const [item, setItem] = useState('')
  const [note, setNote] = useState('')
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)

  function reset() {
    setItem(''); setNote(''); setPhotoUrl(null); setOpen(false)
  }

  async function addPhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync()
    if (status !== 'granted') return
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.7 })
    if (result.canceled || !result.assets?.[0]) return
    setUploading(true)
    try {
      const asset = result.assets[0]
      const path = `${user.tenant_id}/${job.id}/lostfound_${Date.now()}.jpg`
      const response = await fetch(asset.uri)
      const blob = await response.blob()
      const { error } = await supabase.storage.from('job-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: true })
      if (error) { Alert.alert(t('upload_failed'), error.message); setUploading(false); return }
      const { data } = supabase.storage.from('job-photos').getPublicUrl(path)
      setPhotoUrl(data.publicUrl)
    } catch (e: any) {
      Alert.alert(t('upload_failed'), e?.message || '')
    }
    setUploading(false)
  }

  async function save() {
    if (!item.trim()) { Alert.alert(t('lf_need_item')); return }
    setSaving(true)
    try {
      const addressId = job.client_addresses?.id || job.address_id || null
      await supabase.from('job_damage_reports').insert({
        tenant_id: user.tenant_id,
        job_id: job.id,
        address_id: addressId,
        reported_by: user?.id ?? null,
        report_type: 'lost_found',
        severity: 'minor',
        title: item.trim(),
        description: note.trim() || null,
        photo_urls: photoUrl ? [photoUrl] : [],
        status: 'reported',
      })

      // Heads-up the cleaning company only — the host is told later, if/when the
      // manager reviews it and chooses to send (owner-controlled QC).
      try {
        await supabase.functions.invoke('notify-damage-report', {
          body: { job_id: job.id, tenant_id: user.tenant_id, report_type: 'lost_found', severity: 'minor', title: item.trim(), photo_url: photoUrl, recipients: 'owner' },
        })
      } catch { /* report is saved; notify is best-effort */ }

      reset()
      Alert.alert(`🧳 ${t('lf_saved_title')}`, t('lf_saved_msg'))
    } catch (e: any) {
      Alert.alert(t('error'), e?.message || t('could_not_upload'))
    }
    setSaving(false)
  }

  if (!open) {
    return (
      <TouchableOpacity style={styles.openBtn} onPress={() => setOpen(true)}>
        <Text style={styles.openBtnText}>{t('lf_open')}</Text>
      </TouchableOpacity>
    )
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>🧳 {t('lf_title')}</Text>
      <Text style={styles.sub}>{t('lf_sub')}</Text>

      <Text style={styles.label}>{t('lf_item_label')}</Text>
      <TextInput
        style={styles.input}
        value={item}
        onChangeText={setItem}
        placeholder={t('lf_item_placeholder')}
        placeholderTextColor={TEXT_LIGHT}
      />

      <TextInput
        style={[styles.input, styles.noteInput]}
        value={note}
        onChangeText={setNote}
        placeholder={t('lf_note_placeholder')}
        placeholderTextColor={TEXT_LIGHT}
        multiline
        numberOfLines={2}
      />

      {photoUrl ? (
        <View style={styles.photoRow}>
          <Image source={{ uri: photoUrl }} style={styles.thumb} />
          <Text style={styles.photoAdded}>{t('lf_photo_added')}</Text>
        </View>
      ) : (
        <TouchableOpacity style={styles.photoBtn} onPress={addPhoto} disabled={uploading}>
          <Text style={styles.photoBtnText}>{uploading ? '…' : t('lf_add_photo')}</Text>
        </TouchableOpacity>
      )}

      <View style={styles.actions}>
        <TouchableOpacity style={styles.cancelBtn} onPress={reset} disabled={saving}>
          <Text style={styles.cancelBtnText}>{t('lf_cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.saveBtn, (!item.trim() || saving) && styles.saveBtnDisabled]} onPress={save} disabled={!item.trim() || saving}>
          <Text style={styles.saveBtnText}>{saving ? t('lf_saving') : t('lf_save')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  openBtn: { backgroundColor: CARD, borderRadius: 14, paddingVertical: 13, alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: PURPLE + '55', borderStyle: 'dashed' },
  openBtnText: { fontSize: 14, fontWeight: '700', color: PURPLE },
  card: { backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: PURPLE + '55' },
  title: { fontSize: 15, fontWeight: '800', color: TEXT },
  sub: { fontSize: 12, color: TEXT_MUTED, marginTop: 2, marginBottom: 12, lineHeight: 17 },
  label: { fontSize: 12, fontWeight: '600', color: TEXT_MUTED, marginBottom: 5 },
  input: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, padding: 12, fontSize: 13, color: TEXT, marginBottom: 10 },
  noteInput: { minHeight: 54, textAlignVertical: 'top' },
  photoRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  thumb: { width: 48, height: 48, borderRadius: 8, marginRight: 10, borderWidth: 1, borderColor: BORDER },
  photoAdded: { fontSize: 13, fontWeight: '700', color: '#15803D' },
  photoBtn: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginBottom: 12 },
  photoBtnText: { fontSize: 13, fontWeight: '600', color: TEXT_MUTED },
  actions: { flexDirection: 'row', gap: 8 },
  cancelBtn: { flex: 1, borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: { fontSize: 14, fontWeight: '700', color: TEXT_MUTED },
  saveBtn: { flex: 2, backgroundColor: PURPLE, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  saveBtnDisabled: { backgroundColor: BORDER },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
})
