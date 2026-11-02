// Answering a flagged line with anything else drops the flag and its words, and
// one stray tap on the pressed Issue button was enough (CKS, 2026-10-23). The
// person is asked first when there are words to lose. A flag with none has
// nothing to lose, so it clears as it always did.
//
// No imports, so scripts/test-issue-note-guard.mjs can run it as is.

export type LineAnswer = 'ok' | 'issue' | 'na' | null

/** The words this answer would delete; null when nothing would be lost. */
export function noteAtRisk(current: string | null | undefined, next: LineAnswer, note: string | null | undefined): string | null {
  if (current !== 'issue' || next === 'issue') return null
  return (note ?? '').trim() || null
}
