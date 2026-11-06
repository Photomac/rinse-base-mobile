// src/lib/lineAnswers.ts
// A checklist line can ask a question instead of being ticked (Five Star
// Hospitality, 2026-11-06; rinse-base-app migration
// 20261106190000_checklist_line_videos): job_checklist_items.answer_type
// 'yes_no' | 'text' | 'number' (a question is always a Do line, item_kind
// 'task'). The crew's answer is job_checklist_items.answer; answering is what
// completes the line, so the app writes the answer with the tick, and clearing
// it unticks it. Written through the outbox like a tick, so it survives no signal.
//
// The server refuses (23514) anything but 'yes' / 'no' on a Yes/No line, a
// plain decimal (up to 12 digits, 4 after the point) on a number line, an empty
// answer, and more than 2,000 characters: this keeps the phone from sending one.
// A required question with no answer is the gate's unchecked_required_item,
// where the company holds cleans to their required items.
//
// flag_answer (the office's problem answer) is never shown to the crew.
//
// Pure: no imports, so the test runner can load it as is.

export type QuestionType = 'yes_no' | 'text' | 'number'

/** The server's limit on an answer. */
export const ANSWER_MAX = 2000
/** The server's rule for a number answer (jci_answer_chk). */
export const NUMBER_ANSWER = /^-?[0-9]{1,12}(\.[0-9]{1,4})?$/

/** Is this line a question the crew answers (not a tick)? */
export function questionType(item: { answer_type?: string | null; item_kind?: string | null } | null | undefined): QuestionType | null {
  const t = item?.answer_type
  if (t !== 'yes_no' && t !== 'text' && t !== 'number') return null
  return (item?.item_kind ?? 'task') === 'task' ? t : null
}

export type Normalised = { ok: true; value: string | null } | { ok: false; reason: 'number' | 'yes_no' | 'too_long' }

/**
 * What the crew typed or tapped, as the server will take it. null clears the
 * answer. A number: spaces dropped, a comma read as the decimal point (Spanish
 * and Portuguese keyboards), "+3" "3." ".5" tidied to "3" "3" "0.5".
 */
export function normaliseAnswer(type: QuestionType, raw: string | null | undefined): Normalised {
  if (raw == null) return { ok: true, value: null }
  if (type === 'yes_no') {
    const v = raw.trim().toLowerCase()
    if (v === '') return { ok: true, value: null }
    return v === 'yes' || v === 'no' ? { ok: true, value: v } : { ok: false, reason: 'yes_no' }
  }
  if (type === 'text') {
    const v = raw.trim()
    if (v === '') return { ok: true, value: null }
    return v.length > ANSWER_MAX ? { ok: false, reason: 'too_long' } : { ok: true, value: v }
  }
  let v = raw.replace(/\s+/g, '').replace(',', '.')
  if (v === '') return { ok: true, value: null }
  if (v.startsWith('+')) v = v.slice(1)
  if (v.startsWith('-.')) v = '-0' + v.slice(1)
  else if (v.startsWith('.')) v = '0' + v
  if (v.endsWith('.')) v = v.slice(0, -1)
  return NUMBER_ANSWER.test(v) ? { ok: true, value: v } : { ok: false, reason: 'number' }
}

/** The write for an answer, as a tick writes it: answered = completed, cleared = not. */
export function answerWrite(answer: string | null, userId: string | null | undefined, nowIso: string) {
  return answer == null
    ? { answer: null, completed: false, completed_at: null, completed_by: null }
    : { answer, completed: true, completed_at: nowIso, completed_by: userId ?? null }
}

/**
 * The bullets for Complete's "required items" alert (unchecked_required_item):
 * the rooms of the unticked lines, as before, then "Answer: <question>" for
 * each question still unanswered. A blocker whose line this phone doesn't have
 * counts as a tick in its room.
 */
export function requiredItemBullets<T extends { jobItemId?: string | null; answer_type?: string | null; item_kind?: string | null }>(
  blockers: { checklist_item_id?: string | null; room?: string | null; task?: string | null }[],
  items: T[],
  fmt: { room: (room: string) => string; answer: (item: T | null, task: string) => string },
): string[] {
  const rooms: string[] = []
  const answers: string[] = []
  for (const b of blockers) {
    const item = items.find(i => !!i.jobItemId && i.jobItemId === b.checklist_item_id) ?? null
    if (item && questionType(item)) answers.push(fmt.answer(item, b.task ?? ''))
    else if (b.room) {
      const r = fmt.room(b.room)
      if (r && !rooms.includes(r)) rooms.push(r)
    }
  }
  return [...rooms, ...answers]
}
