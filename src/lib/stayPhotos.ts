// A rating under 5 stars needs photos (CKS Perfections, Catherine 2026-11-10):
// "the rating was 3 stars, with NO pictures. I've told this cleaner many times
// that pictures are required to support a low rating ... If it's under 5,
// pictures aren't optional in my world; they're the proof."
//
// The company's number, tenants.stay_rating_photos_required (rinse-base-app,
// owners/admins/managers set it in Settings): 0 = off, N = a rating of 1-4
// stars can't be saved, on the card or in the ask at Complete, until the clean
// has N photos of how the guests left it. Those are its Before and Damage
// photos ('before', 'issue', and the old 'damage'), the ones landed on the
// server and the ones still on this phone on their way (a photo the server
// refused isn't on its way). 5 stars, or N = 0: as before.
//
// THE APP IS THE GATE. Nothing on the server refuses the rating: the rating
// saves through the outbox and the photos through their own queue, so a
// server check would race the photos up and refuse a rating that's honest.
//
// Pure: no imports, so scripts/test-stay-photos.mjs loads it as is.

/** The photo types that show how the guests left it. */
export const STAY_PHOTO_TYPES = ['before', 'issue', 'damage'] as const

/** The company's number as the app uses it: a whole number 0-10; anything
 *  else (no column yet, no row, junk) is 0, off. */
export function photosRequired(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isInteger(n) || n <= 0) return 0
  return Math.min(n, 10)
}

/** The company's number from its read (tenants row, or an error = 0). */
export function requiredFromRead(read: { data: unknown; error: unknown } | null | undefined): number {
  if (!read || read.error || !read.data || typeof read.data !== 'object') return 0
  return photosRequired((read.data as any).stay_rating_photos_required)
}

/** One of the photo types that counts. */
export function countsAsStayPhoto(type: unknown): boolean {
  return typeof type === 'string' && (STAY_PHOTO_TYPES as readonly string[]).includes(type)
}

/** The clean's photos that count: server rows (job_photos) plus the ones on
 *  this phone still on their way (photoQueue queuedJobPhotos, which leaves out
 *  any whose row is already saved, so nothing counts twice). */
export function stayPhotoCount(serverRows: unknown, queued: unknown): number {
  const server = Array.isArray(serverRows) ? serverRows.filter(r => countsAsStayPhoto(r?.photo_type)).length : 0
  const onPhone = Array.isArray(queued) ? queued.filter(q => countsAsStayPhoto(q?.photo_type) && !q?.failing).length : 0
  return server + onPhone
}

/** Whether the picked rating is one that needs photos: 1-4 stars, the
 *  company asking for some. */
export function needsPhotos(rating: number, required: number): boolean {
  return required > 0 && Number.isInteger(rating) && rating >= 1 && rating <= 4
}

/** How many more photos the picked rating needs before it can be saved: 0
 *  when it needs none, or has enough. */
export function photosShort(rating: number, required: number, count: number): number {
  if (!needsPhotos(rating, required)) return 0
  return Math.max(0, required - Math.max(0, Math.floor(count || 0)))
}
