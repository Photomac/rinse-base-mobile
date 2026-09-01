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

import React, { useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Image, Alert } from 'react-native'
import { pickAndUploadImage } from '../lib/chatAttachments'
import { supabase } from '../lib/supabase'
import { roomLabel } from '../lib/rooms'
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
  { id: 'linen',       labelKey: 'ir_type_linen',       icon: '🧺', color: '#0E7490' },
  { id: 'lost_found',  labelKey: 'ir_type_lost_found',  icon: '🧳', color: '#8B5CF6' },
]

// Linen is a loss/condition report against the property's linen list (the
// same address_inventory rows the Supplies screen packs against): item + qty +
// condition instead of a severity rating. Saving it ALSO flags the linen
// ledger (job_inventory_log) so the owner's pull sheet, Supplies restock list
// and by-client loss report see it. The stored title and ledger note use the
// English label so the owner reads one vocabulary whatever language the crew
// works in; the chips show t(labelKey).
const LINEN_CONDITIONS: { id: string; labelKey: TranslationKey; en: string }[] = [
  { id: 'stained', labelKey: 'ir_linen_stained', en: 'Stained' },
  { id: 'torn',    labelKey: 'ir_linen_torn',    en: 'Torn / worn out' },
  { id: 'missing', labelKey: 'ir_linen_missing', en: 'Missing' },
  { id: 'rewash',  labelKey: 'ir_linen_rewash',  en: 'Needs rewash' },
]
type LinenItem = { id: string; item_name: string; par_level: number | null }
const stepBtn = { width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderColor: BORDER, alignItems: 'center' as const, justifyContent: 'center' as const }

const SEVERITY: { id: string; labelKey: TranslationKey; descKey: TranslationKey; color: string }[] = [
  { id: 'minor',    labelKey: 'ir_sev_minor',    descKey: 'ir_sev_minor_desc',    color: '#10B981' },
  { id: 'moderate', labelKey: 'ir_sev_moderate', descKey: 'ir_sev_moderate_desc', color: '#F59E0B' },
  { id: 'serious',  labelKey: 'ir_sev_serious',  descKey: 'ir_sev_serious_desc',  color: '#EF4444' },
]

// rooms: the property's property_rooms (from JobDetailScreen). presetRoom +
// presetKey: the checklist hand-off — bumping presetKey opens the form with
// that room selected, so "Report an issue in Bathroom 2" lands here pre-filled.
export function IncidentReportCard({ job, user, rooms = [], presetRoom = null, presetKey = 0 }: {
  job: any; user: any; rooms?: any[]; presetRoom?: { id: string; name: string } | null; presetKey?: number
}) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const [reportType, setReportType] = useState('damage')
  const [severity, setSeverity] = useState('minor')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [photoUrls, setPhotoUrls] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [linenItems, setLinenItems] = useState<LinenItem[]>([])
  const [linenItemId, setLinenItemId] = useState('')
  const [linenQty, setLinenQty] = useState(1)
  const [linenCond, setLinenCond] = useState('stained')
  const [roomId, setRoomId] = useState('')

  useEffect(() => {
    if (presetKey > 0) { setOpen(true); setRoomId(presetRoom?.id || '') }
  }, [presetKey])
  const roomRows = rooms.filter((r: any) => !r.archived_at && r.room_type !== 'final')
  const roomName = roomId ? (roomRows.find((r: any) => r.id === roomId) ? roomLabel(roomRows.find((r: any) => r.id === roomId)) : presetRoom?.name || null) : null

  const type = REPORT_TYPES.find(rt => rt.id === reportType) || REPORT_TYPES[0]
  // Lost & found isn't damage — a guest left a belonging behind. It skips the
  // severity rating and uses the found-item wording.
  const isLF = reportType === 'lost_found'
  const isLinen = reportType === 'linen'
  const unrated = isLF || isLinen
  const addressId = job.client_addresses?.id || job.address_id || null

  // The property's linen list, loaded once the form opens.
  useEffect(() => {
    if (!open || !addressId) return
    supabase.from('address_inventory').select('id, item_name, par_level')
      .eq('address_id', addressId).eq('category', 'Linens').order('sort_order')
      .then(({ data }) => setLinenItems((data ?? []) as LinenItem[]))
  }, [open, addressId])

  const linenItem = linenItems.find(i => i.id === linenItemId) || null
  const linenCondEn = LINEN_CONDITIONS.find(c => c.id === linenCond)?.en || linenCond
  // A picked linen item files under a composed title ("2× King sheet set —
  // Stained"); with no linen list on the property the crew describes it freely.
  const linenTitle = linenItem ? `${linenQty}× ${linenItem.item_name} — ${linenCondEn}` : title.trim()
  const canSubmit = isLinen ? (!!linenItem || !!title.trim()) : !!title.trim()

  function reset() {
    setReportType('damage'); setSeverity('minor')
    setTitle(''); setDescription(''); setPhotoUrls([]); setOpen(false)
    setLinenItemId(''); setLinenQty(1); setLinenCond('stained'); setRoomId('')
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
    if (!canSubmit) { Alert.alert(t(isLF ? 'lf_need_item' : 'ir_need_title')); return }
    setSaving(true)
    try {
      const finalTitle = isLinen ? linenTitle : title.trim()
      // Unrated types never carry a severity the crew picked before switching type.
      const sev = unrated ? 'minor' : severity
      // supabase-js returns { error } instead of throwing — check it, or a failed
      // insert falls through to the "saved" success path (silent-failure family).
      const { data: inserted, error: insertError } = await supabase.from('job_damage_reports').insert({
        tenant_id: user.tenant_id,
        job_id: job.id,
        address_id: addressId,
        reported_by: user?.id ?? null,
        report_type: reportType,
        severity: sev,
        title: finalTitle,
        description: description.trim() || null,
        room_id: roomId || null,
        photo_urls: photoUrls,
        status: 'reported',
      }).select('id').single()
      if (insertError) throw insertError

      // Mirror a linen report into the linen ledger — the same job_inventory_log
      // row the Supplies screen, the owner's pull sheet "Linen issues" and the
      // by-client loss report read. One row per (job, item): update the pack
      // row if the crew already has one, else insert an unpacked one.
      // incident_id ties the two so the loss counts once and the restock email
      // stays quiet (the incident email covers it; the host hears on Send to host).
      if (isLinen && linenItem && inserted?.id) {
        try {
          const note = `${linenCondEn} ×${linenQty}${description.trim() ? ` — ${description.trim()}` : ''}`
          const { data: existing } = await supabase.from('job_inventory_log').select('id, notes')
            .eq('job_id', job.id).eq('inventory_id', linenItem.id).limit(1).maybeSingle()
          const notes = existing?.notes ? `${existing.notes}\n${note}` : note
          const { error: ledgerError } = existing
            ? await supabase.from('job_inventory_log').update({ needs_restock: true, notes, incident_id: inserted.id }).eq('id', existing.id)
            : await supabase.from('job_inventory_log').insert({
                tenant_id: user.tenant_id, job_id: job.id, inventory_id: linenItem.id, item_name: linenItem.item_name,
                qty_used: 0, needs_restock: true, notes, incident_id: inserted.id,
              })
          if (ledgerError) throw ledgerError
        } catch { Alert.alert(t('ir_linen_ledger_warn')) }
      }

      // Heads-up the cleaning company only — the host is told later, if/when the
      // manager reviews it and chooses to send (owner-controlled QC).
      try {
        await supabase.functions.invoke('notify-damage-report', {
          body: { job_id: job.id, tenant_id: user.tenant_id, report_type: reportType, severity: sev, title: finalTitle, room: roomName, photo_url: photoUrls[0] || null, recipients: 'owner' },
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

      {roomRows.length > 0 && (
        <>
          <Text style={styles.label}>{t('ir_room_label')}</Text>
          <View style={styles.typeGrid}>
            {roomRows.map((r: any) => {
              const sel = roomId === r.id
              return (
                <TouchableOpacity key={r.id} style={[styles.typeBtn, sel && { borderColor: type.color, backgroundColor: type.color + '15' }]} onPress={() => setRoomId(sel ? '' : r.id)}>
                  <Text style={[styles.typeLabel, sel && { color: type.color, fontWeight: '700' }]} numberOfLines={1}>{roomLabel(r)}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </>
      )}

      {!unrated && (
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

      {isLinen && (
        <>
          <Text style={styles.label}>{t('ir_linen_which')}</Text>
          {linenItems.length === 0 ? (
            <Text style={[styles.sub, { marginBottom: 8 }]}>{t('ir_linen_none')}</Text>
          ) : (
            <View style={styles.typeGrid}>
              {linenItems.map(i => {
                const sel = linenItemId === i.id
                return (
                  <TouchableOpacity key={i.id} style={[styles.typeBtn, sel && { borderColor: type.color, backgroundColor: type.color + '15' }]} onPress={() => setLinenItemId(sel ? '' : i.id)}>
                    <Text style={[styles.typeLabel, sel && { color: type.color, fontWeight: '700' }]} numberOfLines={1}>{i.item_name}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 14, marginBottom: 10, alignItems: 'flex-start' }}>
            <View>
              <Text style={styles.label}>{t('ir_linen_qty')}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <TouchableOpacity onPress={() => setLinenQty(q => Math.max(1, q - 1))} style={stepBtn}><Text style={{ fontSize: 16, color: TEXT }}>−</Text></TouchableOpacity>
                <Text style={{ fontSize: 15, fontWeight: '700', color: TEXT, minWidth: 22, textAlign: 'center' }}>{linenQty}</Text>
                <TouchableOpacity onPress={() => setLinenQty(q => q + 1)} style={stepBtn}><Text style={{ fontSize: 16, color: TEXT }}>+</Text></TouchableOpacity>
              </View>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{t('ir_linen_condition')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {LINEN_CONDITIONS.map(c => {
                  const sel = linenCond === c.id
                  return (
                    <TouchableOpacity key={c.id} style={[styles.sevBtn, { flex: 0, paddingHorizontal: 10 }, sel && { borderColor: type.color, backgroundColor: type.color + '15' }]} onPress={() => setLinenCond(c.id)}>
                      <Text style={[styles.sevLabel, sel && { color: type.color, fontWeight: '700' }]}>{t(c.labelKey)}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </View>
          </View>
        </>
      )}

      {isLinen && linenItem ? (
        <Text style={[styles.sub, { marginBottom: 10 }]}>{t('ir_linen_filed_as')}: <Text style={{ color: TEXT, fontWeight: '700' }}>{linenTitle}</Text></Text>
      ) : (
        <>
          <Text style={styles.label}>{t(isLF ? 'lf_item_label' : 'ir_what_label')} *</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder={t(isLF ? 'lf_item_placeholder' : isLinen ? 'ir_linen_placeholder' : 'ir_what_placeholder')}
            placeholderTextColor={TEXT_LIGHT}
          />
        </>
      )}

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
          style={[styles.saveBtn, { backgroundColor: type.color }, (!canSubmit || saving) && styles.saveBtnDisabled]}
          onPress={save}
          disabled={!canSubmit || saving}
        >
          <Text style={styles.saveBtnText}>{saving ? t('lf_saving') : t(isLF ? 'lf_save' : isLinen ? 'ir_linen_save' : 'ir_save')}</Text>
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
