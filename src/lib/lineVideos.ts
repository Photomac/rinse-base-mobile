// src/lib/lineVideos.ts
// A checklist line can ask for a video clip, as it can ask for a photo
// (Five Star Hospitality, 2026-11-06; rinse-base-app migration
// 20261106190000_checklist_line_videos). The office marks the line; the crew
// record the clip from the line itself, in the app (WalkthroughScreen's line
// mode), and it goes up through the walkthrough videos' queue (lib/videoQueue)
// as video_type 'line' with the line's id.
//
// The server's gate (missing_required_video) counts a clip for the line from
// the moment a crew phone says it saved one (job_videos_on_the_way), as for
// walkthrough videos, and only one that runs 3 seconds or more. A line clip is
// never a walkthrough video, and a walkthrough video never answers a line.
//
// Pure: no imports, so the test runner can load it as is.

/** Shorter than this doesn't count (the server's rule too): a stray tap. A door-lock clip is short. */
export const LINE_CLIP_MIN_SECONDS = 3
/** A line clip is one room or one thing: a minute is plenty (walkthroughs get two). */
export const LINE_CLIP_MAX_SECONDS = 60

/** uploaded: a clip landed. sending: one is on its way (this phone's queue, or a phone told the server). */
export type LineClipState = 'uploaded' | 'sending'

type Clip = { duration_seconds?: number | null }
const counts = (c: Clip | null | undefined) => (c?.duration_seconds ?? 0) >= LINE_CLIP_MIN_SECONDS

/** "Bathroom · Whole view of the bathroom", at most 300 characters (the server's cap). */
export function lineClipCaption(room: string | null | undefined, title: string | null | undefined): string {
  return [room, title].map(s => (s ?? '').trim()).filter(Boolean).join(' · ').slice(0, 300)
}

/**
 * The clean's video lines from lib/jobReads lineVideosRead: each line that asks
 * for a clip, with the clips the server has (landed, and on their way). Not an
 * array (the read failed, or the server predates the migration): no video lines.
 */
export function lineVideoRows(rows: unknown): { lines: Set<string>; server: Record<string, LineClipState> } {
  const lines = new Set<string>()
  const server: Record<string, LineClipState> = {}
  if (!Array.isArray(rows)) return { lines, server }
  for (const r of rows as any[]) {
    if (!r?.id) continue
    lines.add(r.id)
    const landed = Array.isArray(r.job_videos) ? r.job_videos : []
    const onTheWay = Array.isArray(r.job_videos_on_the_way) ? r.job_videos_on_the_way : []
    if (landed.some(counts)) server[r.id] = 'uploaded'
    else if (onTheWay.some(counts)) server[r.id] = 'sending'
  }
  return { lines, server }
}

/** The server's states, with the clips still on this phone laid over them (a landed clip wins). */
export function lineClipStates(
  server: Record<string, LineClipState>,
  queued: { checklist_item_id?: string | null; video_type: string; duration_seconds: number }[],
): Record<string, LineClipState> {
  const out: Record<string, LineClipState> = { ...server }
  for (const q of queued) {
    if (q.video_type !== 'line' || !q.checklist_item_id || !counts(q)) continue
    if (out[q.checklist_item_id] !== 'uploaded') out[q.checklist_item_id] = 'sending'
  }
  return out
}

/** Does this phone hold a clip for the line long enough to count? */
export function lineClipOnPhone(lineId: string, queued: { checklist_item_id?: string | null; video_type: string; duration_seconds: number }[]): boolean {
  return queued.some(q => q.video_type === 'line' && q.checklist_item_id === lineId && counts(q))
}

export interface VideoLineBlocker { checklist_item_id: string | null; room: string | null; task: string | null }

/** The gate's blockers that name a line still owed a clip. */
export function videoLinesInBlockers(blockers: { code?: string | null; checklist_item_id?: string | null; room?: string | null; task?: string | null }[] | null | undefined): VideoLineBlocker[] {
  return (blockers ?? [])
    .filter(b => b?.code === 'missing_required_video')
    .map(b => ({ checklist_item_id: b.checklist_item_id ?? null, room: b.room ?? null, task: b.task ?? null }))
}

/** The lines a refused Complete names ('RB_BLOCKED: [{"code":…}]', the gate on the server). */
export function videoLinesInRefusal(message: string | null | undefined): VideoLineBlocker[] {
  const m = /^RB_BLOCKED: (\[[\s\S]*\])$/.exec(message ?? '')
  if (!m) return []
  try { return videoLinesInBlockers(JSON.parse(m[1])) } catch { return [] }
}

/**
 * With no answer from the gate: the phone's own copy of the lines that ask for a
 * clip and have none anywhere it knows of. A Complete queued past one would be
 * refused when it lands, with the crew long gone.
 */
export function videoLinesMissing<T extends { jobItemId?: string | null; requires_video?: boolean }>(
  items: T[], states: Record<string, LineClipState>,
): T[] {
  return items.filter(i => !!i.requires_video && !!i.jobItemId && !states[i.jobItemId])
}
