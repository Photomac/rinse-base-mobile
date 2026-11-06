// The inspection walkthrough's questions and clips, on the inspector's phone.
// Run with: node scripts/test-inspection-questions.mjs
//
// The REAL outbox.ts and videoQueue.ts over a fake network, with the REAL
// rules (lib/lineAnswers, lib/lineVideos, lib/walkthrough, lib/inspectionFiling):
// filing is refused while a must-answer question has no answer or a required
// clip isn't recorded, an answer given in a dead spot counts the moment it's
// queued (the card lays it over its saved copy), and a clip still on this
// phone counts once it runs 3 seconds.
import { writeThrough, flushOutbox, pendingOpCount, overlayPending } from '../outbox'
import { enqueueVideo, queuedJobVideos } from '../videoQueue'
import { answerWrite, normaliseAnswer } from '../lineAnswers'
import { lineAskRows, lineClipStates } from '../lineVideos'
import { sectionState, groupWalkthrough, type WalkthroughLine } from '../walkthrough'
import { filingGaps, hasFilingGaps } from '../inspectionFiling'
import { net } from './lineVideos.mocks'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  (${detail})`}`)
  if (!cond) failures++
}
const settle = () => new Promise(r => setTimeout(r, 10))
const AT = '2026-11-06T22:00:00.000Z'

;(globalThis as any).FormData = class { parts: any = {}; append(k: string, v: any) { this.parts[k] = v } }
;(globalThis as any).fetch = async (url: string) => {
  if (!net.online) throw new TypeError('Network request failed')
  return { ok: true, status: 200, text: async () => '' }
}

// The visit as the card reads it: the lines (wtlines), and what each asks (wtasks).
const LINES: WalkthroughLine[] = [
  { id: 'c1', room: 'Bathroom', task: 'Mirror streak-free', sort_order: 20001, result: null, issue_note: null, photo_required: false, follow_up: null, info_key: null },
  { id: 'q1', room: 'Bathroom', task: 'Any water spots on the shower glass?', sort_order: 20002, result: null, issue_note: null, photo_required: false, follow_up: null, info_key: null },
  { id: 'q2', room: 'Kitchen', task: 'Inventory count of forks', sort_order: 20003, result: null, issue_note: null, photo_required: false, follow_up: null, info_key: null },
  { id: 'v1', room: 'Kitchen', task: 'Video of any errors', sort_order: 20004, result: null, issue_note: null, photo_required: false, follow_up: null, info_key: null },
  { id: 'q3', room: 'Outside', task: 'What errors were found?', sort_order: 20005, result: null, issue_note: null, photo_required: false, follow_up: null, info_key: null },
]
const ASKS = [
  { id: 'q1', answer_type: 'yes_no', video_mode: 'off', flag_answer: 'yes', level: 'required', answer: null, job_videos: [], job_videos_on_the_way: [] },
  { id: 'q2', answer_type: 'number', video_mode: 'off', flag_answer: null, level: 'required', answer: null, job_videos: [], job_videos_on_the_way: [] },
  { id: 'v1', answer_type: 'tick', video_mode: 'required', flag_answer: null, level: 'guidance', answer: null, job_videos: [], job_videos_on_the_way: [] },
  { id: 'q3', answer_type: 'text', video_mode: 'optional', flag_answer: null, level: 'guidance', answer: null, job_videos: [], job_videos_on_the_way: [] },
]
/** What the card shows: the saved asks with queued answers laid over them, merged into the lines. */
async function cardNow(job: string) {
  const asked = lineAskRows(await overlayPending('job_checklist_items', ASKS, () => false))
  const lines = LINES.map(r => {
    const a = asked.asks.get(r.id)
    return a ? { ...r, answer_type: a.answer_type, answer: a.answer, level: a.level, video_mode: a.video_mode, flag_answer: a.flag_answer } : r
  })
  const queued = (await queuedJobVideos(job)).filter(v => v.video_type === 'line')
  return { lines, clips: lineClipStates(asked.server, queued) }
}

;(async () => {
  // ── Before anything is answered ──────────────────────────────────────────
  net.online = true
  net.answering = true
  let card = await cardNow('INS')
  let gaps = filingGaps(card.lines, card.clips)
  ok('filing is refused: both must-answer questions and the required clip are named',
    hasFilingGaps(gaps) && JSON.stringify(gaps) === JSON.stringify({
      questions: ['Bathroom · Any water spots on the shower glass?', 'Kitchen · Inventory count of forks'],
      clips: ['Kitchen · Video of any errors'],
    }), JSON.stringify(gaps))
  ok('…an optional question or an optional clip never holds it up', !gaps.questions.some(q => q.includes('errors were found')) && !gaps.clips.some(c => c.includes('errors were found')))
  const bath = groupWalkthrough(card.lines).find(s => s.name === 'Bathroom')!
  ok('"Looks good" in the Bathroom would answer the check, never the question', JSON.stringify(sectionState(bath).open) === JSON.stringify(['c1']))

  // ── In a dead spot: answers queue, and count at once ─────────────────────
  net.online = false
  net.answering = false
  const yes = await writeThrough({ table: 'job_checklist_items', op: 'update', match: { id: 'q1' }, values: answerWrite('yes', 'insp-1', AT) })
  const typed = normaliseAnswer('number', '24')
  const forks = await writeThrough({ table: 'job_checklist_items', op: 'update', match: { id: 'q2' }, values: answerWrite(typed.ok ? typed.value : null, 'insp-1', AT) })
  ok('no signal: both answers queue', yes.queued && forks.queued && (await pendingOpCount()) === 2)
  card = await cardNow('INS')
  gaps = filingGaps(card.lines, card.clips)
  ok('…and count for filing at once: only the clip is still named', JSON.stringify(gaps) === JSON.stringify({ questions: [], clips: ['Kitchen · Video of any errors'] }), JSON.stringify(gaps))
  ok('…the Bathroom reads 2 of 2 answered once its check is marked', (() => {
    const s = groupWalkthrough(card.lines.map(l => (l.id === 'c1' ? { ...l, result: 'ok' as const } : l))).find(x => x.name === 'Bathroom')!
    const st = sectionState(s)
    return st.answered === 2 && st.done && st.open.length === 0
  })())

  // ── The clip: too short doesn't count, 3 seconds does ────────────────────
  await enqueueVideo({ uri: 'file:///cache/v1a.mp4', tenant_id: 'T', job_id: 'INS', user_id: 'insp-1', video_type: 'line', duration_seconds: 2, recorded_at: AT, checklist_item_id: 'v1', caption: 'Kitchen · Video of any errors' })
  card = await cardNow('INS')
  ok('a 2-second clip on the phone doesn\'t count', hasFilingGaps(filingGaps(card.lines, card.clips)))
  await enqueueVideo({ uri: 'file:///cache/v1b.mp4', tenant_id: 'T', job_id: 'INS', user_id: 'insp-1', video_type: 'line', duration_seconds: 6, recorded_at: AT, checklist_item_id: 'v1', caption: 'Kitchen · Video of any errors' })
  card = await cardNow('INS')
  ok('a 6-second clip still on the phone does: nothing left, filing goes ahead', !hasFilingGaps(filingGaps(card.lines, card.clips)), JSON.stringify(filingGaps(card.lines, card.clips)))

  // ── Signal back: the answers are delivered as the inspector's own ────────
  net.online = true
  net.answering = true
  await flushOutbox()
  await settle()
  const sent = net.applied.filter(a => a.table === 'job_checklist_items' && a.op === 'update')
  ok('signal back: both answers delivered, completed by the inspector (the database\'s hour after filing keys on that)',
    (await pendingOpCount()) === 0
    && sent.some(a => a.filters.includes('id=eq.q1') && a.values.answer === 'yes' && a.values.completed === true && a.values.completed_by === 'insp-1')
    && sent.some(a => a.filters.includes('id=eq.q2') && a.values.answer === '24' && a.values.completed === true))

  // ── Cleared again: the question is owed again ────────────────────────────
  await writeThrough({ table: 'job_checklist_items', op: 'update', match: { id: 'q1' }, values: answerWrite(null, 'insp-1', AT) })
  card = await cardNow('INS')
  ok('a cleared answer: the question is named again (completed back to false)',
    filingGaps(card.lines, card.clips).questions.includes('Bathroom · Any water spots on the shower glass?')
    && net.applied.some(a => a.filters.includes('id=eq.q1') && a.values.answer === null && a.values.completed === false && a.values.completed_by === null))

  // ── Before the migrations: the asks read fails ───────────────────────────
  const before = lineAskRows({ code: '42703', message: 'column job_checklist_items.answer_type does not exist' })
  const plain = LINES.map(r => r)
  ok('no asks (a database before the migrations): every line a check, nothing holds filing',
    before.asks.size === 0 && !hasFilingGaps(filingGaps(plain, before.server)))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  if (failures) process.exit(1)
})()
