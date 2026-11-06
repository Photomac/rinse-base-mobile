// src/lib/inspectionFiling.ts
// What still stands between an inspection visit and its filing (rinse-base-app
// 20261106230000_inspection_walkthrough_questions): a walkthrough question that
// must be answered and has no answer, or a required video clip not recorded
// (landed, on its way from a crew phone, or still in this phone's queue), 3
// seconds or more, as phase 1's gate counts a clip. The database doesn't gate
// filing (its completion gate doesn't run for inspection visits), so the app
// refuses, matching the web's src/lib/inspectionFiling.ts (filingGapsFrom).
//
// No walkthrough asks (the read failed, or the migrations aren't applied):
// nothing to say, and filing goes ahead as it always has.
//
// Pure: no imports but types, so the test runner can load it as is.
import type { LineClipState } from './lineVideos'

export interface FilingLine {
  id: string
  room: string | null
  task: string
  answer_type?: string | null
  level?: string | null
  answer?: string | null
  video_mode?: string | null
}

export interface FilingGaps {
  /** Must-answer questions with no answer: "Room · task". */
  questions: string[]
  /** Required clips not recorded: "Room · task". */
  clips: string[]
}

const label = (l: FilingLine) => [l.room?.trim(), l.task].filter(Boolean).join(' · ')

/** The gaps, from the card's lines and each line's clip state (landed, sending
 *  from any phone, or queued here: lib/lineVideos lineClipStates). */
export function filingGaps(lines: FilingLine[], clips: Record<string, LineClipState>): FilingGaps {
  return {
    questions: lines.filter(l => (l.answer_type ?? 'tick') !== 'tick' && l.level === 'required' && (l.answer ?? '').trim() === '').map(label),
    clips: lines.filter(l => l.video_mode === 'required' && !clips[l.id]).map(label),
  }
}

export function hasFilingGaps(g: FilingGaps | null | undefined): boolean {
  return !!g && (g.questions.length > 0 || g.clips.length > 0)
}
