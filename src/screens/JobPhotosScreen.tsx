import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Image, Alert, ActivityIndicator, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { supabase } from '../lib/supabase'

import { SLATE_DARK, GOLD } from '../lib/theme'
const TEAL = GOLD
const NAVY = SLATE_DARK

const PHOTO_TYPES = [
  { id: 'before',  label: '📷 Before', color: '#3B82F6' },
  { id: 'after',   label: '✅ After',  color: '#10B981' },
  { id: 'damage',  label: '⚠ Damage', color: '#EF4444' },
  { id: 'general', label: '📸 Other',  color: '#8B5CF6' },
]

interface Props {
  job: any
  user: any
  onBack: () => void
  preselectedItem?: any
}

export function JobPhotosScreen({ job, user, onBack, preselectedItem }: Props) {
  const [photos, setPhotos] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [selectedType, setSelectedType] = useState('after')
  const [caption, setCaption] = useState(preselectedItem?.title || '')
  const [visibleToClient, setVisibleToClient] = useState(true)

  const addr = job.client_addresses as any
  const client = job.clients as any

  useEffect(() => { loadPhotos() }, [])

  async function loadPhotos() {
    setLoading(true)
    const { data } = await supabase
      .from('job_photos')
      .select('*')
      .eq('job_id', job.id)
      .order('created_at', { ascending: false })
    setPhotos(data ?? [])
    setLoading(false)
  }


  async function takePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync()
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow camera access to take photos.')
      return
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.7,
      allowsEditing: false,
    })

    if (result.canceled) return
    await uploadPhoto(result.assets[0].uri)
  }

  async function uploadPhoto(uri: string) {
    setUploading(true)
    try {
      const fileName = `${job.id}/${Date.now()}.jpg`

      // Use FormData for React Native compatibility
      const formData = new FormData()
      formData.append('file', {
        uri,
        name: fileName,
        type: 'image/jpeg',
      } as any)

      // Get session token
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      // Upload directly via fetch with FormData
      const uploadResponse = await fetch(
        `https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/job-photos/${fileName}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'x-upsert': 'true',
          },
          body: formData,
        }
      )

      if (!uploadResponse.ok) {
        const err = await uploadResponse.text()
        throw new Error(err)
      }

      const uploadError = null

      if (uploadError) throw uploadError

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('job-photos')
        .getPublicUrl(fileName)

      // Save to job_photos table
      const { error: dbError } = await supabase.from('job_photos').insert({
        tenant_id: user.tenant_id,
        job_id: job.id,
        user_id: user.id,
        photo_url: urlData.publicUrl,
        photo_type: 'damage' ? 'issue' : selectedType,
        caption: caption.trim() || null,
        visible_to_client: visibleToClient,
      })

      if (dbError) throw dbError

      setCaption('')
      loadPhotos()
      
      if (selectedType === 'damage') {
        Alert.alert(
          '⚠️ Damage photo saved',
          'Would you like to flag this for a damage report to be sent to the property owner?',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Flag for report',
              onPress: async () => {
                await supabase.from('job_photos').update({ 
                  flagged_for_report: true 
                }).eq('job_id', job.id).eq('photo_type', 'issue').is('flagged_for_report', null)
                Alert.alert('✓ Flagged', 'Damage report will be sent to the property owner.')
              }
            }
          ]
        )
      } else {
        Alert.alert('✅ Uploaded', 'Photo saved successfully!')
      }
    } catch (e: any) {
      Alert.alert('Upload failed', e.message || 'Could not upload photo')
    }
    setUploading(false)
  }

  async function deletePhoto(photo: any) {
    Alert.alert('Delete photo?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>📸 Job Photos</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.jobInfo}>
        <Text style={styles.jobName}>{addr?.nickname || client?.full_name}</Text>
        <Text style={styles.jobAddr}>{addr?.street}, {addr?.city}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Photo type selector */}
        <View style={styles.typeRow}>
          {PHOTO_TYPES.map(pt => (
            <TouchableOpacity
              key={pt.id}
              style={[styles.typeBtn, selectedType === pt.id && { backgroundColor: pt.color, borderColor: pt.color }]}
              onPress={() => setSelectedType(pt.id)}
            >
              <Text style={[styles.typeBtnText, selectedType === pt.id && { color: '#fff' }]}>{pt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Caption */}
        <TextInput
          style={styles.captionInput}
          value={caption}
          onChangeText={setCaption}
          placeholder="Add a caption (optional)"
          placeholderTextColor="#9CA3AF"
        />

        {/* Visible to client toggle */}
        <TouchableOpacity style={styles.toggleRow} onPress={() => setVisibleToClient(v => !v)}>
          <Text style={styles.toggleLabel}>Visible to client</Text>
          <View style={[styles.toggle, visibleToClient && styles.toggleOn]}>
            <View style={[styles.toggleThumb, visibleToClient && styles.toggleThumbOn]} />
          </View>
        </TouchableOpacity>

        {/* Upload buttons */}
        <View style={styles.uploadRow}>
          <TouchableOpacity style={styles.cameraBtn} onPress={takePhoto} disabled={uploading}>
            <Text style={styles.cameraBtnText}>📷 Take Photo</Text>
          </TouchableOpacity>
        </View>

        {uploading && (
          <View style={styles.uploadingBar}>
            <ActivityIndicator color={TEAL} size="small" />
            <Text style={styles.uploadingText}>Uploading photo...</Text>
          </View>
        )}

        {/* Photo sections */}
        {loading ? (
          <ActivityIndicator color={TEAL} style={{ marginTop: 40 }} />
        ) : photos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📸</Text>
            <Text style={styles.emptyTitle}>No photos yet</Text>
            <Text style={styles.emptyText}>Take before & after photos for this job</Text>
          </View>
        ) : (
          <>
            {[
              { label: '📷 Before', photos: beforePhotos, color: '#3B82F6' },
              { label: '✅ After',  photos: afterPhotos,  color: '#10B981' },
              { label: '⚠ Damage', photos: damagePhotos,  color: '#EF4444' },
              { label: '📸 Other', photos: generalPhotos, color: '#8B5CF6' },
            ].filter(s => s.photos.length > 0).map(section => (
              <View key={section.label} style={styles.section}>
                <Text style={[styles.sectionTitle, { color: section.color }]}>
                  {section.label} ({section.photos.length})
                </Text>
                <View style={styles.photoGrid}>
                  {section.photos.map(photo => (
                    <TouchableOpacity
                      key={photo.id}
                      style={styles.photoWrapper}
                      onLongPress={() => deletePhoto(photo)}
                    >
                      <Image source={{ uri: photo.photo_url }} style={styles.photo} />
                      {photo.caption && (
                        <Text style={styles.photoCaption} numberOfLines={1}>{photo.caption}</Text>
                      )}
                      {photo.visible_to_client && (
                        <View style={styles.clientBadge}>
                          <Text style={styles.clientBadgeText}>Client</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}
          </>
        )}

        <Text style={styles.hint}>Long press a photo to delete it</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  backBtn: { padding: 4 },
  backText: { color: TEAL, fontSize: 14, fontWeight: '600' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  jobInfo: { backgroundColor: NAVY, paddingHorizontal: 16, paddingBottom: 14 },
  jobName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  jobAddr: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 },
  scroll: { padding: 16, paddingBottom: 40 },
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
