// src/lib/videoQueue.ts
// Offline-resilient uploads for walkthrough videos (the proof-of-condition
// recordings from WalkthroughScreen). Same shape as photoQueue — persist the
// file, queue its metadata, upload now or whenever signal returns — but its
// OWN queue key, directory and lock, on purpose:
//   - photoQueue uploads one entry at a time under a single lock. A 40 MB video
//     on one weak bar can take many minutes, and the after-photos a job needs
//     to complete must never wait behind it.
//   - Two queues sharing one AsyncStorage key would overwrite each other's
//     writes.
// No new native modules: RN streams the file from disk through FormData (never
// supabase-js .upload(blob), which writes 0-byte objects under RN), so this
// ships over the air like the photo queue.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system/legacy'
import { supabase } from './supabase'
import { uuid4 } from './outbox'
import type { UploadErrorKind } from './photoQueue'

const QUEUE_KEY = 'rinsebase.videoQueue.v1'
const DIR = FileSystem.documentDirectory + 'pending_videos/'
const SUPABASE_URL = 'https://cbnbhwclbtowfbjylnph.supabase.co'
const BUCKET = 'job-videos'

// Recording limits, shared with WalkthroughScreen. 720p H.264 at 2.5 Mbps for
// at most 2 minutes is ~38 MB; the byte cap stops a device that ignores the
// bitrate before the bucket's 50 MB limit would reject the upload.
export const WALKTHROUGH_MAX_SECONDS = 120
export const WALKTHROUGH_MAX_BYTES = 45 * 1024 * 1024
export const WALKTHROUGH_BITRATE = 2_500_000

export type WalkthroughType = 'before' | 'after'

export interface PendingVideo {
  // Also the job_videos primary key, so a retry after a lost response hits a
  // duplicate-key error instead of inserting the video twice.
  id: string
  localUri: string
  storagePath: string
  mimeType: string
  tenant_id: string
  job_id: string
  user_id: string
  video_type: WalkthroughType
  duration_seconds: number
  size_bytes: number | null
  recorded_at: string
  created_at: number
  // The file already reached storage; only the row insert is outstanding.
  stored?: boolean
  attempts?: number
  lastErrorKind?: UploadErrorKind
  lastError?: string
  nextAttemptAt?: number
}

async function readQueue(): Promise<PendingVideo[]> {
  try { const raw = await AsyncStorage.getItem(QUEUE_KEY); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}

async function writeQueue(q: PendingVideo[]): Promise<void> {
  try { await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q)) } catch { /* best effort */ }
}

async function ensureDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DIR)
    if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true })
  } catch { /* fall back to the camera's cache uri */ }
}

/** Move a just-recorded video out of the camera cache into durable storage and
 *  queue it. The camera writes to a cache folder the OS may clear, and the
 *  video can wait hours for signal. */
export async function enqueueVideo(p: {
  uri: string; tenant_id: string; job_id: string; user_id: string
  video_type: WalkthroughType; duration_seconds: number; recorded_at: string
}): Promise<void> {
  await ensureDir()
  const id = uuid4()
  // iOS records QuickTime (.mov), Android MPEG-4. Both are H.264 (iOS is asked
  // for avc1 explicitly), and both upload as video/mp4: Chrome and Firefox
  // refuse a video/quicktime response but play H.264 in a .mov container.
  const ext = p.uri.toLowerCase().endsWith('.mov') ? 'mov' : 'mp4'
  const localUri = `${DIR}${id}.${ext}`
  let persisted = p.uri
  try {
    // Move, not copy: a copy would hold two ~40 MB files until upload.
    await FileSystem.moveAsync({ from: p.uri, to: localUri })
    persisted = localUri
  } catch {
    try { await FileSystem.copyAsync({ from: p.uri, to: localUri }); persisted = localUri } catch { /* keep the cache uri */ }
  }
  let size: number | null = null
  try {
    const info: any = await FileSystem.getInfoAsync(persisted)
    if (info?.exists && typeof info.size === 'number') size = info.size
  } catch { /* size is informational */ }

  const entry: PendingVideo = {
    id,
    localUri: persisted,
    storagePath: `${p.tenant_id}/${p.job_id}/walkthrough_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`,
    mimeType: 'video/mp4',
    tenant_id: p.tenant_id,
    job_id: p.job_id,
    user_id: p.user_id,
    video_type: p.video_type,
    duration_seconds: Math.max(0, Math.round(p.duration_seconds)),
    size_bytes: size,
    recorded_at: p.recorded_at,
    created_at: Date.now(),
  }
  const q = await readQueue()
  q.push(entry)
  await writeQueue(q)
}

// A slow-but-alive link must be allowed to finish: budget 20 KB/s (one weak
// bar), never less than the photo queue's 4 minutes, never more than 45.
function timeoutFor(sizeBytes: number | null): number {
  const bytes = sizeBytes ?? WALKTHROUGH_MAX_BYTES
  return Math.min(45 * 60_000, Math.max(240_000, Math.round((bytes / 20_000) * 1000)))
}

type UploadResult = { ok: true } | { ok: false; kind: UploadErrorKind; message: string; stored?: boolean }

async function describeHttpError(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`
  try {
    const body = await res.text()
    if (body) {
      try {
        const j = JSON.parse(body)
        detail = `HTTP ${res.status}: ${j.message || j.error || body.slice(0, 140)}`
      } catch { detail = `HTTP ${res.status}: ${body.slice(0, 140)}` }
    }
  } catch { /* keep status only */ }
  return detail
}

async function uploadOne(entry: PendingVideo): Promise<UploadResult> {
  let token: string | undefined
  try {
    const { data: { session } } = await supabase.auth.getSession()
    token = session?.access_token ?? undefined
  } catch (e: any) {
    return { ok: false, kind: 'network', message: e?.message || 'Could not read session' }
  }
  if (!token) return { ok: false, kind: 'network', message: 'No signed-in session yet' }

  if (!entry.stored) {
    let res: Response
    try {
      const form = new FormData()
      const name = entry.storagePath.split('/').pop() || `${entry.id}.mp4`
      form.append('file', { uri: entry.localUri, name, type: entry.mimeType } as any)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutFor(entry.size_bytes))
      try {
        res = await fetch(
          `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${entry.storagePath}`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-upsert': 'true' }, body: form, signal: ac.signal },
        )
      } finally {
        clearTimeout(timer)
      }
    } catch (e: any) {
      return { ok: false, kind: 'network', message: e?.message || 'Network request failed' }
    }
    if (!res.ok) {
      const message = await describeHttpError(res)
      return { ok: false, kind: res.status < 500 ? 'server' : 'network', message }
    }
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(entry.storagePath)
  try {
    const res: any = await supabase.from('job_videos').insert({
      id: entry.id,
      tenant_id: entry.tenant_id,
      job_id: entry.job_id,
      user_id: entry.user_id,
      video_type: entry.video_type,
      video_url: urlData.publicUrl,
      storage_path: entry.storagePath,
      mime_type: entry.mimeType,
      duration_seconds: entry.duration_seconds,
      size_bytes: entry.size_bytes,
      recorded_at: entry.recorded_at,
      visible_to_client: true,
    })
    // 23505 = this row already landed on an earlier try whose response was lost.
    // postgrest-js reports a fetch-level failure (no signal) as status 0.
    if (res.error && res.error.code !== '23505') {
      return { ok: false, kind: res.status === 0 ? 'network' : 'server', message: res.error.message, stored: true }
    }
  } catch (e: any) {
    return { ok: false, kind: 'network', message: e?.message || 'Network request failed', stored: true }
  }

  try { await FileSystem.deleteAsync(entry.localUri, { idempotent: true }) } catch { /* ignore */ }
  return { ok: true }
}

function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.min(attempts, 6), 3_600_000)
}

let flushing = false

/** Upload every pending video. Safe to call often; overlapping calls no-op.
 *  force skips the server-rejection backoff (the manual retry button). */
export async function flushVideoQueue(opts?: { force?: boolean }): Promise<{ uploaded: number; remaining: number }> {
  if (flushing) return { uploaded: 0, remaining: (await readQueue()).length }
  flushing = true
  try {
    const q = await readQueue()
    if (!q.length) return { uploaded: 0, remaining: 0 }
    let uploaded = 0
    let noSignal = false
    const survivors: PendingVideo[] = []
    for (const entry of q) {
      if (noSignal) { survivors.push(entry); continue }
      if (!opts?.force && entry.nextAttemptAt && Date.now() < entry.nextAttemptAt) {
        survivors.push(entry)
        continue
      }
      const result = await uploadOne(entry)
      if (result.ok) { uploaded++; continue }
      if (result.kind === 'network') noSignal = true
      const attempts = (entry.attempts ?? 0) + 1
      survivors.push({
        ...entry,
        stored: entry.stored || result.stored || undefined,
        attempts,
        lastErrorKind: result.kind,
        lastError: result.message,
        nextAttemptAt: result.kind === 'server' ? Date.now() + backoffMs(attempts) : undefined,
      })
    }
    // A video saved WHILE this pass was uploading is not in `q`. Writing
    // `survivors` alone would erase it and orphan its file, so merge it back
    // from a fresh read.
    const seen = new Set(q.map(e => e.id))
    const next = [...survivors, ...(await readQueue()).filter(e => !seen.has(e.id))]
    await writeQueue(next)
    return { uploaded, remaining: next.length }
  } finally {
    flushing = false
  }
}

export interface QueuedJobVideo {
  id: string
  video_type: WalkthroughType
  duration_seconds: number
  size_bytes: number | null
  created_at: number
  /** The server rejected it (not just no signal). */
  failing: boolean
  lastError: string | null
}

/** This job's videos still on the device, for listing next to uploaded ones. */
export async function queuedJobVideos(jobId: string): Promise<QueuedJobVideo[]> {
  return (await readQueue())
    .filter(v => v.job_id === jobId)
    .map(v => ({
      id: v.id, video_type: v.video_type, duration_seconds: v.duration_seconds, size_bytes: v.size_bytes,
      created_at: v.created_at, failing: v.lastErrorKind === 'server', lastError: v.lastError ?? null,
    }))
}
