// src/lib/videoQueue.ts
// Offline-resilient uploads for walkthrough videos (the proof-of-condition
// recordings from WalkthroughScreen) and for line clips (a checklist line that
// asks for a video, lib/lineVideos: video_type 'line' with the line's id), and
// for incident reports (video_type 'report' with the report's id: the row goes
// to incident_report_videos, rinse-base-app 20261112180000; CKS 2026-11-12). Same
// shape as photoQueue — persist the
// file, queue its metadata, upload now or whenever signal returns — but its
// OWN queue key, directory and lock, on purpose:
//   - photoQueue uploads one entry at a time under a single lock. A 40 MB video
//     on one weak bar can take many minutes, and the after-photos a job needs
//     to complete must never wait behind it.
//   - Two queues sharing one AsyncStorage key would overwrite each other's
//     writes.
// No new native modules: a clip up to 6 MB goes as one request, RN streaming
// the file from disk through FormData (never supabase-js .upload(blob), which
// writes 0-byte objects under RN). A bigger clip goes up resumably, in 6 MB
// pieces (lib/tusUpload, CKS 2026-11-16): expo-file-system/legacy reads each
// piece and sends it with its own uploader (on iPhone a background session, so
// a piece keeps going with the screen locked). Both are in every store build
// (1.1.5, 1.1.6, 1.1.7: expo-file-system 19.0.21), so this ships over the air.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system/legacy'
import { supabase, usableAccessToken } from './supabase'
import { uuid4, onBeforeQueuedComplete } from './outbox'
import { reportClientError } from './errorReporter'
import type { UploadErrorKind } from './photoQueue'
import { tusUpload, TUS_CHUNK, type TusState, type HttpAnswer, type ChunkSend } from './tusUpload'
import { videoBusy } from './videoBusy'

const QUEUE_KEY = 'rinsebase.videoQueue.v1'
// The clips the server has been told about. Its own key: a flush pass rewrites
// the queue from the copy it read when it started, which would drop a flag kept there.
const ANNOUNCED_KEY = 'rinsebase.videoQueue.announced.v1'
const DIR = FileSystem.documentDirectory + 'pending_videos/'
const SUPABASE_URL = 'https://cbnbhwclbtowfbjylnph.supabase.co'
const BUCKET = 'job-videos'
// A big clip's resumable upload, by clip id: its address on the server, and
// how far it got (lib/tusUpload). Its own key, like ANNOUNCED_KEY: a pass
// rewrites the queue from the copy it read when it started.
const TUS_KEY = 'rinsebase.videoQueue.tus.v1'
const TUS_ENDPOINT = `${SUPABASE_URL}/storage/v1/upload/resumable`

// Recording limits, shared with WalkthroughScreen. 720p H.264 at 2.5 Mbps for
// at most 2 minutes is ~38 MB; the byte cap stops a device that ignores the
// bitrate before the bucket's 50 MB limit would reject the upload.
export const WALKTHROUGH_MAX_SECONDS = 120
export const WALKTHROUGH_MAX_BYTES = 45 * 1024 * 1024
export const WALKTHROUGH_BITRATE = 2_500_000

export type WalkthroughType = 'before' | 'after'
/** A walkthrough video, a clip recorded for one checklist line (lib/lineVideos),
 *  or a video on an incident report. */
export type VideoType = WalkthroughType | 'line' | 'report'

/** An incident report's video runs at most a minute (the recorder stops it). */
export const REPORT_CLIP_MAX_SECONDS = 60
/** How many passes a report clip waits for its report to reach the server (it
 *  may still be in the outbox) before it counts as refused. */
const REPORT_WAIT_PASSES = 30

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
  video_type: VideoType
  duration_seconds: number
  size_bytes: number | null
  recorded_at: string
  created_at: number
  /** A line clip: the job_checklist_items row it was recorded for. */
  checklist_item_id?: string | null
  /** A line clip: the line's room and wording (the server writes its own from the line;
   *  this one stays when the line was deleted while the clip waited). */
  caption?: string | null
  /** The server refused the line (deleted while the clip waited for signal): the clip
   *  goes on without it, still a line clip with its caption. */
  lineDropped?: boolean
  /** A report clip: the job_damage_reports row it belongs to. */
  incident_report_id?: string | null
  /** A report clip: passes it has waited for its report to land. */
  reportWaits?: number
  // The file already reached storage; only the row insert is outstanding.
  stored?: boolean
  attempts?: number
  lastErrorKind?: UploadErrorKind
  lastError?: string
  nextAttemptAt?: number
  // Uploads that failed while the server was answering: this clip's own trouble,
  // not the signal's.
  failures?: number
  // The reason has gone to the error log, once per clip.
  reportedStuck?: boolean
  // The file isn't on the phone. Kept, not dropped: it's evidence, the server's
  // record still says it exists, and the office should hear about it.
  fileGone?: boolean
}

// iOS can move the app's data folder when the app is updated, so the absolute
// path stored with an older clip may no longer exist although the file does.
// Same as photoQueue: resolve every queued file against today's folder.
function resolveLocal(uri: string): string {
  const marker = '/pending_videos/'
  const i = uri.indexOf(marker)
  return i >= 0 ? DIR + uri.slice(i + marker.length) : uri
}

// True only when the file is known to be gone. React Native fails an upload of
// a missing file as "Network request failed", the same as no signal.
async function fileMissing(uri: string): Promise<boolean> {
  if (!uri.startsWith('file://')) return false
  try { return !(await FileSystem.getInfoAsync(uri)).exists } catch { return false }
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
  video_type: VideoType; duration_seconds: number; recorded_at: string
  /** A line clip's line and caption (lib/lineVideos). */
  checklist_item_id?: string | null; caption?: string | null
  /** A report clip's report (its row goes to incident_report_videos). */
  incident_report_id?: string | null
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
    storagePath: `${p.tenant_id}/${p.job_id}/${p.video_type === 'line' ? 'line' : p.video_type === 'report' ? 'report' : 'walkthrough'}_${id}.${ext}`,
    mimeType: 'video/mp4',
    tenant_id: p.tenant_id,
    job_id: p.job_id,
    user_id: p.user_id,
    video_type: p.video_type,
    duration_seconds: Math.max(0, Math.round(p.duration_seconds)),
    size_bytes: size,
    recorded_at: p.recorded_at,
    created_at: Date.now(),
    ...(p.video_type === 'line' ? { checklist_item_id: p.checklist_item_id ?? null, caption: p.caption ?? null } : {}),
    ...(p.video_type === 'report' ? { incident_report_id: p.incident_report_id ?? null } : {}),
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
  // A report's video is no walkthrough: it never counts toward the videos a
  // company requires, so the server isn't told it's on its way.
  const due = (await readQueue()).filter(v => !told.has(v.id) && v.video_type !== 'report')
  if (!due.length) return
  // A line clip names its line, which is what lets it count for that line. A
  // walkthrough record is sent exactly as before (no checklist_item_id key: a
  // server without the column would refuse it).
  const row = (v: PendingVideo, withLine = true) => ({
    id: v.id, tenant_id: v.tenant_id, job_id: v.job_id, user_id: v.user_id,
    video_type: v.video_type, duration_seconds: v.duration_seconds, recorded_at: v.recorded_at,
    ...(withLine && lineOf(v) ? { checklist_item_id: lineOf(v) } : {}),
  })
  const first = await sendRecords(due.map(v => row(v)))
  if (first.answer === 'offline') return
  if (first.answer === 'unknown') { onTheWayUnknown = true; return }
  if (first.answer === 'ok') due.forEach(v => told.add(v.id))
  else {
    // A batch refused whole goes again one row at a time, so one clip for a
    // clean this person isn't on can't sink the rest.
    const refused: string[] = []
    for (const v of due) {
      let one = due.length > 1 ? await sendRecords([row(v)]) : first
      // The line is gone (deleted while the clip waited): the record goes on
      // without it. It answers no line now, but the office still sees the clip.
      if (one.answer === 'refused' && one.code === '23503' && lineOf(v)) one = await sendRecords([row(v, false)])
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

/** The line a clip still names (none once the server refused it). */
function lineOf(v: PendingVideo): string | null {
  return v.video_type === 'line' && !v.lineDropped ? v.checklist_item_id ?? null : null
}

// A queued Complete is refused unless the server has heard of its clips first.
onBeforeQueuedComplete(announceVideos)

// A slow-but-alive link must be allowed to finish: budget 20 KB/s (one weak
// bar), never less than the photo queue's 4 minutes, never more than 45.
// Only a clip up to 6 MB (one request); a bigger one goes in pieces with no
// total limit (lib/tusUpload).
function timeoutFor(sizeBytes: number | null): number {
  const bytes = sizeBytes ?? WALKTHROUGH_MAX_BYTES
  return Math.min(45 * 60_000, Math.max(240_000, Math.round((bytes / 20_000) * 1000)))
}

type UploadResult = { ok: true } | { ok: false; kind: UploadErrorKind; message: string; stored?: boolean; noToken?: boolean; lineDropped?: boolean; waiting?: boolean; progressed?: boolean; sent?: number; trace?: string[] }

// ── Big clips: the resumable upload's state and the phone's side of it ─────
async function readTusAll(): Promise<Record<string, TusState>> {
  try { const raw = await AsyncStorage.getItem(TUS_KEY); return raw ? JSON.parse(raw) : {} }
  catch { return {} }
}
async function writeTus(id: string, st: TusState | null): Promise<void> {
  try {
    const all = await readTusAll()
    if (st) all[id] = st
    else delete all[id]
    await AsyncStorage.setItem(TUS_KEY, JSON.stringify(all))
  } catch { /* the server's offset is the truth; a lost copy only costs a new upload */ }
}

// What the crew see for a clip going up now: bytes on the server, and whether
// it is waiting for other work to send first.
const live = new Map<string, { sent: number; total: number; paused: boolean }>()

function answerFrom(status: number, headers: Record<string, string> | Headers | null | undefined, body?: string): HttpAnswer {
  return {
    status,
    body,
    header(name: string) {
      if (!headers) return null
      if (typeof (headers as any).get === 'function') return (headers as Headers).get(name)
      const want = name.toLowerCase()
      for (const [k, v] of Object.entries(headers as Record<string, string>)) if (k.toLowerCase() === want) return String(v)
      return null
    },
  }
}

/** A small request with its own short limit. Throws when nothing came back. */
async function smallRequest(method: string, url: string, headers: Record<string, string>): Promise<HttpAnswer> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20_000)
  try {
    const res = await fetch(url, { method, headers, signal: ac.signal })
    let body: string | undefined
    if (method !== 'HEAD' && !res.ok) { try { body = await res.text() } catch { /* status only */ } }
    return answerFrom(res.status, res.headers, body)
  } finally {
    clearTimeout(timer)
  }
}

/** Read one piece of the clip into its own file and send it as a PATCH. */
async function sendPiece(entry: PendingVideo, url: string, offset: number, length: number, headers: Record<string, string>, onProgress: (sent: number) => void): Promise<ChunkSend> {
  const piece = `${DIR}piece_${entry.id}.bin`
  const b64 = await FileSystem.readAsStringAsync(resolveLocal(entry.localUri), { encoding: FileSystem.EncodingType.Base64, position: offset, length })
  await FileSystem.writeAsStringAsync(piece, b64, { encoding: FileSystem.EncodingType.Base64 })
  const task = FileSystem.createUploadTask(url, piece, {
    httpMethod: 'PATCH',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    // iPhone: keeps going with the screen locked. Android: always in-process.
    sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
    headers,
  }, (p: any) => onProgress(Number(p?.totalBytesSent) || 0))
  const done = task.uploadAsync()
    .then((r: any) => (r ? answerFrom(r.status, r.headers, r.body) : null))
    .finally(() => { FileSystem.deleteAsync(piece, { idempotent: true }).catch(() => {}) })
  return { done, cancel: () => { task.cancelAsync().catch(() => {}) } }
}

/** The stored object's size, or null when it isn't there. One byte asked for. */
async function storedSize(entry: PendingVideo, token: string): Promise<number | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20_000)
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${entry.storagePath}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-0' }, signal: ac.signal,
    })
    if (res.status === 206) {
      const total = Number((res.headers.get('content-range') || '').split('/')[1])
      return Number.isFinite(total) ? total : null
    }
    if (res.status === 200) {
      const n = Number(res.headers.get('content-length'))
      return Number.isFinite(n) ? n : null
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function uploadBig(entry: PendingVideo, size: number) {
  return tusUpload(
    { path: entry.storagePath, bucket: BUCKET, size, mime: entry.mimeType, upsert: entry.video_type !== 'report' },
    {
      endpoint: TUS_ENDPOINT,
      token: async () => { try { return await usableAccessToken() } catch { return null } },
      request: (method, url, headers) => smallRequest(method, url, headers),
      sendChunk: (url, offset, length, headers, onProgress) => sendPiece(entry, url, offset, length, headers, onProgress),
      objectSize: async () => { const t = await usableAccessToken().catch(() => null); return t ? storedSize(entry, t) : null },
      loadState: async () => (await readTusAll())[entry.id] ?? null,
      saveState: (st) => writeTus(entry.id, st),
      busy: () => videoBusy(),
      now: () => Date.now(),
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      progress: (sent, total, paused) => { live.set(entry.id, { sent, total, paused }) },
    },
  )
}

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
    return { ok: false, kind: 'network', message: e?.message || 'Could not read session', noToken: true }
  }
  if (!token) return { ok: false, kind: 'network', message: 'No signed-in session yet', noToken: true }

  // A clip over one piece goes up resumably (lib/tusUpload). Its size from
  // the file when the queue doesn't know it.
  let size = entry.size_bytes
  if (!entry.stored && size == null) {
    try { const info: any = await FileSystem.getInfoAsync(resolveLocal(entry.localUri)); if (info?.exists && typeof info.size === 'number') size = info.size } catch { /* the old way */ }
  }
  let storedBig = false
  if (!entry.stored && size != null && size > TUS_CHUNK) {
    const r = await uploadBig(entry, size)
    if (r.ok) storedBig = true
    else if (!r.unsupported) {
      return { ok: false, kind: r.kind, message: r.message, noToken: r.noToken, progressed: r.progressed, sent: r.sent, trace: r.trace }
    }
    // No resumable uploads on this server: the one request below, as before.
  }

  if (!entry.stored && !storedBig) {
    let res: Response
    try {
      const form = new FormData()
      const name = entry.storagePath.split('/').pop() || `${entry.id}.mp4`
      form.append('file', { uri: resolveLocal(entry.localUri), name, type: entry.mimeType } as any)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutFor(entry.size_bytes))
      try {
        // A report's file is never overwritten, not even by its uploader
        // (rinse-base-app 20261112180000 keeps report_* out of the overwrite
        // rule): its retry asks for no overwrite, and "already there" below
        // means an earlier try landed. A walkthrough or line clip retries over
        // its own file as before.
        res = await fetch(
          `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${entry.storagePath}`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-upsert': entry.video_type === 'report' ? 'false' : 'true' }, body: form, signal: ac.signal },
        )
      } finally {
        clearTimeout(timer)
      }
    } catch (e: any) {
      return { ok: false, kind: 'network', message: e?.message || 'Network request failed' }
    }
    if (!res.ok) {
      const message = await describeHttpError(res)
      // Storage answers a name that exists with 409, or with 400 naming it
      // ("Duplicate", "The resource already exists"): this report clip's file
      // landed on a try whose answer was lost.
      const alreadyThere = entry.video_type === 'report' && (res.status === 409 || /Duplicate|already exists/i.test(message))
      if (!alreadyThere) return { ok: false, kind: res.status < 500 ? 'server' : 'network', message }
    }
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(entry.storagePath)
  if (entry.video_type === 'report') {
    // The report's row (incident_report_videos): its id is this entry's, so a
    // retry after a lost answer is a duplicate key (23505), taken as landed.
    // 23503: the report isn't on the server yet (still in the outbox), so the
    // clip waits for it rather than failing.
    try {
      const res: any = await supabase.from('incident_report_videos').insert({
        id: entry.id, tenant_id: entry.tenant_id, report_id: entry.incident_report_id, job_id: entry.job_id, user_id: entry.user_id,
        storage_path: entry.storagePath, video_url: urlData.publicUrl, mime_type: entry.mimeType,
        duration_seconds: entry.duration_seconds, size_bytes: entry.size_bytes, recorded_at: entry.recorded_at,
      })
      if (res.error && res.error.code !== '23505') {
        if (res.status === 0) return { ok: false, kind: 'network', message: res.error.message, stored: true }
        if (res.error.code === '23503' && (entry.reportWaits ?? 0) < REPORT_WAIT_PASSES) {
          return { ok: false, kind: 'network', message: res.error.message, stored: true, waiting: true }
        }
        return { ok: false, kind: 'server', message: res.error.message, stored: true }
      }
    } catch (e: any) {
      return { ok: false, kind: 'network', message: e?.message || 'Network request failed', stored: true }
    }
    try { await FileSystem.deleteAsync(resolveLocal(entry.localUri), { idempotent: true }) } catch { /* ignore */ }
    return { ok: true }
  }
  let lineDropped = false
  const rowFor = (withLine: boolean) => ({
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
    // A line clip: its line (while the server takes it) and its caption. A
    // walkthrough row is sent exactly as before.
    ...(entry.video_type === 'line' ? { caption: entry.caption ?? null } : {}),
    ...(withLine && lineOf(entry) ? { checklist_item_id: lineOf(entry) } : {}),
  })
  try {
    let res: any = await supabase.from('job_videos').insert(rowFor(true))
    // 23503: the line is gone (deleted while the clip waited for signal). The clip
    // is still evidence: it lands without the line, as a line clip with its caption.
    if (res.error && res.error.code === '23503' && lineOf(entry)) {
      lineDropped = true
      res = await supabase.from('job_videos').insert(rowFor(false))
    }
    // 23505 = this row already landed on an earlier try whose response was lost.
    // postgrest-js reports a fetch-level failure (no signal) as status 0.
    if (res.error && res.error.code !== '23505') {
      return { ok: false, kind: res.status === 0 ? 'network' : 'server', message: res.error.message, stored: true, lineDropped }
    }
  } catch (e: any) {
    return { ok: false, kind: 'network', message: e?.message || 'Network request failed', stored: true, lineDropped }
  }

  try { await FileSystem.deleteAsync(resolveLocal(entry.localUri), { idempotent: true }) } catch { /* ignore */ }
  return { ok: true }
}

function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.min(attempts, 6), 3_600_000)
}

/** Does the server answer at all? Any answer counts; a small request with its own short limit. */
async function serverAnswers(): Promise<boolean> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 8_000)
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/health`, { signal: ac.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** After this many failed uploads with the server answering, the crew are told and it waits between tries. */
const STUCK_AFTER = 3

let flushing = false

/** Upload every pending video. Safe to call often; overlapping calls no-op.
 *  force skips the server-rejection backoff (the manual retry button). */
export async function flushVideoQueue(opts?: { force?: boolean }): Promise<{ uploaded: number; remaining: number }> {
  // Not waited for: a few hundred bytes, never behind a file.
  announceVideos().catch(() => {})
  if (flushing) return { uploaded: 0, remaining: (await readQueue()).length }
  flushing = true
  try {
    // A clip that keeps failing goes after the ones that haven't. One sat at the
    // head of a phone's queue for a week and nothing behind it ever went, down to
    // 6-second clips (CKS, Anya, 2026-10-23 to 10-30), shown as "Waiting to upload".
    const q = (await readQueue()).slice()
      .sort((a, b) => (a.failures ?? 0) - (b.failures ?? 0) || a.created_at - b.created_at)
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
      if (!entry.stored && await fileMissing(resolveLocal(entry.localUri))) {
        if (!entry.fileGone) {
          reportClientError(`videoQueue: clip ${entry.id} isn't on the phone (job ${entry.job_id}, ${entry.video_type}, ${entry.duration_seconds}s)`, undefined, 'videoQueue')
        }
        survivors.push({ ...entry, fileGone: true })
        continue
      }
      const result = await uploadOne(entry)
      if (result.ok) { uploaded++; continue }
      // A report clip whose report hasn't landed yet: not this clip's trouble
      // and not the signal's; it goes again on the next pass.
      if (result.waiting) {
        survivors.push({ ...entry, stored: true, reportWaits: (entry.reportWaits ?? 0) + 1, lastErrorKind: undefined, lastError: result.message, nextAttemptAt: undefined })
        continue
      }
      // No signal stops the pass: the rest would fail the same way. The server
      // answering means this clip is the trouble, so the next one gets its turn.
      // A big clip that got further this pass is moving, just slowly: it starts
      // its count again, and isn't reported as stuck.
      const progressed = !!result.progressed
      const clipFailed = result.kind === 'network' && !result.noToken && !progressed && await serverAnswers()
      if (result.kind === 'network' && !clipFailed) noSignal = true
      const attempts = progressed ? 0 : (entry.attempts ?? 0) + 1
      const failures = progressed ? 0 : (entry.failures ?? 0) + (clipFailed ? 1 : 0)
      const reportNow = clipFailed && attempts >= STUCK_AFTER && !entry.reportedStuck
      if (reportNow) {
        const mb = entry.size_bytes ? `${(entry.size_bytes / 1_048_576).toFixed(1)} MB` : 'size unknown'
        // A big clip says how far it got and what happened on the phone: the
        // server never sees an upload that didn't finish.
        const sent = result.sent != null && entry.size_bytes ? ` | ${(result.sent / 1_048_576).toFixed(1)} MB on the server` : ''
        const trace = result.trace?.length ? ` | ${result.trace.join(' ; ')}` : ''
        reportClientError(`videoQueue: clip ${entry.id} keeps failing (${attempts} tries, ${mb}, file present): ${result.message}${sent}${trace}`.slice(0, 1500), undefined, 'videoQueue', { keepKnownNoise: true })
      }
      survivors.push({
        ...entry,
        stored: entry.stored || result.stored || undefined,
        lineDropped: entry.lineDropped || result.lineDropped || undefined,
        attempts,
        failures: failures || undefined,
        reportedStuck: entry.reportedStuck || reportNow || undefined,
        fileGone: undefined,
        lastErrorKind: result.kind,
        lastError: result.message,
        nextAttemptAt: result.kind === 'server' || (clipFailed && failures >= STUCK_AFTER) ? Date.now() + backoffMs(Math.max(attempts, failures)) : undefined,
      })
    }
    // A video saved WHILE this pass was uploading is not in `q`. Writing
    // `survivors` alone would erase it and orphan its file, so merge it back
    // from a fresh read.
    const seen = new Set(q.map(e => e.id))
    const next = [...survivors, ...(await readQueue()).filter(e => !seen.has(e.id))]
    await writeQueue(next)
    // A landed clip's upload state goes with it, and its progress line.
    const queued = new Set(next.map(e => e.id))
    const tus = await readTusAll()
    if (Object.keys(tus).some(id => !queued.has(id))) {
      for (const id of Object.keys(tus)) if (!queued.has(id)) delete tus[id]
      try { await AsyncStorage.setItem(TUS_KEY, JSON.stringify(tus)) } catch { /* next pass */ }
    }
    // A piece file left by an app killed mid-piece, for a clip that has landed.
    for (const e of q) {
      if (!queued.has(e.id) && e.size_bytes != null && e.size_bytes > TUS_CHUNK) {
        FileSystem.deleteAsync(`${DIR}piece_${e.id}.bin`, { idempotent: true }).catch(() => {})
      }
    }
    for (const id of [...live.keys()]) if (!queued.has(id)) live.delete(id)
    return { uploaded, remaining: next.length }
  } finally {
    flushing = false
  }
}

export interface QueuedJobVideo {
  id: string
  video_type: VideoType
  /** A line clip: the line it was recorded for (null once the server refused the line). */
  checklist_item_id: string | null
  duration_seconds: number
  size_bytes: number | null
  created_at: number
  /** The server rejected it (not just no signal). */
  failing: boolean
  /** Its uploads keep failing while the server answers. */
  stuck: boolean
  /** The file isn't on this phone. */
  fileGone: boolean
  lastError: string | null
  /** A big clip: bytes the server has (null: not started, or one request). */
  sent_bytes: number | null
  /** Going up now but waiting for other work (clock-out, Complete, photos) to send first. */
  paused: boolean
}

/** This job's videos still on the device, for listing next to uploaded ones.
 *  Not a report's video: it is no walkthrough or line clip, and never counts
 *  as one (pendingReportVideos has those). */
export async function queuedJobVideos(jobId: string): Promise<QueuedJobVideo[]> {
  const tus = await readTusAll()
  return (await readQueue())
    .filter(v => v.job_id === jobId && v.video_type !== 'report')
    .map(v => {
      const now = live.get(v.id)
      const sent = now?.sent ?? tus[v.id]?.offset ?? null
      return {
        id: v.id, video_type: v.video_type, checklist_item_id: lineOf(v), duration_seconds: v.duration_seconds, size_bytes: v.size_bytes,
        created_at: v.created_at, failing: v.lastErrorKind === 'server', stuck: (v.failures ?? 0) >= STUCK_AFTER, fileGone: !!v.fileGone, lastError: v.lastError ?? null,
        sent_bytes: v.stored ? v.size_bytes : sent,
        paused: !!now?.paused && flushing,
      }
    })
}

/** How many of this report's videos are still on their way from this phone
 *  (its heads-up waits for them, lib/incidentNotify, as it waits for its
 *  photos). One that can never land (its file gone, or refused by the server)
 *  doesn't hold the heads-up: the office still hears of the report, and the
 *  queue has reported the clip. */
export async function pendingReportVideos(reportId: string): Promise<number> {
  return (await readQueue()).filter(v => v.video_type === 'report' && v.incident_report_id === reportId
    && !v.fileGone && v.lastErrorKind !== 'server').length
}

/** Jobs with a video still in the queue (lib/cachePrune keeps their offline copy). */
export async function queuedVideoJobIds(): Promise<string[]> {
  return [...new Set((await readQueue()).map(v => v.job_id).filter(Boolean))]
}
