// Room-shot scenario test. Run with: node scripts/test-room-shots.mjs
//
// A room shot ("Guest-ready kitchen") holds more than one photo (Five Star,
// 2026-11-08: "anyway to make it so that we're able to take multiple pics for
// the guest ready picture of each room?"). Exercises the REAL
// src/lib/roomShots.ts: every photo a shot holds is listed once, newest
// first, with the latest the one the room already showed; a photo just taken
// keeps the others listed; deleting one shows the next.
import {
  roomShots, roomShotLists, newestPerShot, shotsShown, withoutShot, storedUrlOf,
  type QueuedList, type RoomShot,
} from '../roomShots'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const urls = (l: RoomShot[] | undefined) => (l ?? []).map(s => s.uri)

const S = (n: string) => `https://store/job-photos/${n}.jpg`
const row = (id: string, req: string, n: string, at: string) => ({ id, photo_requirement_id: req, photo_url: S(n), created_at: at })
const q = (req: string, n: string, at: number, extra: Partial<QueuedList[number]> = {}): QueuedList[number] =>
  ({ requirementId: req, localUri: `file:///phone/${n}.jpg`, storedUrl: S(n), created_at: at, waiting: false, ...extra })

// ── Server only: every photo, newest first, each with its row id ────────────
{
  const server = [
    row('r3', 'KITCHEN', 'k3', '2026-11-08T17:03:00Z'),
    row('r2', 'KITCHEN', 'k2', '2026-11-08T17:02:00Z'),
    row('r1', 'KITCHEN', 'k1', '2026-11-08T17:01:00Z'),
    row('b1', 'BATH', 'b1', '2026-11-08T17:05:00Z'),
  ]
  const lists = roomShotLists(server, [], [])
  ok('three kitchen photos, newest first', JSON.stringify(urls(lists.KITCHEN)) === JSON.stringify([S('k3'), S('k2'), S('k1')]))
  ok('each saved photo carries its row id', lists.KITCHEN.map(s => s.id).join() === 'r3,r2,r1')
  ok('the bathroom keeps its own one photo', urls(lists.BATH).length === 1)
  const latest = roomShots(server, new Map(), new Map())
  ok('the list starts with the photo the room already shows', lists.KITCHEN[0].uri === latest.KITCHEN.uri)
}

// ── On the phone and on the server: listed once each ───────────────────────
{
  const server = [row('r1', 'KITCHEN', 'k1', '2026-11-08T17:01:00Z')]
  const before = [q('KITCHEN', 'k2', 2000), q('KITCHEN', 'k3', 3000, { waiting: true })]
  const after = [q('KITCHEN', 'k3', 3000, { waiting: true })] // k2 landed while the reads were out
  const lists = roomShotLists(server, before, after)
  ok('a photo on the phone, one landed, one saved: three', lists.KITCHEN.length === 3)
  ok('the photo still on the phone comes first, from its file', lists.KITCHEN[0].uri === 'file:///phone/k3.jpg' && lists.KITCHEN[0].state === 'waiting')
  ok('the landed photo shows from its stored copy', lists.KITCHEN[1].uri === S('k2') && lists.KITCHEN[1].state === 'saved')
  const latest = roomShots(server, newestPerShot(before), newestPerShot(after))
  ok('same latest photo as the room shows', lists.KITCHEN[0].uri === latest.KITCHEN.uri)

  // The landed one also came back in the reads: its row, not a second copy.
  const server2 = [row('r2', 'KITCHEN', 'k2', '2026-11-08T17:02:00Z'), ...server]
  const lists2 = roomShotLists(server2, before, after)
  ok('a landed photo the reads have is listed once', lists2.KITCHEN.length === 3)
  ok('…as its row, with the id to delete it', lists2.KITCHEN.some(s => s.uri === S('k2') && s.id === 'r2'))
  ok('no photo is listed twice', new Set(lists2.KITCHEN.map(storedUrlOf)).size === lists2.KITCHEN.length)
}

// ── newestPerShot is queuedShots' rule ─────────────────────────────────────
{
  const list = [q('A', 'a1', 1000), q('A', 'a2', 2000), q('B', 'b1', 1500), q('A', 'a0', 500)]
  const m = newestPerShot(list)
  ok('newest per requirement', m.get('A')?.storedUrl === S('a2') && m.get('B')?.storedUrl === S('b1'))
  ok('no requirement id left on the shot', !('requirementId' in (m.get('A') as any)))
}

// ── A photo just taken: the others stay listed under it ─────────────────────
{
  const listed = roomShotLists([
    row('r2', 'KITCHEN', 'k2', '2026-11-08T17:02:00Z'),
    row('r1', 'KITCHEN', 'k1', '2026-11-08T17:01:00Z'),
  ], [], [])
  const before = { id: 'KITCHEN', photo_url: S('k2'), photo_fallback: null, photo_state: 'saved' as const, shots: listed.KITCHEN }
  ok('before: two photos shown', urls(shotsShown(before)).length === 2)
  ok('the latest shown carries its row id', shotsShown(before)[0].id === 'r2')

  // What shootEvidence does: the shown list becomes the list, the new file shows.
  const taken = { ...before, shots: shotsShown(before), photo_url: 'file:///phone/k3.jpg', photo_fallback: null, photo_state: 'uploading' as const }
  const shown = shotsShown(taken)
  ok('after: three photos shown', shown.length === 3)
  ok('the new photo first, then the two before it', JSON.stringify(urls(shown)) === JSON.stringify(['file:///phone/k3.jpg', S('k2'), S('k1')]))
  ok('the new photo has no row to delete yet', !shown[0].id)

  // Two quick shots before any reload: the first quick one is not lost.
  const taken2 = { ...taken, shots: shotsShown(taken), photo_url: 'file:///phone/k4.jpg', photo_state: 'uploading' as const }
  ok('a second quick shot keeps the first quick one', urls(shotsShown(taken2)).includes('file:///phone/k3.jpg') && shotsShown(taken2).length === 4)

  // The queue then reports the new one with its stored url (withShotStates).
  const live = { ...taken, photo_url: 'file:///phone/k3.jpg', photo_fallback: S('k3') }
  ok('still three once the queue names where it will be stored', shotsShown(live).length === 3)

  // The reload lists it (from the phone), with the room showing the same one.
  const reloaded = roomShotLists([
    row('r2', 'KITCHEN', 'k2', '2026-11-08T17:02:00Z'),
    row('r1', 'KITCHEN', 'k1', '2026-11-08T17:01:00Z'),
  ], [], [q('KITCHEN', 'k3', Date.parse('2026-11-08T17:03:00Z'))])
  const after = { ...live, photo_state: 'uploading' as const, shots: reloaded.KITCHEN }
  ok('after the reload: still three, none twice', shotsShown(after).length === 3)
}

// ── Deleting one ────────────────────────────────────────────────────────────
{
  const listed = roomShotLists([
    row('r3', 'KITCHEN', 'k3', '2026-11-08T17:03:00Z'),
    row('r2', 'KITCHEN', 'k2', '2026-11-08T17:02:00Z'),
    row('r1', 'KITCHEN', 'k1', '2026-11-08T17:01:00Z'),
  ], [], [])
  const r = { id: 'KITCHEN', photo_url: S('k3'), photo_fallback: null, photo_state: 'saved' as const, shots: listed.KITCHEN }

  const mid = withoutShot(r, shotsShown(r)[1])
  ok('deleting an older photo keeps the latest showing', mid.photo_url === S('k3'))
  ok('…and leaves two', shotsShown(mid).length === 2 && !urls(shotsShown(mid)).includes(S('k2')))

  const top = withoutShot(r, shotsShown(r)[0])
  ok('deleting the latest shows the next one', top.photo_url === S('k2') && top.photo_state === 'saved')
  ok('…and leaves two', shotsShown(top).length === 2)

  let last: typeof r = r
  for (let i = 0; i < 3; i++) last = withoutShot(last, shotsShown(last)[0])
  ok('deleting every photo: the room asks for the shot again', last.photo_url === null && shotsShown(last).length === 0)
}

// ── A row read before this change (no `shots`) still shows its one photo ────
{
  const old = { id: 'X', photo_url: S('x1'), photo_fallback: null, photo_state: 'saved' as const }
  ok('a row with no list shows its one photo', shotsShown(old).length === 1 && shotsShown(old)[0].uri === S('x1'))
  ok('a row with no photo shows none', shotsShown({ id: 'Y', photo_url: null }).length === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nAll room-shot checks passed')
process.exit(failures ? 1 : 0)
