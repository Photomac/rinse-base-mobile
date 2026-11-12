// A video on an incident report, on the phone (CKS 2026-11-12).
// Run with: node scripts/test-report-videos.mjs
//
// The REAL videoQueue.ts beside the REAL outbox.ts. A report clip goes up
// through the walkthrough videos' queue as video_type 'report' with its
// report's id: its file is named report_<id>, the server is never told it's on
// its way (it's no walkthrough and never counts as one), it isn't listed among
// the clean's walkthrough clips, and its row goes to incident_report_videos.
// While its report is still in the outbox (23503) it waits without counting as
// a failure; a lost answer (23505 on the retry) is taken as landed; a refusal
// stops holding the report's heads-up.
import { enqueueVideo, flushVideoQueue, queuedJobVideos, pendingReportVideos } from '../videoQueue'
import { net, video, reports } from './reportVideos.mocks'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const settle = () => new Promise(r => setTimeout(r, 10))
const AT = '2026-11-12T15:00:00.000Z'
const saveReportClip = (job: string, report: string, secs = 12) => enqueueVideo({
  uri: `file:///cache/${job}-${report}.mov`, tenant_id: 'T', job_id: job, user_id: 'U', video_type: 'report',
  duration_seconds: secs, recorded_at: AT, incident_report_id: report,
})
const records = () => net.applied.filter(a => a.table === 'job_videos_on_the_way')
  .flatMap(a => (Array.isArray(a.values) ? a.values : [a.values]))

;(globalThis as any).FormData = class { parts: any = {}; append(k: string, v: any) { this.parts[k] = v } }
;(globalThis as any).fetch = async (url: string) => {
  if (url.includes('/auth/v1/health')) {
    if (!net.online) throw new TypeError('Network request failed')
    return { ok: true, status: 200, text: async () => '' }
  }
  if (!net.online) throw new TypeError('Network request failed')
  video.uploads.push(url)
  return { ok: true, status: 200, text: async () => '' }
}

;(async () => {
  // ── Saved with no signal ────────────────────────────────────────────────
  net.online = false
  await saveReportClip('J1', 'R1', 42.4)
  await settle()
  ok('a report clip is waiting on the phone: it holds its report\'s heads-up', await pendingReportVideos('R1') === 1)
  ok('…not another report\'s', await pendingReportVideos('R2') === 0)
  ok('…and it isn\'t listed with the clean\'s walkthrough or line clips', (await queuedJobVideos('J1')).length === 0)

  // ── Signal back, the report still in the outbox ─────────────────────────
  net.online = true
  await settle()
  ok('the server is never told a report clip is on its way (it counts toward no required video)', records().length === 0)
  const first = await flushVideoQueue({ force: true })
  ok('its file goes up into the clean\'s folder, named report_<id>.mov', video.uploads.length === 1 && /\/job-videos\/T\/J1\/report_[0-9a-f-]+\.mov$/.test(video.uploads[0]))
  ok('…its row is refused while the report isn\'t on the server (23503): the clip stays, still holding the heads-up',
    first.remaining === 1 && reports.inserts.length === 1 && await pendingReportVideos('R1') === 1)
  await flushVideoQueue()
  ok('…and it goes again on the next pass without waiting out a backoff (the file isn\'t sent twice)', reports.inserts.length === 2 && video.uploads.length === 1)

  // ── The report lands ────────────────────────────────────────────────────
  reports.landed.add('R1')
  const second = await flushVideoQueue()
  const row = reports.inserts[reports.inserts.length - 1]
  ok('the report on the server: the row lands, the queue is empty, the heads-up may go', second.uploaded === 1 && second.remaining === 0 && await pendingReportVideos('R1') === 0)
  ok('…the row: its id is the queue entry\'s, its report, clean, uploader, file, length and time',
    !!row && row.report_id === 'R1' && row.job_id === 'J1' && row.user_id === 'U' && row.tenant_id === 'T'
    && /^T\/J1\/report_/.test(row.storage_path) && row.video_url === `https://x/${row.storage_path}` && row.mime_type === 'video/mp4'
    && row.duration_seconds === 42 && row.recorded_at === AT && row.storage_path.includes(row.id))
  ok('…and no job_videos row: a report clip is never a walkthrough', !net.applied.some(a => a.table === 'job_videos'))

  // ── A lost answer ───────────────────────────────────────────────────────
  reports.landed.add('R2')
  await saveReportClip('J1', 'R2')
  reports.loseNext = true
  await flushVideoQueue({ force: true })
  ok('the row landed but its answer was lost: the clip stays for another try', await pendingReportVideos('R2') === 1)
  const after = await flushVideoQueue({ force: true })
  ok('…the retry is a duplicate (23505), taken as landed', after.remaining === 0 && await pendingReportVideos('R2') === 0)

  // ── Refused by the row rules (past the filer's 24 hours) ────────────────
  reports.landed.add('R3'); reports.refused.add('R3')
  await saveReportClip('J1', 'R3')
  const refused = await flushVideoQueue({ force: true })
  ok('a refused row: the clip is kept (evidence), but no longer holds the report\'s heads-up', refused.remaining === 1 && await pendingReportVideos('R3') === 0)

  // ── A walkthrough clip is unchanged ─────────────────────────────────────
  await enqueueVideo({ uri: 'file:///cache/J2-walk.mp4', tenant_id: 'T', job_id: 'J2', user_id: 'U', video_type: 'after', duration_seconds: 40, recorded_at: AT })
  await settle()
  ok('a walkthrough clip is still announced and listed as before', records().some((r: any) => r.job_id === 'J2' && r.video_type === 'after') && (await queuedJobVideos('J2')).length === 1)

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  if (failures) process.exit(1)
})()
