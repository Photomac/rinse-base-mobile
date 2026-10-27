// A photo the camera took after Android closed the app.
//
// Z & K Cleaning, 2026-10-27: "a team member will take the required photo,
// but the checklist doesn't necessarily mark that task as completed … our
// cleaners end up taking five or ten pictures of the exact same thing." Their
// Android crew repeated about 1 in 5 required shots (94 of 497, 10/12–10/23),
// iPhones 1 in 14. Opening the camera puts the app in the background, and
// Android may close it there to free memory. The photo then never reaches
// launchCameraAsync's answer: expo-image-picker keeps it for
// getPendingResultAsync(), which the app never called. Nothing reached the
// server, so there is no trace of these in job_photos.
//
// Before the camera opens, what the photo is for (its queue entry, less the
// file) is written down. The next start, or return to the app, asks for a
// photo left over and queues it as that entry: App.tsx then opens its clean
// and says it was kept. Android only: iOS doesn't close the app for its camera.
//
// Only one side may queue a photo. launchCameraFor() takes the note back when
// the camera answers; if a check already took it, the answer is the same photo
// and goes nowhere (an app that survived its screen being closed).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { enqueuePhoto, flushQueue } from './photoQueue'

/** A camera photo's queue entry, less the file and when it was taken. */
export type CameraPhotoFor = Omit<Parameters<typeof enqueuePhoto>[0], 'uri' | 'taken_at'>

interface CameraNote {
  id: string
  /** When the camera opened (ms). */
  at: number
  /** What the crew was photographing, for the "kept" message. */
  label: string | null
  photo: CameraPhotoFor
}

const KEY = 'cameraRecovery:note'
// A note older than this is for a camera nobody is coming back to.
export const NOTE_MAX_AGE_MS = 2 * 60 * 60 * 1000

// The note is read and changed one caller at a time (a check on return to the
// app can run while the camera's answer is being taken).
let chain: Promise<unknown> = Promise.resolve()
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

// undefined: the note couldn't be read.
async function readNote(): Promise<CameraNote | null | undefined> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return undefined
  }
}

async function forgetNote(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY) } catch { /* the next camera writes over it */ }
}

/** launchCameraAsync, with what the photo is for written down first (Android).
 *  A photo a check already queued comes back as canceled: the caller must not
 *  queue it again. Throws as launchCameraAsync does. */
export async function launchCameraFor(
  photo: CameraPhotoFor,
  label: string | null,
  options: ImagePicker.ImagePickerOptions,
): Promise<ImagePicker.ImagePickerResult> {
  if (Platform.OS !== 'android') return ImagePicker.launchCameraAsync(options)
  const note: CameraNote = { id: `${Date.now()}_${Math.floor(Math.random() * 1e6)}`, at: Date.now(), label, photo }
  const written = await inTurn(async () => {
    try { await AsyncStorage.setItem(KEY, JSON.stringify(note)); return true } catch { return false }
  })
  let result: ImagePicker.ImagePickerResult
  try {
    result = await ImagePicker.launchCameraAsync(options)
  } catch (e) {
    if (written) await takeBack(note.id)
    throw e
  }
  // Not written: no check can have it, so the photo is the caller's.
  if (!written) return result
  const mine = await takeBack(note.id)
  if (!mine && !result.canceled) return { canceled: true, assets: null }
  return result
}

// True when the note is still `id`'s (and now gone): the camera's answer is
// the caller's to queue. False when a check took it first.
function takeBack(id: string): Promise<boolean> {
  return inTurn(async () => {
    const note = await readNote()
    // Unreadable: keep the photo rather than lose it.
    if (note === undefined) return true
    if (note?.id !== id) return false
    await forgetNote()
    return true
  })
}

export interface KeptPhoto { jobId: string; label: string | null }

let checkedThisLaunch = false

/** Queue a photo the camera took after Android closed the app, as the entry
 *  noted when it opened. Null when there is none, or none of `userId`'s.
 *  Call at every start (once signed in) and every return to the app. */
export function recoverCameraPhoto(userId: string): Promise<KeptPhoto | null> {
  if (Platform.OS !== 'android') return Promise.resolve(null)
  const atStart = !checkedThisLaunch
  checkedThisLaunch = true
  return inTurn(async () => {
    let left: Awaited<ReturnType<typeof ImagePicker.getPendingResultAsync>> = null
    try { left = await ImagePicker.getPendingResultAsync() } catch { left = null }
    const note = await readNote()
    const asset = left && !('code' in left) && !left.canceled ? left.assets?.[0] : null
    const fresh = !!note && Date.now() - note.at <= NOTE_MAX_AGE_MS
    if (!asset) {
      // At a start, the camera the note was for went with the old app (closed
      // with nothing taken): forget it. While the app runs, the camera may
      // still be open, its answer on its way to launchCameraFor: leave it.
      if (note && (atStart || !fresh)) await forgetNote()
      return null
    }
    // A camera this file didn't open (a profile picture, an incident form),
    // another person's, or one long gone: nothing to file the photo under.
    if (!note || !fresh || note.photo.user_id !== userId) {
      if (note) await forgetNote()
      return null
    }
    await forgetNote()
    try {
      await enqueuePhoto({ ...note.photo, uri: asset.uri, taken_at: Date.now() })
    } catch {
      return null
    }
    void flushQueue().catch(() => {})
    return { jobId: note.photo.job_id, label: note.label }
  })
}
