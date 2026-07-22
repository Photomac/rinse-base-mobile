// src/components/IncidentReportCard.tsx
// Property Incident Report — crew files damage, missing-item, maintenance,
// pest, safety, and lost & found reports from JobDetailScreen. Mirrors the web
// DamageReportTab: writes a job_damage_reports row with status:'reported', then
// heads-up the cleaning company ONLY (notify-damage-report recipients:'owner').
// It's owner-controlled: the manager reviews it in the web Issues view and
// chooses whether to send it to the host.
// Absorbs the old LostFoundCard — lost_found is a picker type that keeps the
// guest-belonging wording (lf_* keys) and skips the severity rating.
// Icons/colors per type MUST stay in sync with the web DamageReportTab
// REPORT_TYPES and the notify-damage-report email TYPE_ICON map.
// (Table/function names keep the legacy "damage report" identifiers on purpose.)

import React, { useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Image, Alert } from 'react-native'
import { pickAndUploadImage } from '../lib/chatAttachments'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { TranslationKey } from '../lib/i18n'
import { CARD, BORDER, TEXT, TEXT_MUTED, TEXT_LIGHT } from '../lib/theme'

const RED = '#EF4444'

const REPORT_TYPES: { id: string; labelKey: TranslationKey; icon: string; color: string }[] = [
  { id: 'damage',      labelKey: 'ir_type_damage',      icon: '💥', color: '#EF4444' },
  { id: 'missing',     labelKey: 'ir_type_missing',     icon: '🔍', color: '#F59E0B' },
  { id: 'maintenance', labelKey: 'ir_type_maintenance', icon: '🔧', color: '#3B82F6' },
  { id: 'pest',        labelKey: 'ir_type_pest',        icon: '🐜', color: '#A16207' },
  { id: 'safety',      labelKey: 'ir_type_safety',      icon: '⚠️', color: '#7C3AED' },
  { id: 'lost_found',  labelKey: 'ir_type_lost_found',  icon: '🧳', color: '#8B5CF6' },
]

const SEVERITY: { id: string; labelKey: TranslationKey; descKey: TranslationKey; color: string }[] = [
  { id: 'minor',    labelKey: 'ir_sev_minor',    descKey: 'ir_sev_minor_desc',    color: '#10B981' },
  { id: 'moderate', labelKey: 'ir_sev_moderate', descKey: 'ir_sev_moderate_desc', color: '#F59E0B' },
  { id: 'serious',  labelKey: 'ir_sev_serious',  descKey: 'ir_sev_serious_desc',  color: '#EF4444' },
]

export function IncidentReportCard({ job, user }: { job: any; user: any }) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const [reportType, setReportType] = useState('damage')
  const [severity, setSeverity] = useState('minor')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [photoUrls, setPhotoUrls] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)

  const type = REPORT_TYPES.find(rt => rt.id === reportType) || REPORT_TYPES[0]
  // Lost & found isn't damage — a guest left a belonging behind. It skips the
  // severity rating and uses the found-item wording.
  const isLF = reportType === 'lost_found'

  function reset() {
    setReportType('damage'); setSeverity('minor')
    setTitle(''); setDescription(''); setPhotoUrls([]); setOpen(false)
  }

  async function addPhoto() {
    setUploading(true)
    try {
      // pickAndUploadImage sends FormData straight to the storage REST endpoint
      // — supabase-js .upload() with a fetched Blob writes a 0-byte object
      // under React Native. Camera-only so incident photos are always fresh.
      const url = await pickAndUploadImage('camera', user.tenant_id, job.id)
      if (url) setPhotoUrls(p => [...p, url])
    } catch (e: any) {
      Alert.alert(t('upload_failed'), e?.message || '')
    }
    setUploading(false)
  }

  async function save() {
    if (!title.trim()) { Alert.alert(t(isLF ? 'lf_need_item' : 'ir_need_title')); return }
    setSaving(true)
    try {
      const addressId = job.client_addresses?.id || job.address_id || null
      const sev = isLF ? 'minor' : severity
      // supabase-js returns { error } instead of throwing — check it, or a failed
      // insert falls through to the "saved" success path (silent-failure family).
      const { error: insertError } = await supabase.from('job_damage_reports').insert({
        tenant_id: user.tenant_id,
        job_id: job.id,
        address_id: addressId,
        reported_by: user?.id ?? null,
        report_type: reportType,
        severity: sev,
        title: title.trim(),
        description: description.trim() || null,
        photo_urls: photoUrls,
        status: 'reported',
      })
      if (insertError) throw insertError

      // Heads-up the cleaning company only — the host is told later, if/when the
      // manager reviews it and chooses to send (owner-controlled QC).
      try {
        await supabase.functions.invoke('notify-damage-report', {
          body: { job_id: job.id, tenant_id: user.tenant_id, report_type: reportType, severity: sev, title: title.trim(), photo_url: photoUrls[0] || null, recipients: 'owner' },
        })
      } catch { /* report is saved; notify is best-effort */ }

      const icon = type.icon
      reset()
      Alert.alert(`${icon} ${t(isLF ? 'lf_saved_title' : 'ir_saved_title')}`, t(isLF ? 'lf_saved_msg' : 'ir_saved_msg'))
    } catch (e: any) {
      Alert.alert(t('error'), e?.message || t('could_not_upload'))
    }
    setSaving(false)
  }

  if (!open) {
    return (
      <TouchableOpacity style={styles.openBtn} onPress={() => setOpen(true)}>
        <Text style={styles.openBtnText}>{t('ir_open')}</Text>
      </TouchableOpacity>
    )
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>📋 {t('ir_title')}</Text>
      <Text style={styles.sub}>{t('ir_sub')}</Text>

      <Text style={styles.label}>{t('ir_type_label')}</Text>
      <View style={styles.typeGrid}>
        {REPORT_TYPES.map(rt => {
          const sel = reportType === rt.id
          return (
            <TouchableOpacity
              key={rt.id}
              style={[styles.typeBtn, sel && { borderColor: rt.color, backgroundColor: rt.color + '15' }]}
              onPress={() => setReportType(rt.id)}
            >
              <Text style={styles.typeIcon}>{rt.icon}</Text>
              <Text style={[styles.typeLabel, sel && { color: rt.color, fontWeight: '700' }]} numberOfLines={1}>
                {t(rt.labelKey)}
              </Text>
            </TouchableOpacity>
          )
        })}
      </View>

      {!isLF && (
        <>
          <Text style={styles.label}>{t('ir_severity_label')}</Text>
          <View style={styles.sevRow}>
            {SEVERITY.map(s => {
              const sel = severity === s.id
              return (
                <TouchableOpacity
                  key={s.id}
                  style={[styles.sevBtn, sel && { borderColor: s.color, backgroundColor: s.color + '15' }]}
                  onPress={() => setSeverity(s.id)}
                >
                  <Text style={[styles.sevLabel, sel && { color: s.color, fontWeight: '700' }]}>{t(s.labelKey)}</Text>
                  <Text style={styles.sevDesc}>{t(s.descKey)}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </>
      )}

      <Text style={styles.label}>{t(isLF ? 'lf_item_label' : 'ir_what_label')} *</Text>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        placeholder={t(isLF ? 'lf_item_placeholder' : 'ir_what_placeholder')}
        placeholderTextColor={TEXT_LIGHT}
      />

      <TextInput
        style={[styles.input, styles.noteInput]}
        value={description}
        onChangeText={setDescription}
        placeholder={t(isLF ? 'lf_note_placeholder' : 'ir_details_placeholder')}
        placeholderTextColor={TEXT_LIGHT}
        multiline
        numberOfLines={2}
      />

      {photoUrls.length > 0 && (
        <View style={styles.photoRow}>
          {photoUrls.map((url, i) => (
            <View key={i}>
              <Image source={{ uri: url }} style={styles.thumb} />
              <TouchableOpacity style={styles.removePhoto} onPress={() => setPhotoUrls(p => p.filter((_, j) => j !== i))}>
                <Text style={styles.removePhotoText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
      <TouchableOpacity style={styles.photoBtn} onPress={addPhoto} disabled={uploading}>
        <Text style={styles.photoBtnText}>{uploading ? '…' : t('lf_add_photo')}</Text>
      </TouchableOpacity>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.cancelBtn} onPress={reset} disabled={saving}>
          <Text style={styles.cancelBtnText}>{t('lf_cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.saveBtn, { backgroundColor: type.color }, (!title.trim() || saving) && styles.saveBtnDisabled]}
          onPress={save}
          disabled={!title.trim() || saving}
        >
          <Text style={styles.saveBtnText}>{saving ? t('lf_saving') : t(isLF ? 'lf_save' : 'ir_save')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  openBtn: { backgroundColor: CARD, borderRadius: 14, paddingVertical: 13, alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: RED + '55', borderStyle: 'dashed' },
  openBtnText: { fontSize: 14, fontWeight: '700', color: RED },
  card: { backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: RED + '55' },
  title: { fontSize: 15, fontWeight: '800', color: TEXT },
  sub: { fontSize: 12, color: TEXT_MUTED, marginTop: 2, marginBottom: 12, lineHeight: 17 },
  label: { fontSize: 12, fontWeight: '600', color: TEXT_MUTED, marginBottom: 5 },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  typeBtn: { flexBasis: '48%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderColor: BORDER, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 10 },
  typeIcon: { fontSize: 14 },
  typeLabel: { flex: 1, fontSize: 11, color: TEXT_MUTED },
  sevRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  sevBtn: { flex: 1, borderWidth: 1.5, borderColor: BORDER, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 4, alignItems: 'center' },
  sevLabel: { fontSize: 11, color: TEXT_MUTED },
  sevDesc: { fontSize: 8, color: TEXT_LIGHT, marginTop: 1, textAlign: 'center' },
  input: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, padding: 12, fontSize: 13, color: TEXT, marginBottom: 10 },
  noteInput: { minHeight: 54, textAlignVertical: 'top' },
  photoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  thumb: { width: 60, height: 60, borderRadius: 8, borderWidth: 1, borderColor: BORDER },
  removePhoto: { position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  removePhotoText: { color: '#fff', fontSize: 11, fontWeight: '700', lineHeight: 13 },
  photoBtn: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginBottom: 12 },
  photoBtnText: { fontSize: 13, fontWeight: '600', color: TEXT_MUTED },
  actions: { flexDirection: 'row', gap: 8 },
  cancelBtn: { flex: 1, borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: { fontSize: 14, fontWeight: '700', color: TEXT_MUTED },
  saveBtn: { flex: 2, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  saveBtnDisabled: { backgroundColor: BORDER },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
})
