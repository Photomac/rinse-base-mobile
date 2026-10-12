// src/lib/photoTakenAt.ts
// When a job photo was taken, sent with its row as job_photos.taken_at
// (2026-10-12). Until then the only time on a photo was the row's created_at:
// when the queue got it to the server, which on a weak bar or offline can be
// hours after the shot. The web app's stamped download prints taken_at on the
// photo for a damage claim, so it is never a guess:
//   • A camera photo: the moment the camera handed it back (the caller passes
//     Date.now() right then).
//   • A library photo: its EXIF time, read here. With no usable EXIF it is
//     unknown (null), never the moment it was picked: a photo from last week
//     must not be stamped as today's.
//
// Pure, so scripts/test-photo-taken-at.mjs runs it in Node. Mirrors the web
// app's src/lib/photoTakenAt.ts.

// A camera clock ahead of real time is wrong, not early.
const FUTURE_SKEW_MS = 10 * 60_000
// A camera whose clock was never set reports 1970 or 2000-01-01.
const EARLIEST_MS = Date.UTC(2001, 0, 1)

function field(exif: Record<string, any>, key: string): string {
  // Android: ExifInterface tags at the top level. iOS: the {Exif}
  // dictionary's keys at the top level; read the nested form too.
  const v = exif[key] ?? exif['{Exif}']?.[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** The instant (ms) an ImagePicker asset's `exif` says it was taken, or null. */
export function exifTakenAt(exif: Record<string, any> | null | undefined, now: number = Date.now()): number | null {
  if (!exif || typeof exif !== 'object') return null
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(field(exif, 'DateTimeOriginal') || field(exif, 'DateTime'))
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const offset = field(exif, 'OffsetTimeOriginal')
  // With the camera's offset it is an exact instant; without one it is the
  // camera's wall clock, read in this phone's zone.
  const at = /^[+-]\d{2}:\d{2}$/.test(offset)
    ? new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`)
    : new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  const ms = at.getTime()
  if (Number.isNaN(ms) || ms < EARLIEST_MS || ms > now + FUTURE_SKEW_MS) return null
  return ms
}
