// Rooms for a property's staging / reference photos (client_addresses.staging_photos).
//
// LOCKSTEP with the web app's src/lib/stagingRooms.ts, which owns the editor
// and the caption rules: the owner files each photo into one of these rooms
// there (`room`, plus `room_no` for Bedroom/Bathroom), and the app only groups
// what it reads. Keys and order must match. Photos with no room (never sorted,
// or filed by an older web build) group last as "Other shots".

import type { TranslationKey } from './i18n'

export const STAGING_ROOM_KEYS = [
  'entrance', 'living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'laundry', 'outdoor', 'other',
] as const

export type StagingRoomKey = typeof STAGING_ROOM_KEYS[number]

export type StagingPhotoRow = { url: string; caption?: string | null; room?: string | null; room_no?: number | null }

const NUMBERED: StagingRoomKey[] = ['bedroom', 'bathroom']

function asRoom(v: unknown): StagingRoomKey | null {
  return typeof v === 'string' && (STAGING_ROOM_KEYS as readonly string[]).includes(v) ? v as StagingRoomKey : null
}

export type StagingGroup = { key: string; label: string; photos: StagingPhotoRow[]; start: number }

/** Photos grouped by room in the fixed order, unsorted last. `start` is the
 *  group's first position in the flattened order, which is also the order
 *  handed to the full-screen viewer, so a tap opens the right photo. */
export function groupStagingPhotos(photos: StagingPhotoRow[], t: (k: TranslationKey) => string): StagingGroup[] {
  const map = new Map<string, { key: string; rank: number; label: string; photos: StagingPhotoRow[] }>()
  for (const p of photos) {
    const room = asRoom(p.room)
    const no = room && NUMBERED.includes(room) && p.room_no ? Number(p.room_no) : null
    const key = room ? `${room}:${no ?? ''}` : 'unsorted'
    if (!map.has(key)) {
      const base = room ? t(`staging_room_${room}` as TranslationKey) : t('staging_room_unsorted')
      map.set(key, {
        key,
        rank: room ? STAGING_ROOM_KEYS.indexOf(room) * 100 + (no ?? 0) : 1e6,
        label: no ? `${base} ${no}` : base,
        photos: [],
      })
    }
    map.get(key)!.photos.push(p)
  }
  let start = 0
  return [...map.values()].sort((a, b) => a.rank - b.rank).map(g => {
    const out = { key: g.key, label: g.label, photos: g.photos, start }
    start += g.photos.length
    return out
  })
}
