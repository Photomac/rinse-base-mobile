// Required walkthrough videos on the phone. Run with: node scripts/test-videos-required.mjs
//
// The REAL videoQueue.ts beside the REAL outbox.ts. A company can require these
// videos before a clean can complete, and the crew who recorded must not wait on
// a file that can take hours: the record goes ahead of the file, and ahead of a
// Complete queued with no signal.
import { writeThrough, flushOutbox, pendingOpCount, rejectedOps } from '../outbox'
import { enqueueVideo, flushVideoQueue, announceVideos, queuedJobVideos } from '../videoQueue'
import { AsyncStorage, net, reported, video } from './videosRequired.mocks'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const settle = () => new Promise(r => setTimeout(r, 10))
const save = (job: string, type: 'before' | 'after' = 'after', secs = 40) => enqueueVideo({
  uri: `file:///cache/${job}.mp4`, tenant_id: 'T', job_id: job, user_id: 'U', video_type: type, duration_seconds: secs, recorded_at: '2026-10-30T15:00:00.000Z',
})
const records = () => net.applied.filter(a => a.table === 'job_videos_on_the_way')
const recordFor = (job: string) => records().flatMap(a => a.values).filter((r: any) => r.job_id === job)
let release: () => void = () => {}
const holdUploads = () => { video.hold = new Promise<void>(r => { release = r }) }

;(globalThis as any).FormData = class { parts: any = {}; append(k: string, v: any) { this.parts[k] = v } }
;(globalThis as any).fetch = async (url: string, init: any) => {
  if (url.includes('/auth/v1/health')) {
    if (!net.online) throw new TypeError('Network request failed')
    return { ok: true, status: 200, text: async () => '' }
  }
  video.uploads.push(url)
  if (video.hold) await video.hold
  if ([...video.failUploads].some(id => url.includes(id))) throw new TypeError('Network request failed')
  // A path from before iOS moved the app's folder: RN can't read the file.
  if (!String(init?.body?.parts?.file?.uri).startsWith('file:///doc/')) throw new TypeError('Network request failed')
  return { ok: true, status: 200, text: async () => '' }
}

;(async () => {
  // ── No signal: recorded, then Complete, then signal returns ──────────────
  net.online = false
  await save('V1')
  await settle()
  ok('no signal: the clip is on the phone', (await queuedJobVideos('V1')).length === 1)
  ok('…and no record got through', recordFor('V1').length === 0)
  await writeThrough({ table: 'jobs', op: 'update', match: { id: 'V1' }, values: { status: 'completed' } })
  await settle()
  ok('…the Complete queues', (await pendingOpCount()) === 1)

  // The gate (job_videos_owed) clears when the record lands.
  net.blocked.set('V1', ['no_finished_video'])
  net.beforeWrite = (table, _op, values) => {
    if (table !== 'job_videos_on_the_way') return
    for (const r of Array.isArray(values) ? values : [values]) if (r?.job_id === 'V1') net.blocked.delete('V1')
  }
  holdUploads()
  net.online = true
  await flushOutbox()
  await settle()
  const firstRecord = net.applied.findIndex(a => a.table === 'job_videos_on_the_way')
  const theComplete = net.applied.findIndex(a => a.table === 'jobs' && a.values?.status === 'completed')
  ok('signal back: the record lands before the queued Complete', firstRecord >= 0 && firstRecord < theComplete)
  ok('…the Complete goes through at once, not refused and parked', theComplete >= 0 && (await pendingOpCount()) === 0 && (await rejectedOps()).length === 0)
  ok('…with the file still not uploaded', video.uploads.length === 0)
  ok('…the record carries what the gate reads', (() => {
    const r: any = recordFor('V1')[0]
    return r && r.video_type === 'after' && r.duration_seconds === 40 && r.tenant_id === 'T' && r.user_id === 'U' && !!r.id && r.recorded_at === '2026-10-30T15:00:00.000Z'
  })())
  ok('…sent with ignoreDuplicates, so a re-send is harmless', records()[0]?.opts?.ignoreDuplicates === true && records()[0]?.opts?.onConflict === 'id')
  net.beforeWrite = null

  // ── Online: the record never waits for the file ──────────────────────────
  await save('V2', 'before')
  await settle()
  ok('saved online: the record is sent at once', recordFor('V2').length === 1 && (recordFor('V2')[0] as any).video_type === 'before')
  const flushing = flushVideoQueue()
  await settle()
  ok('…an upload started', video.uploads.length > 0)
  await save('V3', 'after')
  await settle()
  ok('…a clip saved during a slow upload gets its record now', recordFor('V3').length === 1)
  release()
  video.hold = null
  await flushing
  await settle()
  const requestsBefore = video.requests.length
  await announceVideos()
  await flushVideoQueue()
  await settle()
  ok('told once: no clip sent again after a pass rewrote the queue', recordFor('V2').length === 1 && recordFor('V3').length === 1)
  ok('…nothing asked of the server with nothing left to tell', video.requests.length === requestsBefore)
  await flushVideoQueue()
  ok('landed: nothing left on the phone', (await queuedJobVideos('V2')).length === 0 && (await queuedJobVideos('V3')).length === 0)
  const told = JSON.parse((await AsyncStorage.getItem('rinsebase.videoQueue.announced.v1')) ?? '[]')
  await save('V3b')
  await settle()
  await flushVideoQueue()
  await save('V3c')
  await settle()
  const toldNow = JSON.parse((await AsyncStorage.getItem('rinsebase.videoQueue.announced.v1')) ?? '[]')
  ok('…and the list of clips told doesn\'t outgrow the queue', toldNow.length <= 1 && told.length <= 3)
  await flushVideoQueue()

  // ── Refused ──────────────────────────────────────────────────────────────
  holdUploads()
  const reportedBefore = reported.length
  video.notOnClean.add('V4')
  net.online = false
  await save('V4')
  await save('V5')
  await settle()
  net.online = true
  await announceVideos()
  await settle()
  ok('a batch refused whole goes again one by one: the clean this person is on still gets its record', recordFor('V5').length === 1)
  ok('…not being on the clean is expected: not reported', reported.length === reportedBefore)
  const requestsAfterRefusal = video.requests.length
  await announceVideos()
  ok('…and not tried again', video.requests.length === requestsAfterRefusal)
  ok('…its clip stays queued to upload', (await queuedJobVideos('V4')).length === 1)
  video.broken.add('V6')
  await save('V6')
  await settle()
  ok('any other refusal is reported', reported.length === reportedBefore + 1 && /refused 1 video record/.test(reported[reported.length - 1]))
  release()
  video.hold = null
  await flushVideoQueue()
  ok('…and the upload still goes', (await queuedJobVideos('V6')).length === 0)

  // ── A server without the table ───────────────────────────────────────────
  video.noTable = true
  await save('V7')
  await settle()
  const asked = video.requests.length
  await save('V8')
  await settle()
  ok('no table on the server: asked once, not again', video.requests.length === asked)
  await flushVideoQueue()
  ok('…the videos upload as always', (await queuedJobVideos('V7')).length === 0 && (await queuedJobVideos('V8')).length === 0)

  // ── One clip can't hold up the rest (CKS, Anya, 10/23 to 10/30) ──────────
  video.noTable = false
  const idOf = async (job: string) => (await queuedJobVideos(job))[0].id
  const left = async (job: string) => (await queuedJobVideos(job)).length
  net.online = false
  await save('B1', 'after', 83)
  await save('B2', 'before', 6)
  await save('B3', 'after', 8)
  await settle()
  net.online = true
  const stuckClip = await idOf('B1')
  video.failUploads.add(stuckClip)
  await flushVideoQueue()
  ok('a clip that fails with the server answering: the clips behind it still go', (await left('B2')) === 0 && (await left('B3')) === 0)
  ok('…and it stays queued, still only "waiting"', (await left('B1')) === 1 && !(await queuedJobVideos('B1'))[0].stuck)
  const reportedBeforeStuck = reported.length
  await flushVideoQueue()
  ok('…no report at two tries', reported.length === reportedBeforeStuck)
  await flushVideoQueue()
  ok('…three tries: the crew are told', (await queuedJobVideos('B1'))[0].stuck === true && !(await queuedJobVideos('B1'))[0].failing)
  ok('…the reason reaches the error log, naming the clip', reported.length === reportedBeforeStuck + 1 && reported[reported.length - 1].includes(stuckClip) && /Network request failed/.test(reported[reported.length - 1]))
  await flushVideoQueue({ force: true })
  ok('…reported once', reported.length === reportedBeforeStuck + 1)
  const uploadsBeforeWait = video.uploads.length
  await flushVideoQueue()
  ok('…it waits between tries now', video.uploads.length === uploadsBeforeWait)
  net.online = false
  await save('B4', 'after', 20)
  await settle()
  net.online = true
  await flushVideoQueue()
  ok('…and a new clip goes straight past it', (await left('B4')) === 0)
  video.failUploads.delete(stuckClip)
  await flushVideoQueue({ force: true })
  ok('Retry: it lands once the trouble clears', (await left('B1')) === 0)

  // ── Real no signal still stops the pass ──────────────────────────────────
  net.online = false
  await save('N1', 'after', 20)
  await save('N2', 'after', 20)
  await settle()
  const uploadsOffline = video.uploads.length
  await flushVideoQueue()
  ok('no signal, token lapsed: nothing is tried, and nothing counts against a clip', video.uploads.length === uploadsOffline)
  // Token still good, signal gone: the upload fails and so does the check.
  video.tokenOffline = true
  const n1 = await idOf('N1')
  video.failUploads.add(n1)
  video.failUploads.add(await idOf('N2'))
  await flushVideoQueue()
  ok('no signal, token good: one upload is tried, then the pass stops', video.uploads.length === uploadsOffline + 1)
  await flushVideoQueue()
  await flushVideoQueue()
  await flushVideoQueue()
  ok('…however many passes, no signal never counts against a clip', !(await queuedJobVideos('N1'))[0].stuck)
  video.tokenOffline = false
  video.failUploads.clear()
  net.online = true
  await flushVideoQueue()
  ok('…signal back: they go', (await left('N1')) === 0 && (await left('N2')) === 0)

  // ── A path from before iOS moved the app's folder ────────────────────────
  net.online = false
  await save('P1', 'before', 40)
  await settle()
  const raw = await AsyncStorage.getItem('rinsebase.videoQueue.v1')
  await AsyncStorage.setItem('rinsebase.videoQueue.v1', raw!.replace(/file:\/\/\/doc\/pending_videos\//g, 'file:///old-folder/doc/pending_videos/'))
  ok('(the stored path is stale)', (await AsyncStorage.getItem('rinsebase.videoQueue.v1'))!.includes('old-folder'))
  net.online = true
  await flushVideoQueue()
  ok('a clip stored under the old folder uploads from today\'s', (await left('P1')) === 0)

  // ── The file is gone ─────────────────────────────────────────────────────
  net.online = false
  await save('G1', 'before', 40)
  await save('G2', 'after', 40)
  await settle()
  net.online = true
  const gone = await idOf('G1')
  video.missingFiles.add(gone)
  const reportedBeforeGone = reported.length
  const uploadsBeforeGone = video.uploads.length
  await flushVideoQueue()
  ok('a missing file: no upload is tried for it', !video.uploads.slice(uploadsBeforeGone).some(u => u.includes(gone)))
  ok('…the clip behind it goes', (await left('G2')) === 0)
  ok('…it stays listed, and the crew are told', (await queuedJobVideos('G1'))[0].fileGone === true)
  ok('…reported', reported.length === reportedBeforeGone + 1 && reported[reported.length - 1].includes(gone))
  await flushVideoQueue()
  ok('…once', reported.length === reportedBeforeGone + 1)
  video.missingFiles.delete(gone)
  await flushVideoQueue()
  ok('…and if the file is back, it goes', (await left('G1')) === 0)

  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nAll required-video invariants hold.')
})()
