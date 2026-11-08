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
import { queuedShots, queuedShotList, type QueuedShot, type QueuedShotEntry } from './photoQueue'

export type Queued = Map<string, QueuedShot>
/** Every required shot still on the phone (queuedShotList). */
export type QueuedList = QueuedShotEntry[]

/** Where a shot stands, as its room says it. */
export type ShotState = 'saved' | 'uploading' | 'waiting' | 'failed'

/** A shot to show: `uri` first, `fallback` when that file can't be loaded.
 *  `id`: its job_photos row, when the row was in the server's read. */
export interface RoomShot { uri: string; fallback: string | null; state: ShotState; id?: string | null }

/** Where a shot is, or will be, in storage: the same for its file on the phone
 *  and its row once saved, so one shot is never listed twice. */
export function storedUrlOf(s: { uri: string | null; fallback?: string | null }): string | null {
  return s.fallback ?? s.uri
}

function queuedState(q: QueuedShot): ShotState {
  return q.refused ? 'failed' : q.waiting ? 'waiting' : 'uploading'
}

/** The phone's required shots for `jobId` now (none when the queue can't be read). */
export function queuedNow(jobId: string): Promise<Queued> {
  return queuedShots(jobId).catch((): Queued => new Map())
}

/** Every one of the phone's required shots for `jobId` now (none when the queue can't be read). */
export function queuedListNow(jobId: string): Promise<QueuedList> {
  return queuedShotList(jobId).catch((): QueuedList => [])
}

/** The newest shot per requirement, as queuedShots gives it, from one read of
 *  every shot: the latest shot and the list then come from the same read. */
export function newestPerShot(list: QueuedList): Queued {
  const shots: Queued = new Map()
  for (const s of list) {
    const newer = shots.get(s.requirementId)
    if (newer && newer.created_at >= s.created_at) continue
    const { requirementId, ...shot } = s
    shots.set(requirementId, shot)
  }
  return shots
}

/** requirement id → every shot it holds, newest first, by the same rule as
 *  roomShots: the ones on the phone over the server's, so its first shot is
 *  the one roomShots shows. A shot is listed once: by its file while it is on
 *  the phone, by its row (with the row's id) once saved. */
export function roomShotLists(server: any[], before: QueuedList, after: QueuedList): Record<string, RoomShot[]> {
  const lists: Record<string, RoomShot[]> = {}
  const listed = new Set<string>()
  const add = (req: string, at: number, shot: RoomShot, into: { req: string; at: number; shot: RoomShot }[]) => {
    const key = storedUrlOf(shot)
    if (!key || listed.has(key)) return
    listed.add(key)
    into.push({ req, at, shot })
  }
  const newestFirst = (a: { at: number }, b: { at: number }) => b.at - a.at
  // Still on the phone after the reads: its file, with where it stands.
  const onPhone: { req: string; at: number; shot: RoomShot }[] = []
  for (const q of after) add(q.requirementId, q.created_at, { uri: q.localUri, fallback: q.storedUrl, state: queuedState(q) }, onPhone)
  // Landed while the reads were out: its row, when the reads have it…
  const rows: { req: string; at: number; shot: RoomShot }[] = []
  for (const s of server) {
    if (s?.photo_requirement_id && s.photo_url) {
      add(s.photo_requirement_id, Date.parse(s.created_at) || 0, { uri: s.photo_url, fallback: null, state: 'saved', id: s.id ?? null }, rows)
    }
  }
  // …or its stored copy (its file on the phone is gone).
  const landed: { req: string; at: number; shot: RoomShot }[] = []
  for (const q of before) add(q.requirementId, q.created_at, { uri: q.storedUrl, fallback: null, state: 'saved' }, landed)
  for (const group of [onPhone.sort(newestFirst), landed.sort(newestFirst), rows.sort(newestFirst)]) {
    for (const { req, shot } of group) (lists[req] ??= []).push(shot)
  }
  return lists
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

/** A room's shot row with every photo it holds (`shots`, from roomShotLists). */
export interface ShotListRow extends ShotRow { shots?: RoomShot[] }

/** The photos a shot row shows, its latest first: the one the room has been
 *  showing (kept live from the phone's queue by withShotStates, or just taken),
 *  then the rest of `shots`. The latest carries its row's id when the read had
 *  it. A shot taken since the last read is in no list yet; the one it followed
 *  then shows second. */
export function shotsShown(row: ShotListRow): RoomShot[] {
  const listed = row.shots ?? []
  if (!row.photo_url) return listed
  const first: RoomShot = { uri: row.photo_url, fallback: row.photo_fallback ?? null, state: row.photo_state ?? 'saved' }
  const key = storedUrlOf(first)
  const same = (s: RoomShot) => storedUrlOf(s) === key || s.uri === row.photo_url
  return [{ ...first, id: listed.find(same)?.id ?? null }, ...listed.filter(s => !same(s))]
}

/** The row once `gone` is deleted: out of its list, and if it was the photo the
 *  room showed, the next one shows (or "Take photo" when none is left). */
export function withoutShot<T extends ShotListRow>(row: T, gone: RoomShot): T {
  const key = storedUrlOf(gone)
  const shown = shotsShown(row).filter(s => storedUrlOf(s) !== key && s.uri !== gone.uri)
  const next = shown[0]
  return {
    ...row,
    shots: (row.shots ?? []).filter(s => storedUrlOf(s) !== key && s.uri !== gone.uri),
    photo_url: next?.uri ?? null,
    photo_fallback: next?.fallback ?? null,
    photo_state: next?.state ?? null,
  }
}

/** The requirements taken, on the server or on the phone. */
export function shotsTaken(server: any[], before: Queued, after: Queued): Set<string> {
  const taken = new Set<string>()
  for (const s of server) if (s?.photo_requirement_id) taken.add(s.photo_requirement_id)
  for (const req of before.keys()) taken.add(req)
  for (const req of after.keys()) taken.add(req)
  return taken
}
