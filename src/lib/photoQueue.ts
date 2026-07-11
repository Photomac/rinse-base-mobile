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
  visible_to_client: boolean
  created_at: number
  attempts?: number
  lastErrorKind?: UploadErrorKind
  lastError?: string
  nextAttemptAt?: number
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
  photo_type: string; caption: string | null; checklist_item_id?: string | null;
  visible_to_client: boolean;
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
    // Tenant-rooted path to match the web app's convention (the storage policy
    // accepts both the old job-rooted and this form — rinse-base-app PR #280).
    fileName: `${p.tenant_id}/${p.job_id}/${Date.now()}.jpg`,
    tenant_id: p.tenant_id,
    job_id: p.job_id,
    user_id: p.user_id,
    photo_type: p.photo_type,
    caption: p.caption,
    checklist_item_id: p.checklist_item_id ?? null,
    visible_to_client: p.visible_to_client,
    created_at: Date.now(),
  }
  const q = await readQueue()
  q.push(entry)
  await writeQueue(q)
}

type UploadResult = { ok: true } | { ok: false; kind: UploadErrorKind; message: string }

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

// Upload one entry to storage + record it in job_photos. Storage upload is
// idempotent (x-upsert on a unique path); the queue entry is only dropped
// after BOTH the upload and the db insert succeed. Failures are classified so
// the UI can tell "no signal" apart from "the server is rejecting uploads".
async function uploadOne(entry: PendingPhoto): Promise<UploadResult> {
  let token: string | undefined
  try {
    const { data: { session } } = await supabase.auth.getSession()
    token = session?.access_token ?? undefined
  } catch (e: any) {
    return { ok: false, kind: 'network', message: e?.message || 'Could not read session' }
  }
  if (!token) return { ok: false, kind: 'network', message: 'No signed-in session yet' }

  let res: Response
  try {
    const form = new FormData()
    form.append('file', { uri: entry.localUri, name: entry.fileName, type: 'image/jpeg' } as any)
    res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/job-photos/${entry.fileName}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-upsert': 'true' }, body: form },
    )
  } catch (e: any) {
    return { ok: false, kind: 'network', message: e?.message || 'Network request failed' }
  }
  if (!res.ok) {
    const message = await describeHttpError(res)
    // 4xx = the server rejected this upload (auth/policy/path); 5xx = transient,
    // treat like a connectivity blip and keep retrying opportunistically.
    return { ok: false, kind: res.status < 500 ? 'server' : 'network', message }
  }

  try {
    const { data: urlData } = supabase.storage.from('job-photos').getPublicUrl(entry.fileName)
    const { error } = await supabase.from('job_photos').insert({
      tenant_id: entry.tenant_id,
      job_id: entry.job_id,
      user_id: entry.user_id,
      photo_url: urlData.publicUrl,
      photo_type: entry.photo_type,
      caption: entry.caption,
      checklist_item_id: entry.checklist_item_id ?? null,
      visible_to_client: entry.visible_to_client,
    })
    if (error) return { ok: false, kind: 'server', message: error.message }
  } catch (e: any) {
    return { ok: false, kind: 'network', message: e?.message || 'Network request failed' }
  }

  try { await FileSystem.deleteAsync(entry.localUri, { idempotent: true }) } catch { /* ignore */ }
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

let flushing = false

// Attempt to upload every pending photo. Safe to call often; no-ops if already
// running (so the on-capture / on-open / on-foreground triggers don't overlap).
// force skips the server-rejection backoff — used by the manual retry tap.
export async function flushQueue(opts?: { force?: boolean }): Promise<QueueStatus> {
  if (flushing) return summarize(0, await readQueue())
  flushing = true
  try {
    const q = await readQueue()
    if (!q.length) return { uploaded: 0, remaining: 0, serverRejected: 0, lastServerError: null }
    let uploaded = 0
    const survivors: PendingPhoto[] = []
    for (const entry of q) {
      if (!opts?.force && entry.nextAttemptAt && Date.now() < entry.nextAttemptAt) {
        survivors.push(entry)
        continue
      }
      const result = await uploadOne(entry)
      if (result.ok) { uploaded++; continue }
      const attempts = (entry.attempts ?? 0) + 1
      survivors.push({
        ...entry,
        attempts,
        lastErrorKind: result.kind,
        lastError: result.message,
        // Network failures retry on every trigger — coverage returning is the fix.
        nextAttemptAt: result.kind === 'server' ? Date.now() + backoffMs(attempts) : undefined,
      })
    }
    await writeQueue(survivors)
    return summarize(uploaded, survivors)
  } finally {
    flushing = false
  }
}

export async function pendingStatus(jobId?: string): Promise<PendingStatus> {
  const q = await readQueue()
  const scoped = jobId ? q.filter(p => p.job_id === jobId) : q
  const { remaining, serverRejected, lastServerError } = summarize(0, scoped)
  return { count: remaining, serverRejected, lastServerError }
}

export async function pendingCount(jobId?: string): Promise<number> {
  return (await pendingStatus(jobId)).count
}
