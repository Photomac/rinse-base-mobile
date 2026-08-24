// Shared required-photo capture — one code path for evidence shots wherever
// they are taken (today: inside their room on the Turnover checklist). Tags the
// photo with photo_requirement_id (the only link the completion gate accepts)
// and photo_type 'after' so one capture also clears the baseline after-photo
// rule. Extracted from JobPhotosScreen when evidence capture moved into the
// rooms (2026-08-24).
import { Alert } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { ensureCameraCapture } from './permissions'
import { enqueuePhoto, flushQueue } from './photoQueue'

export interface EvidenceReq { id: string; area_name: string }
export interface CaptureCtx { tenantId: string; jobId: string; userId: string }
export interface CaptureResult {
  status: 'captured' | 'cancelled' | 'failed'
  /** Local file uri — valid as an <Image> source immediately, even offline. */
  localUri?: string
  queuedOffline?: boolean
}

export async function captureRequiredPhoto(
  req: EvidenceReq,
  ctx: CaptureCtx,
  t: (k: any) => string,
): Promise<CaptureResult> {
  if (await ensureCameraCapture() !== 'granted') return { status: 'cancelled' }
  try {
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false })
    if (result.canceled) return { status: 'cancelled' }
    const uri = result.assets[0].uri
    try {
      await enqueuePhoto({
        uri,
        tenant_id: ctx.tenantId,
        job_id: ctx.jobId,
        user_id: ctx.userId,
        photo_type: 'after',
        caption: req.area_name,
        photo_requirement_id: req.id,
        visible_to_client: true,
      })
      const flushed = await flushQueue()
      const queuedOffline = flushed.remaining > 0 && flushed.serverRejected === 0
      if (queuedOffline) {
        Alert.alert(`📥 ${t('photo_saved_offline_title')}`, t('photo_saved_offline_msg'))
      }
      return { status: 'captured', localUri: uri, queuedOffline }
    } catch (e: any) {
      Alert.alert(t('upload_failed'), e.message || t('could_not_upload'))
      return { status: 'failed' }
    }
  } catch {
    return { status: 'cancelled' } // permission race / camera unavailable — no crash
  }
}
