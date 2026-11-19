// What's left on a clean, room by room: the checklist card's own grouping and
// "is this room done" rule, and the "Left to do" list a paused clean shows
// before Continue (CKS Perfections, Catherine 2026-11-18: "When someone taps
// Continue the next day, will they see what is left to do first?").
//
// The room accordion in JobDetailScreen and the paused card both read these,
// so the list can never disagree with the green ticks below it. Pure (no
// React, no Supabase) so scripts/test-left-to-do.mjs runs it under Node.

export type RoomGroup = { key: string; name: string; mode: string; items: any[] }

/** A property room's display name when the owner didn't name it. */
export function roomName(rm: { name?: string | null; room_type?: string | null; instance_no?: number | null }): string {
  const named = (rm.name || '').trim()
  if (named) return named
  const type = rm.room_type || 'room'
  const n = rm.instance_no ?? 1
  if (type === 'bedroom') return n === 1 ? 'Primary Bedroom' : `Bedroom ${n}`
  if (type === 'bathroom') return `Bathroom ${n}`
  if (type === 'final') return 'Final Guest-Ready Check'
  if (type === 'living') return 'Living Room'
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) + (n > 1 ? ` ${n}` : '')
}

/**
 * The rooms in the order the crew walk them, each with its checklist items.
 * Extra tasks the office added to this clean only (no room, room text
 * extraRoom) come first; items with no room go under "Other" last. A room
 * shows when it has items or photos to take.
 */
export function groupRooms(roomsMeta: any[], items: any[], evidence: any[], defaultMode: string, extraRoom: string): RoomGroup[] {
  const groups: RoomGroup[] = []
  const byId = new Map<string, RoomGroup>()
  for (const rm of roomsMeta) {
    const g: RoomGroup = { key: rm.id, name: roomName(rm), mode: rm.execution_mode || defaultMode, items: [] }
    byId.set(rm.id, g)
    groups.push(g)
  }
  const other: RoomGroup = { key: '__other__', name: 'Other', mode: 'detailed', items: [] }
  const extra: RoomGroup = { key: '__extra__', name: extraRoom, mode: 'detailed', items: [] }
  for (const item of items) {
    const g = item.room_uid ? byId.get(item.room_uid) : null
    if (!g && item.room === extraRoom) { extra.items.push(item); continue }
    ;(g || other).items.push(item)
  }
  if (extra.items.length > 0) groups.unshift(extra)
  if (other.items.length > 0) groups.push(other)
  return groups.filter(g => g.items.length > 0 || evidence.some((e: any) => (e.room_id || '__other__') === g.key))
}

export type RoomDeps = {
  checked: Record<string, boolean>
  evidence: any[]
  signoffs: Record<string, unknown>
  /** Listed, but not owed on this clean (added after clock-in, archived room). */
  notOwed: (reqId: string, required: boolean) => boolean
  /** A line that asks a question (lib/lineAnswers). */
  questionType: (item: any) => unknown
}

export type RoomState = {
  tasks: any[]
  verifies: any[]
  doneTasks: number
  answered: number
  issues: number
  req: { total: number; done: number }
  signed: boolean
  questionsLeft: number
  complete: boolean
}

/** One room's progress: the checklist card's rule for a green ✓. */
export function roomState(g: RoomGroup, d: RoomDeps): RoomState {
  const tasks = g.items.filter((i: any) => i.item_kind !== 'verify')
  const verifies = g.items.filter((i: any) => i.item_kind === 'verify')
  const doneTasks = tasks.filter((i: any) => d.checked[i.id]).length
  const answered = verifies.filter((i: any) => i.result != null || d.checked[i.id]).length
  const issues = verifies.filter((i: any) => i.result === 'issue').length
  const evRows = d.evidence.filter((e: any) => (e.room_id || '__other__') === g.key)
  const evReq = evRows.filter((e: any) => e.required && !d.notOwed(e.id, e.required))
  const req = { total: evReq.length, done: evReq.filter((e: any) => e.photo_url).length }
  const signed = !!d.signoffs[g.key]
  // A question isn't answered by the room's sign-off (lib/lineAnswers).
  const questionsLeft = g.items.filter((i: any) => d.questionType(i) && i.answer == null).length
  const workDone = g.mode === 'room_complete'
    ? signed && questionsLeft === 0
    : doneTasks === tasks.length && answered === verifies.length
  return {
    tasks, verifies, doneTasks, answered, issues, req, signed, questionsLeft,
    complete: g.items.length > 0 && workDone && req.done >= req.total,
  }
}

export type LeftRoom = {
  key: string
  name: string
  /** Lines not ticked or answered (rooms worked line by line). */
  itemsLeft: number
  /** Required photos not taken yet. */
  photosLeft: number
  /** A room signed off as a whole that isn't signed off yet. */
  needsSignoff: boolean
  /** Questions not answered yet (a sign-off doesn't answer them). */
  questionsLeft: number
}

export type LeftToDo = { rooms: LeftRoom[]; roomsTotal: number; roomsDone: number; photosLeft: number }

/** The rooms with something still to do, in walking order, and what. */
export function leftToDo(shown: RoomGroup[], d: RoomDeps): LeftToDo {
  const rooms: LeftRoom[] = []
  let roomsDone = 0
  let photosLeft = 0
  for (const g of shown) {
    const st = roomState(g, d)
    if (st.complete) { roomsDone++; continue }
    const byRoom = g.mode === 'room_complete'
    const left: LeftRoom = {
      key: g.key,
      name: g.name,
      itemsLeft: byRoom ? 0 : (st.tasks.length - st.doneTasks) + (st.verifies.length - st.answered),
      photosLeft: Math.max(0, st.req.total - st.req.done),
      needsSignoff: byRoom && g.items.length > 0 && !st.signed,
      questionsLeft: byRoom ? st.questionsLeft : 0,
    }
    photosLeft += left.photosLeft
    // A room with nothing countable left (only photos it doesn't owe) isn't
    // listed: it would read "0 left".
    if (left.itemsLeft > 0 || left.photosLeft > 0 || left.needsSignoff || left.questionsLeft > 0) rooms.push(left)
  }
  return { rooms, roomsTotal: shown.length, roomsDone, photosLeft }
}
