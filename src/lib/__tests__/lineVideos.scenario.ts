// A checklist line that asks for a video clip or a question, on the phone.
// Run with: node scripts/test-line-videos.mjs
//
// The REAL videoQueue.ts beside the REAL outbox.ts, and the REAL lineAnswers /
// lineVideos rules. An answer is written through the outbox like a tick (it
// completes the line; clearing it unticks it), holds with no signal, and the
// card shows it before it's delivered. A line clip goes up through
// the walkthrough videos' queue as video_type 'line' with its line's id: the
// record names the line (that's what lets the server count it for the line),
// the row carries the line and its caption, and a walkthrough clip is sent
// exactly as before. A line deleted while its clip waited for signal doesn't
// strand the clip: it goes on without the line.
import { enqueueVideo, flushVideoQueue, queuedJobVideos } from '../videoQueue'
import { writeThrough, flushOutbox, pendingOpCount, overlayPending } from '../outbox'
import { answerWrite, normaliseAnswer } from '../lineAnswers'
import { lineAskRows } from '../lineVideos'
import { net, video, lines } from './lineVideos.mocks'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const settle = () => new Promise(r => setTimeout(r, 10))
const AT = '2026-11-06T15:00:00.000Z'
const saveLine = (job: string, line: string, secs = 8) => enqueueVideo({
  uri: `file:///cache/${job}-${line}.mp4`, tenant_id: 'T', job_id: job, user_id: 'U', video_type: 'line',
  duration_seconds: secs, recorded_at: AT, checklist_item_id: line, caption: `Bathroom · ${line}`,
})
const saveWalkthrough = (job: string) => enqueueVideo({
  uri: `file:///cache/${job}-walk.mp4`, tenant_id: 'T', job_id: job, user_id: 'U', video_type: 'after', duration_seconds: 40, recorded_at: AT,
})
const rows = (table: string, job: string) => net.applied.filter(a => a.table === table)
  .flatMap(a => (Array.isArray(a.values) ? a.values : [a.values])).filter((r: any) => r?.job_id === job)

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
  net.online = true

  // ── A line clip and a walkthrough clip on the same clean ─────────────────
  await saveLine('J1', 'LINE1')
  await saveWalkthrough('J1')
  await settle()
  const recs = rows('job_videos_on_the_way', 'J1')
  const lineRec: any = recs.find((r: any) => r.video_type === 'line')
  const walkRec: any = recs.find((r: any) => r.video_type === 'after')
  ok('the line clip\'s record names its line, as a line clip', !!lineRec && lineRec.checklist_item_id === 'LINE1' && lineRec.duration_seconds === 8)
  ok('…and carries only the record\'s columns (no caption: the record has none)', !!lineRec && !('caption' in lineRec))
  ok('a walkthrough record is sent as before: no checklist_item_id key at all', !!walkRec && !('checklist_item_id' in walkRec))
  const queued = await queuedJobVideos('J1')
  ok('this phone lists the line clip with its line', queued.some(v => v.video_type === 'line' && v.checklist_item_id === 'LINE1'))
  ok('…and the walkthrough clip with none', queued.some(v => v.video_type === 'after' && v.checklist_item_id === null))

  await flushVideoQueue()
  await settle()
  ok('the line clip uploads under line_, the walkthrough under walkthrough_',
    video.uploads.some(u => u.includes('/T/J1/line_')) && video.uploads.some(u => u.includes('/T/J1/walkthrough_')))
  const landed = rows('job_videos', 'J1')
  const lineRow: any = landed.find((r: any) => r.video_type === 'line')
  const walkRow: any = landed.find((r: any) => r.video_type === 'after')
  ok('the line clip lands with its line and caption', !!lineRow && lineRow.checklist_item_id === 'LINE1' && lineRow.caption === 'Bathroom · LINE1')
  ok('…its storage path in the clean\'s folder', !!lineRow && String(lineRow.storage_path).startsWith('T/J1/line_'))
  ok('a walkthrough row is sent as before: neither key', !!walkRow && !('checklist_item_id' in walkRow) && !('caption' in walkRow))
  ok('both landed: nothing left on the phone', (await queuedJobVideos('J1')).length === 0)

  // ── The line was deleted while the clip waited ───────────────────────────
  lines.gone.add('LINE2')
  await saveLine('J2', 'LINE2')
  await settle()
  const j2recs: any[] = rows('job_videos_on_the_way', 'J2')
  ok('the record naming a deleted line is refused (23503) and sent again without it',
    lines.refused.some(([t, id]) => t === 'job_videos_on_the_way' && id === 'LINE2')
    && j2recs.length === 1 && !('checklist_item_id' in j2recs[0]) && j2recs[0].video_type === 'line')
  await flushVideoQueue()
  await settle()
  const j2rows: any[] = rows('job_videos', 'J2')
  ok('the clip itself is refused for the line and lands without it, still a line clip with its caption',
    lines.refused.some(([t, id]) => t === 'job_videos' && id === 'LINE2')
    && j2rows.length === 1 && !('checklist_item_id' in j2rows[0]) && j2rows[0].video_type === 'line' && j2rows[0].caption === 'Bathroom · LINE2')
  ok('…and leaves the phone', (await queuedJobVideos('J2')).length === 0)

  // ── Refused for the line, then the signal drops before the retry's answer ─
  lines.gone.add('LINE3')
  net.beforeWrite = (table, _op, values) => {
    if (table === 'job_videos' && values?.job_id === 'J3') net.loseAcks = 1
  }
  await saveLine('J3', 'LINE3')
  await settle()
  await flushVideoQueue()
  await settle()
  net.beforeWrite = null
  const j3 = await queuedJobVideos('J3')
  ok('the retry\'s answer lost: the clip stays, no longer naming the line', j3.length === 1 && j3[0].checklist_item_id === null && j3[0].video_type === 'line')
  const refusalsBefore = lines.refused.length
  await flushVideoQueue({ force: true })
  await settle()
  const j3rows: any[] = rows('job_videos', 'J3')
  ok('…the next pass sends it without the line straight away (not refused again)',
    lines.refused.length === refusalsBefore && j3rows.length === 2 && j3rows.every(r => !('checklist_item_id' in r)))
  ok('…and it leaves the phone', (await queuedJobVideos('J3')).length === 0)

  // ── No signal: saved, listed with its line, sent once signal returns ─────
  net.online = false
  await saveLine('J4', 'LINE4', 2)
  await saveLine('J4', 'LINE5', 12)
  await settle()
  const j4 = await queuedJobVideos('J4')
  ok('no signal: both clips are on the phone with their lines and lengths',
    j4.length === 2 && j4.some(v => v.checklist_item_id === 'LINE4' && v.duration_seconds === 2) && j4.some(v => v.checklist_item_id === 'LINE5' && v.duration_seconds === 12))
  net.online = true
  await flushVideoQueue()
  await settle()
  const j4recs: any[] = rows('job_videos_on_the_way', 'J4')
  ok('signal back: each record names its line', ['LINE4', 'LINE5'].every(id => j4recs.some(r => r.checklist_item_id === id)))
  ok('…and both clips land', (await queuedJobVideos('J4')).length === 0 && rows('job_videos', 'J4').length === 2)

  // ── Answers: written like a tick, held with no signal ────────────────────
  const answer = (id: string, value: string | null) => writeThrough({
    table: 'job_checklist_items', op: 'update', match: { id }, values: answerWrite(value, 'U', AT),
  })
  const updates = (id: string) => net.applied.filter(a => a.table === 'job_checklist_items' && a.op === 'update' && a.filters.includes(`id=eq.${id}`))
  net.online = true
  net.answering = true
  const yes = await answer('Q1', 'yes')
  ok('online: a Yes is written at once, with the tick', !yes.error && !yes.queued
    && updates('Q1').some(a => a.values.answer === 'yes' && a.values.completed === true && a.values.completed_by === 'U' && a.values.completed_at === AT))
  const cleared = await answer('Q1', null)
  ok('…tapping it again clears the answer and unticks the line', !cleared.error
    && updates('Q1').some(a => a.values.answer === null && a.values.completed === false && a.values.completed_at === null && a.values.completed_by === null))

  net.online = false
  net.answering = false
  const typed = normaliseAnswer('number', ' 3,5 ')
  ok('a number typed with a comma is saved with a point', typed.ok && typed.value === '3.5')
  const offline = await answer('Q2', typed.ok ? typed.value : null)
  ok('no signal: the answer queues instead of failing', !offline.error && offline.queued && (await pendingOpCount()) >= 1)
  const savedCopy = [{ id: 'Q2', video_mode: 'off', answer_type: 'number', answer: null, job_videos: [], job_videos_on_the_way: [] }]
  const shown = lineAskRows(await overlayPending('job_checklist_items', savedCopy, () => false))
  ok('…the card shows it over the saved copy before it\'s delivered', shown.asks.get('Q2')?.answer === '3.5')
  const before = updates('Q2').length
  net.online = true
  net.answering = true
  await flushOutbox()
  await settle()
  ok('signal back: it\'s delivered, with the tick', updates('Q2').length === before + 1
    && updates('Q2').some(a => a.values.answer === '3.5' && a.values.completed === true) && (await pendingOpCount()) === 0)
  const bad = normaliseAnswer('number', '3.12345')
  ok('a number the server would refuse is never sent', !bad.ok)

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  if (failures) process.exit(1)
})()
