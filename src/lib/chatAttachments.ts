// Image attachments for messaging (team chat + per-job messages).
// One image per message, uploaded to the public job-photos bucket; the
// message row carries attachment_url/attachment_type ('image').
import { Alert } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { supabase } from './supabase'
import { ensureCamera, ensureMediaLibrary } from './permissions'

export type AttachmentSource = 'camera' | 'library'

// Ask camera vs library via a native alert; resolves null on cancel/dismiss.
export function chooseAttachmentSource(labels: { title: string; camera: string; library: string; cancel: string }): Promise<AttachmentSource | null> {
  return new Promise(resolve => {
    Alert.alert(labels.title, undefined, [
      { text: labels.camera, onPress: () => resolve('camera') },
      { text: labels.library, onPress: () => resolve('library') },
      { text: labels.cancel, style: 'cancel', onPress: () => resolve(null) },
    ], { cancelable: true, onDismiss: () => resolve(null) })
  })
}

// Pick an image and upload it. Returns the public URL, or null when the user
// cancelled / denied permission. Throws on upload failure so callers can
// surface the error. ImagePicker MUST be gated on the ensure* helpers.
export async function pickAndUploadImage(source: AttachmentSource, tenantId: string, folder: string): Promise<string | null> {
  const perm = source === 'camera' ? await ensureCamera() : await ensureMediaLibrary()
  if (perm !== 'granted') return null
  const opts = { mediaTypes: 'images' as const, quality: 0.7 }
  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync(opts)
    : await ImagePicker.launchImageLibraryAsync(opts)
  if (result.canceled || !result.assets?.[0]) return null
  const asset = result.assets[0]
  const extRaw = (asset.uri.split('.').pop() || 'jpg').toLowerCase()
  const ext = extRaw.length > 4 ? 'jpg' : extRaw
  const path = `${tenantId}/${folder}/${Date.now()}.${ext}`
  const response = await fetch(asset.uri)
  const blob = await response.blob()
  const { error } = await supabase.storage.from('job-photos').upload(path, blob, {
    contentType: asset.mimeType || (ext === 'jpg' ? 'image/jpeg' : `image/${ext}`),
    upsert: true,
  })
  if (error) throw error
  return supabase.storage.from('job-photos').getPublicUrl(path).data.publicUrl
}
