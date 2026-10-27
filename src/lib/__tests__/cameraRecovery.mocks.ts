// Stand-ins for cameraRecovery.ts and roomShots.ts (scripts/test-camera-recovery.mjs
// rewrites their imports to this file): the phone's storage, the platform, the
// camera, and the photo queue. They live in this module so they outlive a
// "relaunch" (the scenario re-requires cameraRecovery for a fresh app start).

// ── AsyncStorage ─────────────────────────────────────────────────────────────
export const store = new Map<string, string>()
export const storage = { failWrites: false, failReads: false }
export const AsyncStorage = {
  async getItem(k: string) {
    if (storage.failReads) throw new Error('storage unreadable')
    return store.has(k) ? store.get(k)! : null
  },
  async setItem(k: string, v: string) {
    if (storage.failWrites) throw new Error('storage full')
    store.set(k, v)
  },
  async removeItem(k: string) { store.delete(k) },
}

// ── react-native ─────────────────────────────────────────────────────────────
export const Platform = { OS: 'android' as 'android' | 'ios' }

// ── expo-image-picker ────────────────────────────────────────────────────────
// The camera: launchCameraAsync waits until the scenario answers it (or never,
// when Android closes the app). What Android keeps for getPendingResultAsync
// is set by the scenario.
export const camera = {
  opened: 0,
  pendingAsks: 0,
  // What the note held at the moment the camera opened.
  noteAtOpen: null as string | null,
  answer: null as null | ((r: any) => void),
  fail: null as null | ((e: any) => void),
  left: null as any,
}
export const ImagePicker = {
  launchCameraAsync(_opts: any): Promise<any> {
    camera.opened++
    camera.noteAtOpen = [...store.values()][0] ?? null
    return new Promise((resolve, reject) => { camera.answer = resolve; camera.fail = reject })
  },
  async getPendingResultAsync() {
    camera.pendingAsks++
    const r = camera.left
    camera.left = null
    return r
  },
}

// ── photoQueue ───────────────────────────────────────────────────────────────
export const queued: any[] = []
export const counts = { flushes: 0 }
export async function enqueuePhoto(p: any): Promise<string> {
  queued.push(p)
  return `q${queued.length}`
}
export async function flushQueue() { counts.flushes++; return { uploaded: 0, remaining: 0, serverRejected: 0, lastServerError: null } }
export const shotsOnPhone = new Map<string, any>()
export async function queuedShots(_jobId: string) { return shotsOnPhone }

export function reset() {
  store.clear()
  storage.failWrites = false
  storage.failReads = false
  Platform.OS = 'android'
  camera.opened = 0
  camera.pendingAsks = 0
  camera.noteAtOpen = null
  camera.answer = null
  camera.fail = null
  camera.left = null
  queued.length = 0
  counts.flushes = 0
  shotsOnPhone.clear()
}
