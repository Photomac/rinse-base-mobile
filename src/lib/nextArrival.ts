// Who arrives after a clean — read off the property's calendar, and a block is
// reported as a block, never as a guest.
//
// Precision H&W (2026-10-03, Midtown Mallard): the prep card told crew "guest
// arrives 4:00 PM" while the calendar only held "Airbnb (Not available)" from
// that afternoon (Airbnb's label for dates the host blocked or booked on another
// channel), and the owner's schedule showed no arrival at all. Crew and office
// were looking at the same row and reading two different things.
//
// PORT of rinsebase-app src/lib/nextArrival.ts + the isNoiseHold rule from
// supabase/functions/_shared/block-holds.ts (this repo cannot import them).
// Keep the three in step: same noise rule, same precedence.

export interface ArrivalRow {
  id: string
  platform: string | null
  guest_name: string | null
  calendar_id: string | null
  checkin_date: string
  checkout_date: string
  checkin_time: string | null
}

export type NextArrival =
  | {
      kind: 'guest' | 'hold'
      date: string            // YYYY-MM-DD, property-local
      time: string | null     // 'HH:MM[:SS]' wall clock
      timeIsDefault: boolean  // the booking carried no time of its own
      name: string | null
      sameDay: boolean
    }
  | { kind: 'none' }

/** A channel's boilerplate "closed" label, as opposed to something a person typed. */
export function isChannelPlaceholderHold(label: string | null | undefined): boolean {
  const s = (label || '').trim().toLowerCase()
  if (!s) return false
  return s.includes('not available') || s.includes('unavailable')
    || s.startsWith('blocked') || s.startsWith('closed')
}

function nights(r: ArrivalRow): number {
  return Math.round((Date.parse(r.checkout_date + 'T00:00:00Z') - Date.parse(r.checkin_date + 'T00:00:00Z')) / 86400000)
}

/**
 * A synced hold that is not occupancy: an exact echo of a guest stay from another
 * feed, or a 1-night preparation-day buffer touching a guest stay.
 */
export function isNoiseHold(hold: ArrivalRow, rows: ArrivalRow[]): boolean {
  if (hold.platform !== 'owner_block' || hold.calendar_id == null) return false
  if (!isChannelPlaceholderHold(hold.guest_name)) return false
  for (const s of rows) {
    if (!s || s === hold || s.platform === 'owner_block') continue
    if (s.checkin_date === hold.checkin_date && s.checkout_date === hold.checkout_date) return true
    if (nights(hold) <= 1 && (s.checkin_date === hold.checkout_date || s.checkout_date === hold.checkin_date)) return true
  }
  return false
}

/**
 * The next arrival on or after `cleanYmd`. `rows` are the address's confirmed
 * reservations, blocks included, from at least the day before the clean.
 * `defaults` are the property default check-in, then the company one.
 */
export function pickNextArrival(
  cleanYmd: string,
  rows: ArrivalRow[],
  defaults: { property?: string | null; company?: string | null },
  excludeId?: string | null,
): NextArrival {
  const next = rows
    .filter(r => r.checkin_date >= cleanYmd && r.id !== excludeId && !isNoiseHold(r, rows))
    .sort((a, b) => a.checkin_date.localeCompare(b.checkin_date)
      || (a.platform === 'owner_block' ? 1 : 0) - (b.platform === 'owner_block' ? 1 : 0))[0]
  if (!next) return { kind: 'none' }
  return {
    kind: next.platform === 'owner_block' ? 'hold' : 'guest',
    date: next.checkin_date,
    time: next.checkin_time || defaults.property || defaults.company || null,
    timeIsDefault: !next.checkin_time,
    name: next.guest_name,
    sameDay: next.checkin_date === cleanYmd,
  }
}

/**
 * A reservation's check-in time is a bare wall-clock time in the tenant's zone
 * ("16:00:00"), not an instant — format it without any zone conversion.
 */
export function fmtWallTime(hhmm: string | null | undefined, locale: string): string | null {
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h)) return null
  const d = new Date(Date.UTC(2000, 0, 1, h, m || 0))
  return d.toLocaleTimeString(locale, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
}

/** YYYY-MM-DD shifted by whole days. */
export function shiftYmd(ymd: string, days: number): string {
  const d = new Date(ymd + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
