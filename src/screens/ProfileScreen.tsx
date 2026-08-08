import React, { useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import * as ImagePicker from 'expo-image-picker'
import { ensureCamera, ensureMediaLibrary } from '../lib/permissions'
import { Image } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { localeFor } from '../lib/i18n'
import { SLATE_DARK, GOLD } from '../lib/theme'
// JS API only — expo-updates is already in the native binary (it is what
// delivers OTAs), so reading these adds no native dependency and this screen
// stays OTA-shippable.
import * as Updates from 'expo-updates'

const ROLE_KEYS: Record<string, string> = {
  owner: 'role_owner', manager: 'role_manager', dispatcher: 'role_dispatcher',
  lead_cleaner: 'role_lead_cleaner', cleaner: 'role_cleaner', trainee: 'role_trainee',
  laundry_runner: 'role_laundry_runner',
}

export function ProfileScreen({ user, onAvatarUpdate }: { user: any; onAvatarUpdate?: (url: string) => void }) {
  const { lang, setLang, t } = useLang()
  const initials = user.full_name?.split(' ').map((n: string) => n[0]).join('').slice(0,2).toUpperCase() || '?'
  const [avatarUrl, setAvatarUrl] = React.useState(user.avatar_url || null)
  const [uploading, setUploading] = React.useState(false)
  // Self-service contact edit
  const [editingContact, setEditingContact] = useState(false)
  const [contactEmail, setContactEmail] = useState(user.email || '')
  const [contactPhone, setContactPhone] = useState(user.phone || '')
  const [savingContact, setSavingContact] = useState(false)

  // ── Build identity ────────────────────────────────────────────────────────
  // One copyable line answering "which build is this?". Four parts, because any
  // one alone is ambiguous:
  //   version   — what the store installed
  //   channel   — which release track it listens to
  //   update    — WHICH over-the-air bundle is actually running, or "store
  //               build" when running the one baked into the binary. Two phones
  //               on the same store version can be on different updates; this
  //               is the part that resolves that.
  //   date      — when that bundle was published
  // Everything is defensive: in a dev client these constants are null, and this
  // line must never be the reason the profile screen fails to render.
  const buildLine = React.useMemo(() => {
    const parts: string[] = []
    try {
      parts.push(`v${Updates.runtimeVersion ?? '?'}`)
      if (Updates.channel) parts.push(Updates.channel)
      if (Updates.isEmbeddedLaunch || !Updates.updateId) {
        parts.push(t('build_store'))
      } else {
        // Short form: enough to identify an update without a 36-char string on
        // a phone screen. Full id stays selectable via the same text.
        parts.push(`${Updates.updateId.slice(0, 8)}…${Updates.updateId.slice(-4)}`)
      }
      if (Updates.createdAt) {
        parts.push(new Date(Updates.createdAt).toLocaleDateString(localeFor(lang), {
          year: 'numeric', month: 'short', day: 'numeric',
        }))
      }
    } catch {
      // Dev client or a runtime without expo-updates wired up.
      if (parts.length === 0) parts.push(t('build_unavailable'))
    }
    return parts.join(' · ')
  }, [lang, t])

  // ── Time-off requests ─────────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0]
  const TO_TYPES = ['pto', 'sick', 'personal', 'unpaid', 'holiday'] as const
  type TimeOffType = typeof TO_TYPES[number]
  const [toRequests, setToRequests] = useState<any[]>([])
  const [toLoading, setToLoading] = useState(true)
  const [toStart, setToStart] = useState(today)
  const [toEnd, setToEnd] = useState(today)
  const [toType, setToType] = useState<TimeOffType>('pto')
  const [toNote, setToNote] = useState('')
  const [toSubmitting, setToSubmitting] = useState(false)

  React.useEffect(() => { loadTimeOff() }, [])

  async function loadTimeOff() {
    setToLoading(true)
    const { data } = await supabase.from('crew_time_off')
      .select('id, start_date, end_date, type, note, status, created_at')
      .eq('tenant_id', user.tenant_id)
      .eq('user_id', user.id)
      .order('start_date', { ascending: false })
    setToRequests(data || [])
    setToLoading(false)
  }

  const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00').getTime())

  async function submitTimeOff() {
    if (!isValidDate(toStart) || !isValidDate(toEnd)) { Alert.alert(t('error'), t('to_date_format')); return }
    if (toEnd < toStart) { Alert.alert(t('error'), t('to_end_after_start')); return }
    setToSubmitting(true)
    const { error } = await supabase.from('crew_time_off').insert({
      tenant_id: user.tenant_id,
      user_id: user.id,
      start_date: toStart,
      end_date: toEnd,
      type: toType,
      note: toNote.trim() || null,
      status: 'pending',
    })
    setToSubmitting(false)
    if (error) { Alert.alert(t('error'), error.message); return }
    setToNote(''); setToStart(today); setToEnd(today); setToType('pto')
    Alert.alert(t('time_off'), t('request_submitted'))
    loadTimeOff()
  }

  const toTypeLabel = (ty: string) => t(('to_type_' + ty) as any) || ty
  const toStatusStyle = (st: string) =>
    st === 'approved' ? { color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' }
    : st === 'denied' ? { color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' }
    : { color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' }
  const fmtToDate = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString(localeFor(lang), { month: 'short', day: 'numeric', year: 'numeric' })

  async function saveContact() {
    setSavingContact(true)
    const { error } = await supabase.from('users')
      .update({ email: contactEmail.trim() || null, phone: contactPhone.trim() || null })
      .eq('id', user.id)
    setSavingContact(false)
    if (error) { Alert.alert('Error', error.message); return }
    user.email = contactEmail.trim(); user.phone = contactPhone.trim()
    setEditingContact(false)
  }

  async function pickAvatar() {
    Alert.alert(t('profile_photo'), t('choose_photo_source'), [
      { text: t('camera_btn'), onPress: takePhoto },
      { text: t('photo_library'), onPress: pickFromGallery },
      { text: t('cancel'), style: 'cancel' },
    ])
  }

  async function takePhoto() {
    if (await ensureCamera() !== 'granted') return
    try {
      const result = await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [1,1], quality: 0.7 })
      if (result.canceled) return
      uploadAvatar(result.assets[0].uri)
    } catch { /* no crash */ }
  }

  async function pickFromGallery() {
    if (await ensureMediaLibrary() !== 'granted') return
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1,1], quality: 0.7 })
      if (result.canceled) return
      uploadAvatar(result.assets[0].uri)
    } catch { /* no crash */ }
  }

  async function uploadAvatar(uri: string) {
    setUploading(true)
    try {
      const fileName = user.id + '/avatar.jpg'
      const formData = new FormData()
      formData.append('file', { uri, name: fileName, type: 'image/jpeg' } as any)
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch(
        'https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/avatars/' + fileName,
        { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'x-upsert': 'true' }, body: formData }
      )
      if (!res.ok) throw new Error('Upload failed')
      const url = 'https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/public/avatars/' + fileName + '?t=' + Date.now()
      await supabase.from('users').update({ avatar_url: url }).eq('id', user.id)
      setAvatarUrl(url)
      onAvatarUpdate?.(url)
      Alert.alert(`✅ ${t('photo_updated')}`)
    } catch(e: any) {
      Alert.alert('Error', e.message)
    }
    setUploading(false)
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}><Text style={styles.headerTitle}>◉ {t('profile_title')}</Text></View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.avatarSection}>
          <TouchableOpacity onPress={pickAvatar} disabled={uploading}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarPhoto} />
            ) : (
              <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
            )}
            <View style={styles.avatarEditBadge}>
              <Text style={{ fontSize: 10, color: '#fff' }}>{uploading ? '...' : '📷'}</Text>
            </View>
          </TouchableOpacity>
          <Text style={styles.name}>{user.full_name}</Text>
          <View style={styles.roleBadge}><Text style={styles.roleText}>{t((ROLE_KEYS[user.role] || 'role_cleaner') as any)}</Text></View>
        </View>
        <View style={styles.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={styles.sectionTitle}>{t('contact_info')}</Text>
            {!editingContact && (
              <TouchableOpacity onPress={() => { setContactEmail(user.email || ''); setContactPhone(user.phone || ''); setEditingContact(true) }}>
                <Text style={{ color: GOLD, fontSize: 13, fontWeight: '700' }}>{t('edit')}</Text>
              </TouchableOpacity>
            )}
          </View>
          {editingContact ? (
            <>
              <Text style={styles.rowLabel}>{t('email')}</Text>
              <TextInput value={contactEmail} onChangeText={setContactEmail} autoCapitalize="none" keyboardType="email-address"
                style={styles.input} placeholderTextColor="#9E8E72" />
              <Text style={[styles.rowLabel, { marginTop: 10 }]}>{t('phone')}</Text>
              <TextInput value={contactPhone} onChangeText={setContactPhone} keyboardType="phone-pad"
                style={styles.input} placeholderTextColor="#9E8E72" />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <TouchableOpacity style={[styles.contactBtn, { backgroundColor: '#F1F5F9' }]} onPress={() => setEditingContact(false)} disabled={savingContact}>
                  <Text style={{ color: '#475569', fontWeight: '700', fontSize: 13 }}>{t('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.contactBtn, { backgroundColor: GOLD }]} onPress={saveContact} disabled={savingContact}>
                  <Text style={{ color: '#1A1408', fontWeight: '800', fontSize: 13 }}>{savingContact ? t('saving') : t('save')}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            [[t('email'), user.email], [t('phone'), user.phone || t('not_set')]].map(([l, v]) => (
              <View key={l} style={styles.row}>
                <Text style={styles.rowLabel}>{l}</Text>
                <Text style={styles.rowValue}>{v}</Text>
              </View>
            ))
          )}
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t('pay_structure')}</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>{t('pay_type')}</Text>
            <Text style={styles.rowValue}>{user.pay_type === 'hourly' ? t('hourly') : user.pay_type === 'per_job' ? t('per_job') : t('mixed_pay')}</Text>
          </View>
          {user.hourly_rate && <View style={styles.row}><Text style={styles.rowLabel}>{t('hourly_rate')}</Text><Text style={styles.rowValue}>${Number(user.hourly_rate).toFixed(2)}/hr</Text></View>}
          {user.per_job_rate && <View style={styles.row}><Text style={styles.rowLabel}>{t('per_job_rate')}</Text><Text style={styles.rowValue}>${Number(user.per_job_rate).toFixed(2)}/job</Text></View>}
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t('time_off')}</Text>
          <Text style={styles.toHint}>{t('time_off_hint')}</Text>

          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('to_start_date')}</Text>
              <TextInput value={toStart} onChangeText={setToStart} placeholder="YYYY-MM-DD" autoCapitalize="none"
                keyboardType="numbers-and-punctuation" style={styles.input} placeholderTextColor="#9E8E72" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{t('to_end_date')}</Text>
              <TextInput value={toEnd} onChangeText={setToEnd} placeholder="YYYY-MM-DD" autoCapitalize="none"
                keyboardType="numbers-and-punctuation" style={styles.input} placeholderTextColor="#9E8E72" />
            </View>
          </View>

          <Text style={[styles.rowLabel, { marginTop: 12 }]}>{t('to_type')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {TO_TYPES.map(ty => (
              <TouchableOpacity key={ty} onPress={() => setToType(ty)}
                style={[styles.typeChip, toType === ty && styles.typeChipActive]}>
                <Text style={[styles.typeChipText, toType === ty && styles.typeChipTextActive]}>{toTypeLabel(ty)}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={[styles.rowLabel, { marginTop: 12 }]}>{t('to_note')}</Text>
          <TextInput value={toNote} onChangeText={setToNote} placeholder={t('to_note_ph')} multiline
            style={[styles.input, { minHeight: 44 }]} placeholderTextColor="#9E8E72" />

          <TouchableOpacity style={[styles.contactBtn, { backgroundColor: GOLD, marginTop: 12 }]}
            onPress={submitTimeOff} disabled={toSubmitting}>
            <Text style={{ color: '#1A1408', fontWeight: '800', fontSize: 13 }}>
              {toSubmitting ? t('submitting') : t('submit_request')}
            </Text>
          </TouchableOpacity>

          <Text style={[styles.sectionTitle, { marginTop: 20 }]}>{t('my_requests')}</Text>
          {toLoading ? (
            <Text style={styles.toEmpty}>{t('loading')}</Text>
          ) : toRequests.length === 0 ? (
            <Text style={styles.toEmpty}>{t('no_requests_yet')}</Text>
          ) : (
            toRequests.map(r => {
              const s = toStatusStyle(r.status)
              return (
                <View key={r.id} style={styles.toRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.toRowDates}>
                      {fmtToDate(r.start_date)}{r.end_date !== r.start_date ? ` – ${fmtToDate(r.end_date)}` : ''}
                    </Text>
                    <Text style={styles.toRowMeta}>{toTypeLabel(r.type)}{r.note ? ` · ${r.note}` : ''}</Text>
                  </View>
                  <View style={[styles.toBadge, { backgroundColor: s.bg, borderColor: s.border }]}>
                    <Text style={[styles.toBadgeText, { color: s.color }]}>{t(('to_status_' + r.status) as any)}</Text>
                  </View>
                </View>
              )
            })
          )}
        </View>

        <View style={styles.langRow}>
          {([['en', '🇺🇸 English'], ['es', '🇲🇽 Español'], ['pt', '🇧🇷 Português']] as const).map(([code, label]) => (
            <TouchableOpacity key={code} style={[styles.langOpt, lang === code && styles.langOptActive]} onPress={() => setLang(code)}>
              <Text style={[styles.langOptText, lang === code && styles.langOptTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.signOutBtn} onPress={() => Alert.alert(t('sign_out'), t('sign_out_confirm'), [{ text: t('cancel'), style: 'cancel' }, { text: t('sign_out'), style: 'destructive', onPress: () => supabase.auth.signOut() }])}>
          <Text style={styles.signOutText}>{t('sign_out')}</Text>
        </TouchableOpacity>

        {/* Build identity. Asked for by a customer running a controlled
            evaluation: without it there is no way to say WHICH build a test
            result belongs to, and "we tested the app" is not a reportable fact.
            Support needs the same string whenever someone says "it does X" —
            the store version alone can't tell you which OTA they are on.

            selectable rather than a copy button: expo-clipboard is not
            installed, and adding it would make this screen need a native
            rebuild, which defeats the point of shipping it over the air. */}
        <View style={styles.buildBox}>
          <Text style={styles.buildLabel}>{t('build_info')}</Text>
          <Text style={styles.buildText} selectable>{buildLine}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: SLATE_DARK, padding: 20 },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  scroll: { padding: 16, paddingBottom: 100 },
  avatarSection: { alignItems: 'center', marginBottom: 20, marginTop: 8 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarPhoto: { width: 80, height: 80, borderRadius: 40, marginBottom: 12 },
  avatarEditBadge: { position: 'absolute', bottom: 12, right: 0, width: 22, height: 22, borderRadius: 11, backgroundColor: SLATE_DARK, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 28, fontWeight: '800' },
  name: { fontSize: 22, fontWeight: '800', color: '#0F172A', marginBottom: 8 },
  roleBadge: { backgroundColor: '#F1F5F9', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
  roleText: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, borderWidth: 1, borderColor: '#E2E8F0' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F8FAFC' },
  rowLabel: { fontSize: 13, color: '#94A3B8' },
  rowValue: { fontSize: 13, color: '#0F172A', fontWeight: '500' },
  input: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14, color: '#0F172A', backgroundColor: '#fff', marginTop: 4 },
  contactBtn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  langRow: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 8 },
  langOpt: { flex: 1, backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  langOptActive: { backgroundColor: '#1D4ED8', borderColor: '#1D4ED8' },
  langOptText: { color: '#1D4ED8', fontSize: 13, fontWeight: '700' },
  langOptTextActive: { color: '#fff' },
  signOutBtn: { backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FECACA', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  signOutText: { color: '#DC2626', fontSize: 15, fontWeight: '700' },
  buildBox: { marginTop: 20, alignItems: 'center' },
  buildLabel: { color: '#94A3B8', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  buildText: { color: '#64748B', fontSize: 11, textAlign: 'center' },
  toHint: { fontSize: 12, color: '#94A3B8', marginBottom: 12, lineHeight: 17 },
  typeChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#fff' },
  typeChipActive: { backgroundColor: GOLD, borderColor: GOLD },
  typeChipText: { fontSize: 12, color: '#475569', fontWeight: '600' },
  typeChipTextActive: { color: '#1A1408', fontWeight: '800' },
  toEmpty: { fontSize: 13, color: '#94A3B8', paddingVertical: 6 },
  toRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', gap: 10 },
  toRowDates: { fontSize: 13, color: '#0F172A', fontWeight: '700' },
  toRowMeta: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  toBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  toBadgeText: { fontSize: 11, fontWeight: '700' },
})
