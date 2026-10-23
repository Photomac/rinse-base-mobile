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
import { queuedShots, type QueuedShot } from './photoQueue'

export type Queued = Map<string, QueuedShot>

/** A shot to show: `uri` first, `fallback` when that file can't be loaded. */
export interface RoomShot { uri: string; fallback: string | null }

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
      shots[s.photo_requirement_id] = { uri: s.photo_url, fallback: null }
    }
  }
  for (const [req, q] of before) if (!after.has(req)) shots[req] = { uri: q.storedUrl, fallback: null }
  for (const [req, q] of after) shots[req] = { uri: q.localUri, fallback: q.storedUrl }
  return shots
}

/** The requirements taken, on the server or on the phone. */
export function shotsTaken(server: any[], before: Queued, after: Queued): Set<string> {
  const taken = new Set<string>()
  for (const s of server) if (s?.photo_requirement_id) taken.add(s.photo_requirement_id)
  for (const req of before.keys()) taken.add(req)
  for (const req of after.keys()) taken.add(req)
  return taken
}
