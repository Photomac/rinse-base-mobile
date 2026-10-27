// Camera-recovery scenario. Run with: node scripts/test-camera-recovery.mjs
//
// The REAL cameraRecovery.ts and roomShots.ts (imports rewritten to
// cameraRecovery.mocks.ts by the runner). Z & K Cleaning, 2026-10-27: Android
// crews took the same required shot five or ten times. Android may close the
// app while the camera is open; the photo then waits in
// getPendingResultAsync(), which the app never asked for. Here the app asks at
// its next start and on every return, and queues the photo as the shot the
// camera was opened for, once.
//
// An app start is a fresh require of cameraRecovery (its "first check this
// launch" is module state); the phone's storage and camera live in the mocks.
//
// The runner also builds mutants and requires each to FAIL here.
import { roomShots, withShotStates, type ShotRow } from '../roomShots'
import { store, storage, Platform, camera, queued, counts, reset } from './cameraRecovery.mocks'

let failures = 0
let finished = false
process.on('beforeExit', () => {
  if (!finished) { console.error('\nA step never finished: the scenario stalled'); process.exit(1) }
})
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!cond) failures++
}
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms))

// A new app start: cameraRecovery with fresh module state.
declare const require: any
function launch(): typeof import('../cameraRecovery') {
  const path = require.resolve('./cameraRecovery')
  delete require.cache[path]
  return require('./cameraRecovery')
}

const SHOT = {
  tenant_id: 'T', job_id: 'J1', user_id: 'U', photo_type: 'after',
  caption: 'PHOTO REQUIRED - TV ON', photo_requirement_id: 'rq-tv', visible_to_client: true,
}
const PHOTO = { canceled: false, assets: [{ uri: 'file:///cache/ImagePicker/shot.jpg', width: 1, height: 1 }] }
const note = () => [...store.values()][0] ?? null

const scenarios: Record<string, () => Promise<void>> = {
  async iphoneNeverWritesANote() {
    reset(); Platform.OS = 'ios'
    const app = launch()
    const taking = app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    ok('iPhone: no note when the camera opens', camera.noteAtOpen === null && store.size === 0)
    camera.answer!(PHOTO)
    const r = await taking
    ok('iPhone: the camera\'s answer is the caller\'s', r === PHOTO)
    ok('iPhone: nothing to recover, Android isn\'t asked', (await app.recoverCameraPhoto('U')) === null && camera.pendingAsks === 0)
  },

  async androidNormalShot() {
    reset()
    const app = launch()
    await app.recoverCameraPhoto('U') // the start's check, nothing left
    const taking = app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    const at = camera.noteAtOpen ? JSON.parse(camera.noteAtOpen) : null
    ok('the note is written before the camera opens', at?.photo?.photo_requirement_id === 'rq-tv' && at?.photo?.job_id === 'J1' && at?.label === 'TV on')
    // Back from the camera, Android says "active" before the answer lands.
    const back = await app.recoverCameraPhoto('U')
    ok('a return check with nothing left keeps the note (the answer is on its way)', back === null && note() !== null)
    camera.answer!(PHOTO)
    const r = await taking
    ok('the camera\'s answer is the caller\'s', r === PHOTO)
    ok('the note is gone once the answer is taken', note() === null)
    ok('nothing queued by recovery', queued.length === 0)
  },

  async appClosedWhileCameraOpen() {
    reset()
    let app = launch()
    await app.recoverCameraPhoto('U')
    void app.launchCameraFor(SHOT, 'TV on', {}) // Android closes the app: never answered
    await settle()
    camera.left = PHOTO
    const t0 = Date.now()
    app = launch()
    const kept = await app.recoverCameraPhoto('U')
    ok('the next start finds the photo and names its clean and shot', kept?.jobId === 'J1' && kept?.label === 'TV on', JSON.stringify(kept))
    const q = queued[0]
    ok('it is queued once, as the shot the camera was opened for',
      queued.length === 1 && q.uri === PHOTO.assets[0].uri && q.photo_requirement_id === 'rq-tv' && q.job_id === 'J1'
        && q.caption === 'PHOTO REQUIRED - TV ON' && q.photo_type === 'after' && q.visible_to_client === true && q.user_id === 'U',
      JSON.stringify(q))
    ok('with when it was taken', typeof q?.taken_at === 'number' && q.taken_at >= t0)
    ok('and the upload starts', counts.flushes === 1)
    ok('the note is gone', note() === null)
    ok('a second check finds nothing', (await app.recoverCameraPhoto('U')) === null && queued.length === 1)
  },

  async startWithNothingTaken() {
    reset()
    let app = launch()
    void app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    app = launch() // closed with the camera open, nothing taken
    ok('a start with nothing left: nothing queued', (await app.recoverCameraPhoto('U')) === null && queued.length === 0)
    ok('and the note for that camera is forgotten', note() === null)
    // A later photo from a camera this file didn't open is not filed under it.
    camera.left = PHOTO
    ok('a later leftover photo is not filed under the old shot', (await app.recoverCameraPhoto('U')) === null && queued.length === 0)
  },

  async leftoverFromAnotherCamera() {
    reset()
    camera.left = PHOTO // a profile picture or an incident form's photo
    const app = launch()
    ok('a leftover photo with no note: nothing queued', (await app.recoverCameraPhoto('U')) === null && queued.length === 0)
  },

  async canceledOrFailedLeftover() {
    reset()
    let app = launch()
    void app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    camera.left = { canceled: true, assets: null }
    app = launch()
    ok('a canceled leftover: nothing queued, note forgotten', (await app.recoverCameraPhoto('U')) === null && queued.length === 0 && note() === null)
    void app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    camera.left = { code: 'ERR_CAMERA', message: 'camera failed' }
    app = launch()
    ok('an error leftover: nothing queued, note forgotten', (await app.recoverCameraPhoto('U')) === null && queued.length === 0 && note() === null)
  },

  async anotherPersonsPhoto() {
    reset()
    let app = launch()
    void app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    camera.left = PHOTO
    app = launch()
    ok('signed in as someone else: not queued under their name', (await app.recoverCameraPhoto('U2')) === null && queued.length === 0)
    ok('and the note is forgotten', note() === null)
  },

  async staleNote() {
    reset()
    let app = launch()
    void app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    const n = JSON.parse(note()!)
    n.at = Date.now() - app.NOTE_MAX_AGE_MS - 60_000
    store.set([...store.keys()][0], JSON.stringify(n))
    camera.left = PHOTO
    app = launch()
    ok('a note older than the limit: nothing queued', (await app.recoverCameraPhoto('U')) === null && queued.length === 0 && note() === null)
    // While the app runs, an old note with nothing left is forgotten too.
    reset()
    app = launch()
    await app.recoverCameraPhoto('U')
    void app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    const m = JSON.parse(note()!)
    m.at = Date.now() - app.NOTE_MAX_AGE_MS - 60_000
    store.set([...store.keys()][0], JSON.stringify(m))
    await app.recoverCameraPhoto('U')
    ok('an old note is forgotten on a return check', note() === null)
  },

  // The app's screen was closed but its JavaScript lived on: the return check
  // queues the photo, then the camera answers with the same one.
  async survivingAppQueuesOnce() {
    reset()
    const app = launch()
    await app.recoverCameraPhoto('U')
    const taking = app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    camera.left = PHOTO
    const kept = await app.recoverCameraPhoto('U')
    ok('the return check queues the leftover photo', kept?.jobId === 'J1' && queued.length === 1)
    camera.answer!(PHOTO)
    const r = await taking
    ok('the late answer comes back canceled: the caller queues nothing', r.canceled === true && r.assets === null)
  },

  async noteNotWritten() {
    reset()
    const app = launch()
    await app.recoverCameraPhoto('U')
    storage.failWrites = true
    const taking = app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    camera.answer!(PHOTO)
    ok('no note could be written: the photo is still the caller\'s', (await taking) === PHOTO)
  },

  async noteUnreadableOnAnswer() {
    reset()
    const app = launch()
    await app.recoverCameraPhoto('U')
    const taking = app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    storage.failReads = true
    camera.answer!(PHOTO)
    ok('the note can\'t be read back: the photo is kept, not dropped', (await taking) === PHOTO)
  },

  async cameraThrows() {
    reset()
    const app = launch()
    await app.recoverCameraPhoto('U')
    const taking = app.launchCameraFor(SHOT, 'TV on', {})
    await settle()
    camera.fail!(new Error('camera unavailable'))
    let threw = false
    try { await taking } catch { threw = true }
    ok('the camera\'s error reaches the caller', threw)
    ok('and its note is taken back', note() === null)
    camera.left = PHOTO
    ok('so a later leftover isn\'t filed under it', (await app.recoverCameraPhoto('U')) === null && queued.length === 0)
  },

  // ── Each shot's mark (roomShots) ─────────────────────────────────────────
  async shotMarks() {
    reset()
    const q = (over: any = {}) => ({ localUri: 'file:///p/a.jpg', storedUrl: 'https://s/a.jpg', created_at: 1, waiting: false, ...over })
    const server = [{ photo_requirement_id: 'r-saved', photo_url: 'https://s/old.jpg' }]
    const after = new Map<string, any>([['r-up', q()], ['r-wait', q({ waiting: true })]])
    const before = new Map<string, any>([['r-landed', q({ storedUrl: 'https://s/landed.jpg' })], ...after])
    const shots = roomShots(server, before, after)
    ok('a shot on the server: saved', shots['r-saved']?.state === 'saved')
    ok('a shot uploading from the phone: uploading', shots['r-up']?.state === 'uploading')
    ok('a shot waiting for signal: waiting', shots['r-wait']?.state === 'waiting')
    ok('a shot that landed while the card read: saved', shots['r-landed']?.state === 'saved' && shots['r-landed']?.uri === 'https://s/landed.jpg')

    const rows: ShotRow[] = [
      { id: 'a', photo_url: 'file:///cache/a.jpg', photo_fallback: null, photo_state: 'uploading' },
      { id: 'b', photo_url: 'file:///p/b.jpg', photo_fallback: 'https://s/b.jpg', photo_state: 'uploading' },
      { id: 'c', photo_url: 'https://s/c.jpg', photo_fallback: null, photo_state: 'saved' },
      { id: 'd', photo_url: null, photo_fallback: null, photo_state: null },
      { id: 'e', photo_url: 'file:///p/e.jpg', photo_fallback: 'https://s/e.jpg', photo_state: 'uploading' },
    ]
    const onPhone = new Map<string, any>([
      ['a', q({ localUri: 'file:///p/a.jpg', storedUrl: 'https://s/a.jpg', waiting: true })],
      ['d', q({ refused: true })],
      ['e', q({ refused: true })],
    ])
    let next = withShotStates(rows, onPhone, false)
    const again = withShotStates(next, onPhone, false)
    ok('read again with nothing new: the same rows back', again.every((r, i) => r === next[i]))
    ok('on the phone with no signal: waiting, from its queued file, with the stored copy behind it',
      next[0].photo_state === 'waiting' && next[0].photo_url === 'file:///p/a.jpg' && next[0].photo_fallback === 'https://s/a.jpg', JSON.stringify(next[0]))
    ok('left the queue but nothing landed: keeps its mark', next[1] === rows[1])
    ok('a saved shot is left as it is', next[2] === rows[2])
    ok('refused with nothing on screen: the room still asks for it', next[3] === rows[3])
    ok('refused after it was shown: didn\'t upload', next[4].photo_state === 'failed')
    next = withShotStates(rows, new Map(), true)
    ok('left the queue as one of the clean\'s photos landed: saved', next[1].photo_state === 'saved' && next[1].photo_url === rows[1].photo_url)
    ok('a shot with nothing on screen never reads saved', next[3] === rows[3])
    const same = withShotStates(next, new Map(), true)
    ok('nothing changed: the same rows back', same.every((r, i) => r === next[i]))
  },
}

;(async () => {
  for (const [name, run] of Object.entries(scenarios)) {
    console.log(`\n── ${name}`)
    try { await run() } catch (e: any) { ok(`${name} threw`, false, e?.message || String(e)) }
  }
  finished = true
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
