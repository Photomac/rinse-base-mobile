// src/lib/photoQueue.ts
// Offline-resilient job-photo uploads. Crews in poor/no cell coverage capture
// before/after/damage photos that must NOT be lost. On capture we persist the
// file to durable storage + enqueue its metadata; uploads are attempted right
// away and retried opportunistically (on capture, when the Photos screen opens,
// and whenever the app returns to the foreground) until they land. No NetInfo
// dependency, so this ships over-the-air via `eas update`.
//
// Capture never waits for an upload (2026-10-05): screens enqueue, kick
// flushQueue() without awaiting it, and follow progress through
// onPhotoQueueChange(). On one rural bar a photo took 24–103 s (CKS
// Perfections), and the old flow held the camera button for every one of them.
//
// Each job photo's row also carries the SHA-256 of the file it uploaded
// (job_photos.photo_sha256, 2026-10-12; rinse-base-app #1391), which nobody but
// the server can change once the row is saved. The web's stamped download
// hashes the stored file and prints whether the two still match. Worked out
// once per photo, from the same local file the upload sends, while it uploads.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system/legacy'
import { supabase, usableAccessToken } from './supabase'
import { reportClientError } from './errorReporter'
import { sha256HexOfBase64 } from './sha256'

const QUEUE_KEY = 'rinsebase.photoQueue.v1'
const DIR = FileSystem.documentDirectory + 'pending_photos/'
const SUPABASE_URL = 'https://cbnbhwclbtowfbjylnph.supabase.co'
// One weak bar can hold a request open indefinitely without failing it, and
// only one flush runs at a time — so a single hung upload blocked every other
// retry trigger until the app was killed (Rhyne, Port O'Connor, 9/23). Sized
// for a SLOW-but-alive upload to finish: photos run ~1.8 MB average, 3.5 MB
// max, which takes ~2 min at 25 KB/s. A shorter cap would kill those every time.
const UPLOAD_TIMEOUT_MS = 240_000
// Asking storage whether a refused file is already there (alreadyStored) is a
// tiny request; it shouldn't hold the pass as long as an upload may.
const CHECK_TIMEOUT_MS = 30_000

// 'network' = couldn't reach the server (no signal, fetch threw, no session yet)
// — retrying when coverage returns IS the fix. 'server' = the server heard us
// and said no (4xx from storage, job_photos insert error) — retrying won't fix
// it without a server-side change, and the UI must not blame it on signal.
export type UploadErrorKind = 'network' | 'server'

export interface PendingPhoto {
  id: string
  localUri: string
  fileName: string
  tenant_id: string
  job_id: string
  user_id: string
  photo_type: string
  caption: string | null
  // Canonical link to the checklist item this photo satisfies (the completion
  // gate matches on it; caption-matching is the legacy fallback). Optional so
  // entries queued by older bundles keep uploading.
  checklist_item_id?: string | null
  // Canonical link to the property_photo_requirements row this photo satisfies.
  // The `missing_required_area_photo` gate matches on this ONLY — there is no
  // caption fallback — so it must survive the offline queue intact.
  photo_requirement_id?: string | null
  // The Check first line (property_check_first_lines) this photo answers, sent
  // as job_photos.check_first_line_id. Present only on such a photo, so every
  // other entry, and the row it becomes, is exactly as before.
  check_first_line_id?: string
  visible_to_client: boolean
  // Set on an incident-report photo: once in storage it is appended to that
  // job_damage_reports row (append_incident_report_photo) instead of becoming a
  // job_photos row. Absent on every entry queued before 2026-09-23.
  incident_report_id?: string | null
  // A damage photo flagged for an incident report from the Photos screen: it is
  // a job_photos row like any other photo AND is attached to that report. (A
  // photo taken inside the incident form is only attached.)
  also_job_photo?: boolean
  // The file already reached storage on an earlier try; only the follow-up
  // write is outstanding, so the next try skips the (large) upload. Written to
  // the stored queue as soon as the upload lands, before the row is written.
  stored?: boolean
  // The job_photos row is written; only the report attach is outstanding.
  row_saved?: boolean
  // When it was enqueued. Not sent: a library photo is enqueued long after it
  // was taken.
  created_at: number
  // When the photo was taken (ms), sent as job_photos.taken_at: the camera's
  // moment, or a library photo's EXIF time (src/lib/photoTakenAt.ts). Null =
  // unknown, and so is an entry queued before 2026-10-12 (absent): the web's
  // stamped download then shows the upload time, said to be one.
  taken_at?: number | null
  // The SHA-256 (lowercase hex) of the local file the upload sends, sent as
  // job_photos.photo_sha256. Worked out on the first try and kept, so a retry
  // doesn't hash the photo again. Null = it couldn't be read or hashed, and the
  // row is saved without one; absent = not worked out yet (and on every entry
  // queued before 2026-10-12).
  sha256?: string | null
  attempts?: number
  // Uploads of this photo that ran out the clock. Used to send a photo that
  // keeps timing out to the back of the pass, so it can't hold every photo
  // behind it hostage on a slow bar.
  timeouts?: number
  lastErrorKind?: UploadErrorKind
  lastError?: string
  nextAttemptAt?: number
  // Tries the server answered with a refusal (a 'server' failure). A queued
  // Complete for this clean stops waiting on the photo once it reaches
  // REFUSALS_BEFORE_COMPLETE_GOES (photosAheadOfComplete). Absent on entries
  // queued before 2026-10-16.
  refusals?: number
}

export interface QueueStatus {
  uploaded: number
  remaining: number
  serverRejected: number
  lastServerError: string | null
}

export interface PendingStatus {
  count: number
  serverRejected: number
  lastServerError: string | null
}

async function readQueue(): Promise<PendingPhoto[]> {
  try { const raw = await AsyncStorage.getItem(QUEUE_KEY); return raw ? JSON.parse(raw) : [] }
  catch { return [] }
}

async function writeQueue(q: PendingPhoto[]): Promise<void> {
  try { await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q)) } catch { /* best effort */ }
}

// Every change to the stored queue goes through here, one at a time. Captures,
// a library batch and the upload pass all rewrite the same key; two writers
// that each read the list, change it and write it back lose whichever change
// was written first.
let queueLock: Promise<unknown> = Promise.resolve()
function mutateQueue(change: (q: PendingPhoto[]) => PendingPhoto[]): Promise<PendingPhoto[]> {
  const run = queueLock.then(async () => {
    const next = change(await readQueue())
    await writeQueue(next)
    return next
  })
  queueLock = run.catch(() => {})
  return run.finally(() => emit({}))
}

export interface PhotoQueueEvent {
  /** Set when a photo for this job has just become a job_photos row. */
  uploadedJobId?: string
}
const listeners = new Set<(e: PhotoQueueEvent) => void>()

/** Called whenever the queue changes or an upload starts or stops. Returns
 *  the unsubscribe function. */
export function onPhotoQueueChange(fn: (e: PhotoQueueEvent) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit(e: PhotoQueueEvent): void {
  for (const fn of listeners) { try { fn(e) } catch { /* a screen's bug must not stop the queue */ } }
}

// iOS can move the app's data folder when the app is updated, so the absolute
// path stored with an older entry may no longer exist although the file does.
// Resolve every queued file against today's folder.
function resolveLocal(uri: string): string {
  const marker = '/pending_photos/'
  const i = uri.indexOf(marker)
  return i >= 0 ? DIR + uri.slice(i + marker.length) : uri
}

// True only when the file is known to be gone. An entry like that can never
// upload, and a pass that tried it would fail as "no signal" and stop there
// every time, stranding every photo behind it.
async function fileMissing(uri: string): Promise<boolean> {
  if (!uri.startsWith('file://')) return false
  try { return !(await FileSystem.getInfoAsync(uri)).exists } catch { return false }
}

async function ensureDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DIR)
    if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true })
  } catch { /* fall back to the original cache uri */ }
}

// Persist the captured photo to durable storage and add it to the pending queue.
// The file is copied out of the (clearable) image-picker cache so it survives an
// app restart while it waits for signal. Returns the queue entry's id.
// incident_report_id: a damage photo the crew flagged for that report — it is
// saved as a job photo and also attached to the report.
export async function enqueuePhoto(p: {
  uri: string; tenant_id: string; job_id: string; user_id: string;
  photo_type: string; caption: string | null; checklist_item_id?: string | null;
  photo_requirement_id?: string | null;
  /** A Check first line's photo (lib/checkFirst.ts). */
  check_first_line_id?: string | null;
  visible_to_client: boolean;
  incident_report_id?: string | null;
  /** When it was taken (ms): Date.now() as the camera returns it, or exifTakenAt() for a library photo. */
  taken_at?: number | null;
}): Promise<string> {
  await ensureDir()
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const id = `${p.job_id}_${stamp}`
  const localUri = `${DIR}${id}.jpg`
  let persisted = p.uri
  try {
    await FileSystem.copyAsync({ from: p.uri, to: localUri })
    persisted = localUri
  } catch { /* keep the original uri if the copy fails */ }

  const entry: PendingPhoto = {
    id,
    localUri: persisted,
    // Tenant-rooted path to match the web app's convention (the storage policy
    // accepts both the old job-rooted and this form — rinse-base-app PR #280).
    // The random part matters: a library batch queues several photos in the
    // same millisecond, and with x-upsert a shared name means the last one
    // silently overwrites the others.
    fileName: `${p.tenant_id}/${p.job_id}/${stamp}.jpg`,
    tenant_id: p.tenant_id,
    job_id: p.job_id,
    user_id: p.user_id,
    photo_type: p.photo_type,
    caption: p.caption,
    checklist_item_id: p.checklist_item_id ?? null,
    photo_requirement_id: p.photo_requirement_id ?? null,
    ...(p.check_first_line_id ? { check_first_line_id: p.check_first_line_id } : {}),
    visible_to_client: p.visible_to_client,
    ...(p.incident_report_id ? { incident_report_id: p.incident_report_id, also_job_photo: true } : {}),
    created_at: Date.now(),
    taken_at: p.taken_at ?? null,
  }
  await mutateQueue(q => [...q, entry])
  return id
}

/** Copy a just-captured photo out of the clearable image-picker cache into
 *  durable storage and return the durable uri. Used where the photo is held
 *  on screen before it is queued (the incident report form). */
export async function persistCapturedPhoto(uri: string, jobId: string): Promise<string> {
  await ensureDir()
  const localUri = `${DIR}${jobId}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.jpg`
  try {
    await FileSystem.copyAsync({ from: uri, to: localUri })
    return localUri
  } catch {
    return uri
  }
}

/** Remove a persisted photo the crew discarded before saving. */
export async function discardCapturedPhoto(localUri: string): Promise<void> {
  if (!localUri.startsWith(DIR)) return
  try { await FileSystem.deleteAsync(localUri, { idempotent: true }) } catch { /* ignore */ }
}

/** Queue an incident-report photo already persisted with persistCapturedPhoto.
 *  It uploads like any job photo, then attaches to its report — which may
 *  itself still be waiting in the outbox; the attach simply retries. */
export async function enqueueIncidentPhoto(p: {
  localUri: string; tenant_id: string; job_id: string; user_id: string; incident_report_id: string
}): Promise<void> {
  const id = `${p.job_id}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const entry: PendingPhoto = {
    id,
    localUri: p.localUri,
    fileName: `${p.tenant_id}/${p.job_id}/incident_${Date.now()}_${Math.floor(Math.random() * 1e4)}.jpg`,
    tenant_id: p.tenant_id,
    job_id: p.job_id,
    user_id: p.user_id,
    photo_type: 'damage',
    caption: null,
    visible_to_client: false,
    incident_report_id: p.incident_report_id,
    created_at: Date.now(),
  }
  await mutateQueue(q => [...q, entry])
}

/** Photos for this incident report still waiting to upload or attach. */
export async function pendingIncidentPhotos(reportId: string): Promise<number> {
  return (await readQueue()).filter(p => p.incident_report_id === reportId).length
}

// PostgREST refusing a column it doesn't know: this bundle reached phones
// before the migration adding taken_at (or photo_sha256, or
// check_first_line_id) reached the database. The photo matters more than its
// capture time, fingerprint or Check first link, so its row is written
// without it. PostgREST says so as PGRST204 ('column'); Postgres itself, should
// it get that far, as 42703 ("column").
function unknownColumn(error: any, column: string): boolean {
  if (typeof error?.message !== 'string') return false
  if (error.code === 'PGRST204') return error.message.includes(`'${column}'`)
  return error.code === '42703' && error.message.includes(`"${column}"`)
}

// The row's columns newer than the database may be (2026-10-12; Check first
// 2026-10-15). PostgREST names one unknown column at a time.
const NEW_COLUMNS = ['taken_at', 'photo_sha256', 'check_first_line_id'] as const
function unknownNewColumn(error: any, row: Record<string, unknown>): string | undefined {
  return NEW_COLUMNS.find(c => c in row && unknownColumn(error, c))
}

// The SHA-256 of a queued photo's file, or null when it can't be read or
// hashed: the photo is then saved without a fingerprint, never held back for
// one. Never throws.
async function fileSha256(uri: string): Promise<string | null> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
    return await sha256HexOfBase64(b64)
  } catch (e: any) {
    reportClientError(`photoQueue: could not fingerprint a photo: ${e?.message || e}`, undefined, 'photoQueue')
    return null
  }
}

// Whether this entry still needs its fingerprint worked out: it becomes a
// job_photos row that isn't written yet. (A photo taken inside the incident
// form only joins its report, which has no fingerprint column.)
function needsFingerprint(entry: PendingPhoto): boolean {
  const jobPhoto = !entry.incident_report_id || !!entry.also_job_photo
  return jobPhoto && !entry.row_saved && entry.sha256 === undefined
}

// The file is already at this path in storage. The bucket is public, so a HEAD
// of its public URL answers without a session. No, or no answer, is false.
async function alreadyStored(fileName: string): Promise<boolean> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), CHECK_TIMEOUT_MS)
  try {
    const { data } = supabase.storage.from('job-photos').getPublicUrl(fileName)
    const res = await fetch(data.publicUrl, { method: 'HEAD', signal: ac.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

type UploadResult =
  | { ok: true }
  | { ok: false; kind: UploadErrorKind; message: string; stored?: boolean; rowSaved?: boolean; timedOut?: boolean }

// Pull a human-readable reason out of a storage error response, e.g.
// {"statusCode":"403","error":"Unauthorized","message":"new row violates row-level security policy"}
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

// Write this entry's job_photos row.
async function insertRow(entry: PendingPhoto, photoUrl: string, sha256: Promise<string | null | undefined>): Promise<{ error: any; status: number }> {
  const row: Record<string, unknown> = {
    tenant_id: entry.tenant_id,
    job_id: entry.job_id,
    user_id: entry.user_id,
    photo_url: photoUrl,
    photo_type: entry.photo_type,
    caption: entry.caption,
    checklist_item_id: entry.checklist_item_id ?? null,
    photo_requirement_id: entry.photo_requirement_id ?? null,
    visible_to_client: entry.visible_to_client,
  }
  // Only on a Check first photo: every other row is sent exactly as before.
  if (entry.check_first_line_id) row.check_first_line_id = entry.check_first_line_id
  if (entry.taken_at != null && Number.isFinite(entry.taken_at)) row.taken_at = new Date(entry.taken_at).toISOString()
  // The fingerprint goes last, so this writer's request body is the one
  // before it plus that one field (the edge logs tell writers apart by
  // body size).
  const fingerprint = await sha256
  if (fingerprint) row.photo_sha256 = fingerprint
  let { error, status } = await supabase.from('job_photos').insert(row)
  // A database without one of the newer columns: once more without the
  // one it names, until it names none.
  for (let column = unknownNewColumn(error, row); column; column = unknownNewColumn(error, row)) {
    delete row[column]
    ;({ error, status } = await supabase.from('job_photos').insert(row))
  }
  return { error, status }
}

// Upload one entry to storage + record it in job_photos (and/or attach it to
// its incident report). Storage upload is idempotent (x-upsert on a unique
// path); the queue entry is only dropped after every write succeeds. Failures
// are classified so the UI can tell "no signal" apart from "the server is
// rejecting uploads". Leaves the local file alone: the pass deletes it once the
// entry is out of the stored queue. sha256 = the file's fingerprint for the
// row, being worked out while the file uploads.
async function uploadOne(entry: PendingPhoto, sha256: Promise<string | null | undefined>): Promise<UploadResult> {
  let token: string | null
  try {
    // Null while the hour-long token has lapsed and can't be renewed (no
    // signal): storage would refuse it, and that 4xx read as "the server is
    // rejecting uploads" — red badge, minutes of backoff.
    token = await usableAccessToken()
  } catch (e: any) {
    return { ok: false, kind: 'network', message: e?.message || 'Could not read session' }
  }
  if (!token) return { ok: false, kind: 'network', message: 'No signed-in session yet' }

  // The file was in storage before this try: an earlier try may have written
  // the row too.
  let mayHaveRow = !!entry.stored
  if (!entry.stored) {
  let res: Response
  const ac = new AbortController()
  try {
    const form = new FormData()
    form.append('file', { uri: resolveLocal(entry.localUri), name: entry.fileName, type: 'image/jpeg' } as any)
    const timer = setTimeout(() => ac.abort(), UPLOAD_TIMEOUT_MS)
    try {
      res = await fetch(
        `${SUPABASE_URL}/storage/v1/object/job-photos/${entry.fileName}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-upsert': 'true' }, body: form, signal: ac.signal },
      )
    } finally {
      clearTimeout(timer)
    }
  } catch (e: any) {
    // A timeout is a coverage problem, not a rejection: keep it 'network' so it
    // retries on the next trigger instead of backing off.
    return { ok: false, kind: 'network', message: e?.message || 'Network request failed', timedOut: ac.signal.aborted }
  }
  if (!res.ok) {
    const message = await describeHttpError(res)
    // 5xx = transient, treat like a connectivity blip and keep retrying
    // opportunistically.
    if (res.status >= 500) return { ok: false, kind: 'network', message }
    // 4xx = the server rejected this upload (auth/policy/path) — unless the
    // file is already there. On a shared phone, the crew member signed in
    // before sent it and never heard back; only the uploader may write over a
    // job photo (rinse-base-app #1391), so this login's retry is refused every
    // time. The file is in storage: go on to its row.
    if (!(await alreadyStored(entry.fileName))) return { ok: false, kind: 'server', message }
    mayHaveRow = true
  }
  // Said in the stored queue now, before the row: had the row's answer been
  // lost, or the app closed before the pass took the entry out, the next try
  // sent the whole file again (a new storage version, which the web's check
  // reads as "re-sent") and wrote a second row (4 photos on prod, 2026-10-12).
  await mutateQueue(cur => cur.map(e => e.id === entry.id ? { ...e, stored: true } : e))
  }

  const { data: urlData } = supabase.storage.from('job-photos').getPublicUrl(entry.fileName)

  // Every photo except one taken inside the incident form is a job photo.
  const jobPhoto = !entry.incident_report_id || !!entry.also_job_photo
  if (jobPhoto && !entry.row_saved) {
    try {
      // An earlier try's insert may have landed without its answer reaching
      // the phone: look for that row before writing another (the web's shot
      // queue does the same, insertSent).
      let saved = false
      if (mayHaveRow) {
        const found = await supabase.from('job_photos').select('id')
          .eq('job_id', entry.job_id).eq('photo_url', urlData.publicUrl).limit(1)
        if (found.error) return { ok: false, kind: found.status === 0 ? 'network' : 'server', message: found.error.message, stored: true }
        saved = !!found.data?.length
      }
      if (!saved) {
        const { error, status } = await insertRow(entry, urlData.publicUrl, sha256)
        // status 0 = no signal (the photo is stored; only the row is missing) —
        // retry on the next trigger, not after a server-rejection backoff.
        if (error) return { ok: false, kind: status === 0 ? 'network' : 'server', message: error.message, stored: true }
      }
    } catch (e: any) {
      return { ok: false, kind: 'network', message: e?.message || 'Network request failed', stored: true }
    }
  }

  // Incident-report photo: attach it to its report.
  if (entry.incident_report_id) {
    const rowSaved = jobPhoto || undefined
    try {
      const { data, error, status } = await supabase.rpc('append_incident_report_photo', {
        p_report_id: entry.incident_report_id, p_url: urlData.publicUrl,
      })
      // A network failure here surfaces as status 0 on the RESPONSE (the error
      // object has no status — reading it there classed every miss as server).
      if (error) return { ok: false, kind: status === 0 ? 'network' : 'server', message: error.message, stored: true, rowSaved }
      // The report itself can still be waiting in the outbox; the drain runs
      // photos before the outbox, so this is expected on the first pass after
      // signal returns. Short backoff, file stays stored, no re-upload.
      if (data === 'no_report') return { ok: false, kind: 'server', message: 'Report not saved yet', stored: true, rowSaved }
      if (data === 'denied') return { ok: false, kind: 'server', message: 'Not allowed to add a photo to this report', stored: true, rowSaved }
    } catch (e: any) {
      return { ok: false, kind: 'network', message: e?.message || 'Network request failed', stored: true, rowSaved }
    }
  }

  return { ok: true }
}

// Server-rejected entries back off (2m, 4m, ... capped at 1h) so a permanently
// rejected photo doesn't hammer the API forever. The photo is never dropped —
// once the server-side problem is fixed the next due attempt lands it.
function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.min(attempts, 6), 3_600_000)
}

function summarize(uploaded: number, q: PendingPhoto[]): QueueStatus {
  const rejected = q.filter(p => p.lastErrorKind === 'server')
  return {
    uploaded,
    remaining: q.length,
    serverRejected: rejected.length,
    lastServerError: rejected.length ? rejected[rejected.length - 1].lastError ?? null : null,
  }
}

// One pass over the queue, oldest first, committing each photo's result to
// the stored queue as soon as it is known — so a photo that landed is never
// sent again (a second job_photos row) if the app is closed mid-pass.
async function runPass(force: boolean): Promise<{ uploaded: number; noSignal: boolean }> {
  // A photo that keeps timing out goes after the ones that haven't, or on a
  // slow bar it would fail first on every pass and nothing behind it would go.
  const q = (await readQueue()).slice()
    .sort((a, b) => (a.timeouts ?? 0) - (b.timeouts ?? 0) || a.created_at - b.created_at)
  let uploaded = 0
  for (const entry of q) {
    if (!force && entry.nextAttemptAt && Date.now() < entry.nextAttemptAt) continue
    if (!entry.stored && await fileMissing(resolveLocal(entry.localUri))) {
      await mutateQueue(cur => cur.filter(e => e.id !== entry.id))
      reportClientError(
        'photoQueue: dropped a queued photo whose file is no longer on the phone',
        JSON.stringify({ id: entry.id, job_id: entry.job_id, photo_type: entry.photo_type, attempts: entry.attempts ?? 0 }),
        'photoQueue',
      )
      continue
    }

    uploadingId = entry.id
    emit({})
    // Hashed from the file the upload sends, while it uploads (the hash hands
    // the JS thread back between slices; the upload runs natively).
    const fingerprint = needsFingerprint(entry) ? fileSha256(resolveLocal(entry.localUri)) : Promise.resolve(entry.sha256)
    const result = await uploadOne(entry, fingerprint).finally(() => { uploadingId = null })
    const sha256 = await fingerprint
    const jobPhoto = !entry.incident_report_id || !!entry.also_job_photo

    if (result.ok) {
      uploaded++
      await mutateQueue(cur => cur.filter(e => e.id !== entry.id))
      if (jobPhoto && !entry.row_saved) emit({ uploadedJobId: entry.job_id })
      // Only now: had the app died between deleting the file and rewriting the
      // queue, the entry would point at a file that no longer exists.
      try { await FileSystem.deleteAsync(resolveLocal(entry.localUri), { idempotent: true }) } catch { /* ignore */ }
      continue
    }

    const attempts = (entry.attempts ?? 0) + 1
    await mutateQueue(cur => cur.map(e => e.id !== entry.id ? e : {
      ...e,
      // Kept so the next try sends the same fingerprint without hashing again.
      sha256: e.sha256 !== undefined ? e.sha256 : sha256,
      stored: e.stored || result.stored || undefined,
      row_saved: e.row_saved || result.rowSaved || undefined,
      timeouts: result.timedOut ? (e.timeouts ?? 0) + 1 : e.timeouts,
      refusals: result.kind === 'server' ? refusalsOf(e) + 1 : e.refusals,
      attempts,
      lastErrorKind: result.kind,
      lastError: result.message,
      // Network failures retry on every trigger — coverage returning is the fix.
      nextAttemptAt: result.kind === 'server' ? Date.now() + backoffMs(attempts) : undefined,
    }))
    if (result.rowSaved && !entry.row_saved) emit({ uploadedJobId: entry.job_id })
    // After one "can't reach the server", the rest will fail the same way —
    // stop the pass instead of making each photo wait out its own timeout.
    // They keep their place and go on the next trigger.
    if (result.kind === 'network') return { uploaded, noSignal: true }
  }
  return { uploaded, noSignal: false }
}

let running: Promise<QueueStatus> | null = null
let rerun: { force: boolean } | null = null
let uploadingId: string | null = null

function takeRerun(): { force: boolean } | null {
  const r = rerun
  rerun = null
  return r
}

/** An upload pass is running right now. */
export function photoQueueActive(): boolean {
  return running !== null
}

// Upload every pending photo. Safe to call often and never runs two passes at
// once. A call while a pass is running doesn't start another: it asks that
// pass to go round once more when it ends (so a photo taken mid-pass goes
// right after, not at the next trigger) and gets the same result to await.
// force skips the server-rejection backoff — used by the manual retry tap.
export function flushQueue(opts?: { force?: boolean }): Promise<QueueStatus> {
  if (running) {
    rerun = { force: !!(rerun?.force || opts?.force) }
    return running
  }
  rerun = null
  running = (async () => {
    let force = !!opts?.force
    let uploaded = 0
    for (;;) {
      const pass = await runPass(force)
      uploaded += pass.uploaded
      const again = takeRerun()
      // No signal: going round again would only fail again; the next trigger
      // (capture, screen open, foreground, the 2-minute drain) retries.
      if (!again || pass.noSignal) break
      force = again.force
    }
    return summarize(uploaded, await readQueue())
  })().finally(() => {
    running = null
    rerun = null
    emit({})
  })
  emit({})
  return running
}

export async function pendingStatus(jobId?: string): Promise<PendingStatus> {
  // A flagged damage photo whose job_photos row is written is uploaded as far
  // as the job is concerned; only its report attach is left (and it can wait
  // on a report still in the outbox, which reads as a rejection). Not counted.
  const q = (await readQueue()).filter(p => !p.row_saved)
  const scoped = jobId ? q.filter(p => p.job_id === jobId) : q
  const { remaining, serverRejected, lastServerError } = summarize(0, scoped)
  return { count: remaining, serverRejected, lastServerError }
}

export interface QueuedJobPhoto {
  id: string
  localUri: string
  photo_type: string
  caption: string | null
  visible_to_client: boolean
  created_at: number
  /** The Check first line it answers, if any (lib/checkFirst.ts). */
  check_first_line_id: string | null
  /** The server rejected it (not just no signal). */
  failing: boolean
  /** Being uploaded right now. */
  uploading: boolean
}

/** This job's photos still on the device, for showing alongside uploaded ones.
 *  Photos taken inside the incident form are excluded: they belong to their
 *  report, not the job's photo list. So is a flagged damage photo whose
 *  job_photos row exists — the server list already shows it. */
export async function queuedJobPhotos(jobId: string): Promise<QueuedJobPhoto[]> {
  return (await readQueue())
    .filter(p => p.job_id === jobId && (!p.incident_report_id || p.also_job_photo) && !p.row_saved)
    .map(p => ({
      id: p.id, localUri: resolveLocal(p.localUri), photo_type: p.photo_type, caption: p.caption,
      visible_to_client: p.visible_to_client, created_at: p.created_at,
      check_first_line_id: p.check_first_line_id ?? null,
      failing: p.lastErrorKind === 'server',
      uploading: p.id === uploadingId,
    }))
}

// A queued Complete waits for its clean's photos (outbox.ts), because the
// completion gate refuses it while a photo it needs has no row yet. A photo the
// server keeps refusing would hold it forever, so after this many refusals the
// Complete goes and the server decides. Backing off 2, then 4 minutes, the
// third refusal comes at least 6 minutes after the first: long enough for a
// passing hiccup (a statement timeout reads as a refusal too) to clear.
const REFUSALS_BEFORE_COMPLETE_GOES = 3

// An entry from before `refusals` was kept: its tries count as refusals if the
// last one was.
function refusalsOf(p: PendingPhoto): number {
  return p.refusals ?? (p.lastErrorKind === 'server' ? p.attempts ?? 1 : 0)
}

export interface PhotosAheadOfComplete {
  /** Photos still to become this clean's job_photos rows: a queued Complete waits for them. */
  waiting: number
  /** Ones the server has refused REFUSALS_BEFORE_COMPLETE_GOES times or more: the Complete no longer waits. */
  refused: number
  /** The latest refusal's reason, for the crew and the office. */
  lastServerError: string | null
}

/** What this clean's photos still on the phone mean for its queued Complete.
 *  Counts only the entries that become job_photos rows, as the gate does: a
 *  photo taken inside the incident form only joins its report, and a flagged
 *  damage photo whose row is saved is waiting on nothing but that report. */
export async function photosAheadOfComplete(jobId: string): Promise<PhotosAheadOfComplete> {
  const mine = (await readQueue())
    .filter(p => p.job_id === jobId && (!p.incident_report_id || p.also_job_photo) && !p.row_saved)
  const refused = mine.filter(p => p.lastErrorKind === 'server' && refusalsOf(p) >= REFUSALS_BEFORE_COMPLETE_GOES)
  return {
    waiting: mine.length - refused.length,
    refused: refused.length,
    lastServerError: refused.length ? refused[refused.length - 1].lastError ?? null : null,
  }
}

/** Jobs with anything still in the queue (lib/cachePrune keeps their offline copy). */
export async function queuedPhotoJobIds(): Promise<string[]> {
  return [...new Set((await readQueue()).map(p => p.job_id).filter(Boolean))]
}

export async function pendingCount(jobId?: string): Promise<number> {
  return (await pendingStatus(jobId)).count
}
