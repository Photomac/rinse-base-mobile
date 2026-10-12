// When a library photo was taken, from the `exif` ImagePicker hands back.
// Run with: node scripts/test-photo-taken-at.mjs (process TZ: America/Chicago,
// so the no-offset case reads the camera clock in a known zone).
import { exifTakenAt } from '../photoTakenAt'

let failures = 0
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — got ${JSON.stringify(got)}`}`)
  if (!cond) failures++
}
const NOW = Date.parse('2026-10-12T21:00:00Z')
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString())

let got = iso(exifTakenAt({ DateTimeOriginal: '2026:10:12 15:04:30', OffsetTimeOriginal: '-04:00' }, NOW))
ok('Android/iOS top-level tags with an offset: that instant', got === '2026-10-12T19:04:30.000Z', got)
got = iso(exifTakenAt({ '{Exif}': { DateTimeOriginal: '2026:10:12 15:04:30', OffsetTimeOriginal: '-04:00' } }, NOW))
ok('iOS nested {Exif} dictionary: read too', got === '2026-10-12T19:04:30.000Z', got)
got = iso(exifTakenAt({ DateTimeOriginal: '2026:10:12 09:04:30' }, NOW))
ok('no offset: the camera clock in this phone\'s zone (Chicago)', got === '2026-10-12T14:04:30.000Z', got)
got = iso(exifTakenAt({ DateTime: '2026:10:11 08:00:00', OffsetTimeOriginal: '+00:00' }, NOW))
ok('no DateTimeOriginal: DateTime', got === '2026-10-11T08:00:00.000Z', got)
got = iso(exifTakenAt({ DateTimeOriginal: '2026:10:12 17:11:00', OffsetTimeOriginal: '-04:00' }, NOW))
ok('a camera clock 11 min ahead: unknown', got === null, got)
got = iso(exifTakenAt({ DateTimeOriginal: '2026:10:12 17:09:00', OffsetTimeOriginal: '-04:00' }, NOW))
ok('…9 min ahead: kept (clock skew)', got === '2026-10-12T21:09:00.000Z', got)
ok('a reset clock (2000-01-01), a blank date, garbage, a number: unknown', [
  exifTakenAt({ DateTimeOriginal: '2000:01:01 00:00:00' }, NOW),
  exifTakenAt({ DateTimeOriginal: '    :  :     :  :  ' }, NOW),
  exifTakenAt({ DateTimeOriginal: 'yesterday' }, NOW),
  exifTakenAt({ DateTimeOriginal: 1760281470 }, NOW),
].every(v => v === null))
ok('no exif (a picker that returned none): unknown, never the pick time', exifTakenAt(undefined, NOW) === null && exifTakenAt(null, NOW) === null && exifTakenAt({}, NOW) === null)
got = iso(exifTakenAt({ DateTimeOriginal: '2026:10:12 09:04:30', OffsetTimeOriginal: 'Z' }, NOW))
ok('a malformed offset is ignored, not trusted', got === '2026-10-12T14:04:30.000Z', got)

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
console.log('\nAll photo-taken-at rules hold.')
