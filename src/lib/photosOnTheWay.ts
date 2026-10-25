// src/lib/photosOnTheWay.ts
// Telling the server a photo is on its way, and what its answer to a Complete
// means (rinse-base-app migration 20261025160000_photos_on_the_way).
//
// Why (2026-10-25, Celebrity Clean): a lead whose clean waited only on a
// TEAMMATE's shots, still uploading from the teammate's phone on one bar, got
// "Photo required: Kitchen…" and couldn't complete until they landed, hours
// later sometimes. The lead's phone can't see another phone's queue, so each
// phone now tells the server about every photo it takes, at capture: a row in
// job_photos_on_the_way, a few hundred bytes that get through long before the
// 2 MB file. When the gate names blockers, the Complete asks the server
// (complete_when_photos_land), which knows every phone's photos: if each
// blocker is a photo on its way, the clean is held there, every clock on it
// closes, and the server completes it with the lead's tap the moment the last
// photo lands. Nothing completes without the photos on file; a record only
// says "on its way".
//
// Pure: no imports, so the scenario runner can load it as is.

/** A queued photo, as photoQueue keeps it (the fields a record carries). */
export interface QueuedForRecord {
  fileName: string
  photo_type: string
  caption: string | null
  checklist_item_id?: string | null
  photo_requirement_id?: string | null
  check_first_line_id?: string | null
  taken_at?: number | null
}

/** The record's columns (job_photos_on_the_way), or a p_on_phone entry for the
 *  Complete. object_name: where the file will be saved in storage; the landing
 *  job_photos row is matched on it. */
export interface OnTheWayRow {
  object_name: string
  photo_type: string
  caption: string | null
  checklist_item_id: string | null
  photo_requirement_id: string | null
  check_first_line_id: string | null
  taken_at: string | null
}

export function onTheWayRow(p: QueuedForRecord): OnTheWayRow {
  return {
    object_name: p.fileName,
    photo_type: p.photo_type,
    caption: p.caption,
    checklist_item_id: p.checklist_item_id ?? null,
    photo_requirement_id: p.photo_requirement_id ?? null,
    check_first_line_id: p.check_first_line_id ?? null,
    taken_at: p.taken_at != null && Number.isFinite(p.taken_at) ? new Date(p.taken_at).toISOString() : null,
  }
}

/** Whose phone a held clean waits on, as the server says (waiting_on). */
export interface WaitingOn { user_id: string; name: string | null; photos: number; first_taken_at?: string | null }

/** The server's answer to a Complete the gate named blockers for. */
export type HoldAnswer<B> =
  /** Nothing blocks any more: complete as usual. */
  | { kind: 'clear' }
  /** These no photo on its way answers: named, as before. */
  | { kind: 'blocked'; blockers: B[] }
  /** (Asked without holding.) Everything left is on its way. */
  | { kind: 'would_hold'; waitingOn: WaitingOn[] }
  /** Held: the clean completes when the photos land; every clock on it is closed. */
  | { kind: 'held'; completed: boolean; waitingOn: WaitingOn[] }
  /** No answer: no signal, or a server without the function yet. As before #212's rules. */
  | { kind: 'unavailable' }

export function readHoldAnswer<B>(data: any, error: any): HoldAnswer<B> {
  if (error || !data || typeof data !== 'object') return { kind: 'unavailable' }
  const waitingOn: WaitingOn[] = Array.isArray(data.waiting_on) ? data.waiting_on : []
  switch (data.result) {
    case 'clear': return { kind: 'clear' }
    case 'blocked': return Array.isArray(data.blockers) && data.blockers.length > 0
      ? { kind: 'blocked', blockers: data.blockers }
      : { kind: 'unavailable' }
    case 'would_hold': return { kind: 'would_hold', waitingOn }
    case 'held': return { kind: 'held', completed: data.completed === true, waitingOn }
    default: return { kind: 'unavailable' }
  }
}

/** For the crew: the teammates whose phones the clean waits on (first names),
 *  and how many of the photos are on this person's own phone. */
export function whoHasThePhotos(waitingOn: WaitingOn[], me: string | null | undefined): { teammates: string[]; mine: number } {
  const teammates = waitingOn
    .filter(w => w.user_id !== me)
    .map(w => (w.name ?? '').trim().split(/\s+/)[0])
    .filter(Boolean)
  const mine = waitingOn.filter(w => w.user_id === me).reduce((n, w) => n + (Number(w.photos) || 0), 0)
  return { teammates: [...new Set(teammates)], mine }
}
