// src/lib/videosOwed.ts
// A company can require the crew's walkthrough videos before a clean can be
// completed (CKS Perfections, 2026-10-29; rinse-base-app migration
// 20261030180000_walkthrough_videos_required). The server decides what a clean
// owes (job_videos_owed; the gate's codes no_arrival_video, no_finished_video):
// it counts a clip from the moment a phone says it recorded one
// (job_videos_on_the_way, sent by lib/videoQueue), so nobody waits on an upload
// that can take hours. This reads its answers, and takes off what's still on
// this phone when the phone has no answer.
//
// Pure: no imports but a type, so the test runner can load it as is.
import type { WalkthroughType } from './videoQueue'

/** Shorter than this doesn't count (the server's rule too), so a stray tap can't clear the gate. */
export const WALKTHROUGH_MIN_SECONDS = 10

/** The gate's blockers that name a video, as video types: arrival first. */
export function videosInBlockers(blockers: { code?: string | null }[] | null | undefined): WalkthroughType[] {
  const list = blockers ?? []
  return [
    ...(list.some(b => b?.code === 'no_arrival_video') ? ['before' as const] : []),
    ...(list.some(b => b?.code === 'no_finished_video') ? ['after' as const] : []),
  ]
}

/** The videos a refused Complete names ('RB_BLOCKED: [{"code":…}]', the gate on the server), arrival first. */
export function videosInRefusal(message: string | null | undefined): WalkthroughType[] {
  const m = /^RB_BLOCKED: (\[[\s\S]*\])$/.exec(message ?? '')
  if (!m) return []
  try { return videosInBlockers(JSON.parse(m[1])) } catch { return [] }
}

/** job_videos_owed's rows as video types, arrival first. No answer: nothing owed (the server still decides). */
export function videosFromOwedRows(rows: unknown): WalkthroughType[] {
  const list = Array.isArray(rows) ? rows : []
  const has = (t: WalkthroughType) => list.some((r: any) => r?.video_type === t)
  return (['before', 'after'] as const).filter(has)
}

/** What's owed, less the clips of that type on this phone long enough to count. */
export function videosStillOwed(owed: WalkthroughType[], onPhone: { video_type: WalkthroughType; duration_seconds: number }[]): WalkthroughType[] {
  return owed.filter(t => !onPhone.some(v => v.video_type === t && v.duration_seconds >= WALKTHROUGH_MIN_SECONDS))
}

type Clip = { video_type: string | null; duration_seconds: number | null }

/**
 * Does the clean have an arrival video, by the server's rule (10 seconds or more)?
 * Landed, announced by a phone, or still on this one. Each list is null when it
 * couldn't be read: one that has it is still an answer, otherwise null is "unknown".
 */
export function arrivalOnClean(lists: (Clip[] | null)[]): boolean | null {
  const counts = (v: Clip) => v.video_type === 'before' && (v.duration_seconds ?? 0) >= WALKTHROUGH_MIN_SECONDS
  if (lists.some(l => l?.some(counts))) return true
  return lists.some(l => l === null) ? null : false
}
