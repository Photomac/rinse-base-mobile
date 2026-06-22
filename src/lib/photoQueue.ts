// src/lib/photoQueue.ts
// Offline-resilient job-photo uploads. Crews in poor/no cell coverage capture
// before/after/damage photos that must NOT be lost. On capture we persist the
// file to durable storage + enqueue its metadata; uploads are attempted right
// away and retried opportunistically (on capture, when the Photos screen opens,
// and whenever the app returns to the foreground) until they land. No NetInfo
// dependency, so this ships over-the-air via `eas update`.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system/legacy'
import { supabase } from './supabase'

const QUEUE_KEY = 'rinsebase.photoQueue.v1'
const DIR = FileSystem.documentDirectory + 'pending_photos/'
const SUPABASE_URL = 'https://cbnbhwclbtowfbjylnph.supabase.co'

export interface PendingPhoto {
  id: string
  localUri: string
  fileName: string
  tenant_id: string
  job_id: string
  user_id: string
  photo_type: string
  caption: string | null
  visible_to_client: boolean
  created_at: number
}

async function readQueue(): Promise<PendingPhoto[]> {
  try { const raw = await AsyncStorage.getItem(QUEUE_KEY); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}

async function writeQueue(q: PendingPhoto[]): Promise<void> {
  try { await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q)) } catch { /* best effort */ }
}

async function ensureDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DIR)
    if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true })
  } catch { /* fall back to the original cache uri */ }
}

// Persist the captured photo to durable storage and add it to the pending queue.
// The file is copied out of the (clearable) image-picker cache so it survives an
// app restart while it waits for signal.
export async function enqueuePhoto(p: {
  uri: string; tenant_id: string; job_id: string; user_id: string;
  photo_type: string; caption: string | null; visible_to_client: boolean;
}): Promise<void> {
  await ensureDir()
  const id = `${p.job_id}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const localUri = `${DIR}${id}.jpg`
  let persisted = p.uri
  try {
    await FileSystem.copyAsync({ from: p.uri, to: localUri })
    persisted = localUri
  } catch { /* keep the original uri if the copy fails */ }

  const entry: PendingPhoto = {
    id,
    localUri: persisted,
    fileName: `${p.job_id}/${Date.now()}.jpg`,
    tenant_id: p.tenant_id,
    job_id: p.job_id,
    user_id: p.user_id,
    photo_type: p.photo_type,
    caption: p.caption,
    visible_to_client: p.visible_to_client,
    created_at: Date.now(),
  }
  const q = await readQueue()
  q.push(entry)
  await writeQueue(q)
}

// Upload one entry to storage + record it in job_photos. Returns true on success.
// Storage upload is idempotent (x-upsert on a unique path); the queue entry is
// only dropped after BOTH the upload and the db insert succeed.
async function uploadOne(entry: PendingPhoto): Promise<boolean> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) return false

    const form = new FormData()
    form.append('file', { uri: entry.localUri, name: entry.fileName, type: 'image/jpeg' } as any)

    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/job-photos/${entry.fileName}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-upsert': 'true' }, body: form },
    )
    if (!res.ok) return false

    const { data: urlData } = supabase.storage.from('job-photos').getPublicUrl(entry.fileName)
    const { error } = await supabase.from('job_photos').insert({
      tenant_id: entry.tenant_id,
      job_id: entry.job_id,
      user_id: entry.user_id,
      photo_url: urlData.publicUrl,
      photo_type: entry.photo_type,
      caption: entry.caption,
      visible_to_client: entry.visible_to_client,
    })
    if (error) return false

    try { await FileSystem.deleteAsync(entry.localUri, { idempotent: true }) } catch { /* ignore */ }
    return true
  } catch { return false }
}

let flushing = false

// Attempt to upload every pending photo. Safe to call often; no-ops if already
// running (so the on-capture / on-open / on-foreground triggers don't overlap).
export async function flushQueue(): Promise<{ uploaded: number; remaining: number }> {
  if (flushing) return { uploaded: 0, remaining: (await readQueue()).length }
  flushing = true
  try {
    const q = await readQueue()
    if (!q.length) return { uploaded: 0, remaining: 0 }
    let uploaded = 0
    const survivors: PendingPhoto[] = []
    for (const entry of q) {
      const ok = await uploadOne(entry)
      if (ok) uploaded++
      else survivors.push(entry)
    }
    await writeQueue(survivors)
    return { uploaded, remaining: survivors.length }
  } finally {
    flushing = false
  }
}

export async function pendingCount(): Promise<number> {
  return (await readQueue()).length
}
