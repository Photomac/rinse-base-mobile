// The required shots in a stop's rooms, as the crew sees them: the server's,
// with the ones still on the phone laid over them.
//
// Celebrity Clean, 2026-10-23: "they take a photo and it disappears or doesn't
// load in and they have to try and retake." Since 2026-10-05 a shot uploads in
// the background and the room shows it from its file on the phone. But every
// job_photos change on the clean (a teammate's shot, or this phone's previous
// one landing) reloads the checklist card, and the card built the rooms from
// the server's rows alone. A shot still uploading went back to "Take photo".
// On prod nothing was lost: 241 quick retakes in two weeks, the first shot
// and the retake both saved.
//
// The phone's queue is read twice: before the card's reads go out and after
// they come back. A shot in the second read is still on the phone: its file.
// A shot only in the first landed while the reads were out, so they may not
// have it, and its file is already deleted: its stored copy.
//
// Each shot also says where it stands (Z & K Cleaning, 2026-10-27: "there
// should also be a clear indication that the photo was successfully saved so
// employees aren't left guessing"): saved, on the phone and uploading, on the
// phone and waiting for signal, or refused by the server (take it again).
import { queuedShots, type QueuedShot } from './photoQueue'

export type Queued = Map<string, QueuedShot>

/** Where a shot stands, as its room says it. */
export type ShotState = 'saved' | 'uploading' | 'waiting' | 'failed'

/** A shot to show: `uri` first, `fallback` when that file can't be loaded. */
export interface RoomShot { uri: string; fallback: string | null; state: ShotState }

function queuedState(q: QueuedShot): ShotState {
  return q.refused ? 'failed' : q.waiting ? 'waiting' : 'uploading'
}

/** The phone's required shots for `jobId` now (none when the queue can't be read). */
export function queuedNow(jobId: string): Promise<Queued> {
  return queuedShots(jobId).catch((): Queued => new Map())
}

/** requirement id → the shot to show. `server`: the clean's shot rows, newest
 *  first. `before` / `after`: the queue read before the reads went out and
 *  after they came back. A shot on the phone is newer than any row (a retake
 *  replaces the thumbnail). */
export function roomShots(server: any[], before: Queued, after: Queued): Record<string, RoomShot> {
  const shots: Record<string, RoomShot> = {}
  for (const s of server) {
    if (s?.photo_requirement_id && s.photo_url && !shots[s.photo_requirement_id]) {
      shots[s.photo_requirement_id] = { uri: s.photo_url, fallback: null, state: 'saved' }
    }
  }
  for (const [req, q] of before) if (!after.has(req)) shots[req] = { uri: q.storedUrl, fallback: null, state: 'saved' }
  for (const [req, q] of after) shots[req] = { uri: q.localUri, fallback: q.storedUrl, state: queuedState(q) }
  return shots
}

/** A room's shot row as the stop's screen holds it. */
export interface ShotRow { id: string; photo_url: string | null; photo_fallback?: string | null; photo_state?: ShotState | null }

/** The rows brought up to the phone's queue now, between the card's reads.
 *  `queued`: read with refused shots in (queuedShots(jobId, { refused: true })).
 *  A shot on the phone shows from its file, with its state. One that has left
 *  the queue is saved only when `landed` (one of this clean's photos just
 *  became a row); anything else keeps its mark until the card reads again.
 *  Rows that don't change are returned as they were. */
export function withShotStates<T extends ShotRow>(rows: T[], queued: Queued, landed: boolean): T[] {
  return rows.map(r => {
    const q = queued.get(r.id)
    if (q) {
      // Refused, with nothing on screen: the room already asks for it again.
      if (q.refused && !r.photo_url) return r
      // As the card shows it (roomShots): the phone's shot is the newest.
      const next = { photo_url: q.localUri, photo_fallback: q.storedUrl, photo_state: queuedState(q) }
      if (next.photo_url === r.photo_url && next.photo_fallback === r.photo_fallback && next.photo_state === r.photo_state) return r
      return { ...r, ...next }
    }
    if (landed && r.photo_url && (r.photo_state === 'uploading' || r.photo_state === 'waiting')) return { ...r, photo_state: 'saved' as const }
    return r
  })
}

/** The requirements taken, on the server or on the phone. */
export function shotsTaken(server: any[], before: Queued, after: Queued): Set<string> {
  const taken = new Set<string>()
  for (const s of server) if (s?.photo_requirement_id) taken.add(s.photo_requirement_id)
  for (const req of before.keys()) taken.add(req)
  for (const req of after.keys()) taken.add(req)
  return taken
}
