import React, { useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import * as ImagePicker from 'expo-image-picker'
import { Image } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { SLATE_DARK, GOLD } from '../lib/theme'

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner', manager: 'Manager', dispatcher: 'Dispatcher',
  lead_cleaner: 'Lead Cleaner', cleaner: 'Cleaner', trainee: 'Trainee',
}

export function ProfileScreen({ user, onAvatarUpdate }: { user: any; onAvatarUpdate?: (url: string) => void }) {
  const { lang, toggleLanguage } = useLang()
  const initials = user.full_name?.split(' ').map((n: string) => n[0]).join('').slice(0,2).toUpperCase() || '?'
  const [avatarUrl, setAvatarUrl] = React.useState(user.avatar_url || null)
  const [uploading, setUploading] = React.useState(false)

  async function pickAvatar() {
    Alert.alert('Profile Photo', 'Choose a photo source', [
      { text: 'Camera', onPress: takePhoto },
      { text: 'Photo Library', onPress: pickFromGallery },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  async function takePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync()
    if (status !== 'granted') { Alert.alert('Permission needed', 'Allow camera access'); return }
    const result = await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [1,1], quality: 0.7 })
    if (result.canceled) return
    uploadAvatar(result.assets[0].uri)
  }

  async function pickFromGallery() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (status !== 'granted') { Alert.alert('Permission needed', 'Allow photo access'); return }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1,1], quality: 0.7 })
    if (result.canceled) return
    uploadAvatar(result.assets[0].uri)
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
      Alert.alert('✅ Photo updated!')
    } catch(e: any) {
      Alert.alert('Error', e.message)
    }
    setUploading(false)
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}><Text style={styles.headerTitle}>◉ Profile</Text></View>
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
          <View style={styles.roleBadge}><Text style={styles.roleText}>{ROLE_LABELS[user.role] || user.role}</Text></View>
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Contact info</Text>
          {[['Email', user.email], ['Phone', user.phone || 'Not set']].map(([l, v]) => (
            <View key={l} style={styles.row}>
              <Text style={styles.rowLabel}>{l}</Text>
              <Text style={styles.rowValue}>{v}</Text>
            </View>
          ))}
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Pay structure</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Pay type</Text>
            <Text style={styles.rowValue}>{user.pay_type === 'hourly' ? 'Hourly' : user.pay_type === 'per_job' ? 'Per job' : 'Hourly + turnover'}</Text>
          </View>
          {user.hourly_rate && <View style={styles.row}><Text style={styles.rowLabel}>Hourly rate</Text><Text style={styles.rowValue}>${Number(user.hourly_rate).toFixed(2)}/hr</Text></View>}
          {user.per_job_rate && <View style={styles.row}><Text style={styles.rowLabel}>Per job rate</Text><Text style={styles.rowValue}>${Number(user.per_job_rate).toFixed(2)}/job</Text></View>}
        </View>
        <TouchableOpacity style={styles.langBtn} onPress={toggleLanguage}>
          <Text style={styles.langBtnText}>{lang === 'en' ? '🇲🇽 Cambiar a Español' : '🇺🇸 Switch to English'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.signOutBtn} onPress={() => Alert.alert('Sign out', 'Are you sure?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => supabase.auth.signOut() }])}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
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
  langBtn: { backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8, marginBottom: 8 },
  langBtnText: { color: '#1D4ED8', fontSize: 15, fontWeight: '700' },
  signOutBtn: { backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FECACA', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  signOutText: { color: '#DC2626', fontSize: 15, fontWeight: '700' },
})
