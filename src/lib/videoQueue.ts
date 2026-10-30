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
import { supabase, usableAccessToken } from './supabase'
import { uuid4, onBeforeQueuedComplete } from './outbox'
import { reportClientError } from './errorReporter'
import type { UploadErrorKind } from './photoQueue'

const QUEUE_KEY = 'rinsebase.videoQueue.v1'
// The clips the server has been told about. Its own key: a flush pass rewrites
// the queue from the copy it read when it started, which would drop a flag kept there.
const ANNOUNCED_KEY = 'rinsebase.videoQueue.announced.v1'
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
    // The bucket is public, so the name is the only secret: the row's uuid
    // rather than a timestamp plus six random digits. The database requires
    // this <tenant>/<job>/ prefix and the exact public URL of this path.
    storagePath: `${p.tenant_id}/${p.job_id}/walkthrough_${id}.${ext}`,
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
  announceVideos().catch(() => {})
}

// ── Telling the server a clip is on its way ─────────────────────────────────
// A company can require these videos before a clean can complete (lib/
// videosOwed). A 40 MB file on one bar can take hours, and the crew who recorded
// must not wait for it: a row in job_videos_on_the_way, a few hundred bytes,
// counts as the video it will be, for anyone on the clean. Sent when the clip is
// saved and on every pass for any the server hasn't heard of, separately from
// the upload. The landing job_videos row removes it on the server.
//   - No signal: tried again on the next save or pass, and before a queued
//     Complete is sent (it would be refused without this).
//   - A server without the table (the app updated before the migration):
//     not tried again until the app restarts. The videos upload as always.
//   - Refused (the server said no): not tried again for that clip; its upload
//     is unaffected, it just doesn't count until it lands. A clip for a clean
//     you're not on (42501) is expected and not reported; any other is.
let onTheWayUnknown = false
let announcing: Promise<void> | null = null
let announceAgain = false

/** Tell the server about every queued clip it hasn't heard of. Never throws; a
 *  call while one runs makes it go round once more. */
export function announceVideos(): Promise<void> {
  if (onTheWayUnknown) return Promise.resolve()
  if (announcing) { announceAgain = true; return announcing }
  announcing = (async () => {
    do {
      announceAgain = false
      await announceOnce()
    } while (announceAgain && !onTheWayUnknown)
  })().catch(() => {}).finally(() => { announcing = null })
  return announcing
}

type RecordAnswer = 'ok' | 'offline' | 'unknown' | 'refused'

async function sendRecords(rows: Record<string, unknown>[]): Promise<{ answer: RecordAnswer; code?: string; message?: string }> {
  try {
    const { error, status } = await supabase.from('job_videos_on_the_way')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
    if (!error) return { answer: 'ok' }
    if (status === 0) return { answer: 'offline' }
    if (error.code === 'PGRST205' || error.code === '42P01') return { answer: 'unknown' }
    return { answer: 'refused', code: error.code, message: error.message }
  } catch {
    return { answer: 'offline' }
  }
}

async function readAnnounced(): Promise<string[]> {
  try { const raw = await AsyncStorage.getItem(ANNOUNCED_KEY); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}

async function announceOnce(): Promise<void> {
  const told = new Set(await readAnnounced())
  const due = (await readQueue()).filter(v => !told.has(v.id))
  if (!due.length) return
  const row = (v: PendingVideo) => ({
    id: v.id, tenant_id: v.tenant_id, job_id: v.job_id, user_id: v.user_id,
    video_type: v.video_type, duration_seconds: v.duration_seconds, recorded_at: v.recorded_at,
  })
  const first = await sendRecords(due.map(row))
  if (first.answer === 'offline') return
  if (first.answer === 'unknown') { onTheWayUnknown = true; return }
  if (first.answer === 'ok') due.forEach(v => told.add(v.id))
  else {
    // A batch refused whole goes again one row at a time, so one clip for a
    // clean this person isn't on can't sink the rest.
    const refused: string[] = []
    for (const v of due) {
      const one = due.length > 1 ? await sendRecords([row(v)]) : first
      if (one.answer === 'offline') break
      if (one.answer === 'unknown') { onTheWayUnknown = true; break }
      if (one.answer === 'refused' && one.code !== '42501') refused.push(one.message ?? '?')
      told.add(v.id)
    }
    if (refused.length) {
      reportClientError(`videoQueue: the server refused ${refused.length} video record(s): ${refused[0]}`, undefined, 'videoQueue')
    }
  }
  // Only clips still queued: the list can't grow past what's on the phone.
  const queued = new Set((await readQueue()).map(v => v.id))
  try { await AsyncStorage.setItem(ANNOUNCED_KEY, JSON.stringify([...told].filter(id => queued.has(id)))) } catch { /* sent again: harmless */ }
}

// A queued Complete is refused unless the server has heard of its clips first.
onBeforeQueuedComplete(announceVideos)

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
  let token: string | null
  try {
    // Null while the hour-long token has lapsed and can't be renewed (no
    // signal) — same reasoning as photoQueue.
    token = await usableAccessToken()
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
  // Not waited for: a few hundred bytes, never behind a file.
  announceVideos().catch(() => {})
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

/** Jobs with a video still in the queue (lib/cachePrune keeps their offline copy). */
export async function queuedVideoJobIds(): Promise<string[]> {
  return [...new Set((await readQueue()).map(v => v.job_id).filter(Boolean))]
}
