// Which cleans a booking calendar made: 📅 after the job number on Home's and
// Schedule's cards, and on the job screen a line saying where the booking came
// from (Five Star, 2026-11-12; the web Schedule and Dispatch carry the same 📅,
// web lib/calendarMade.ts).
//
// Every sync (iCal and the PMS APIs alike) links the clean it makes to its
// booking through jobs.reservation_id; a clean the office types in has none.
// is_turnover can't tell them apart: the office can tick it on a hand-made
// clean. A row cached before reservation_id was read has none and shows no
// mark until the next refresh.
//
// The phone has no hover, so the job screen spells the source out:
// "From the calendar: Airbnb". Platform names are names, not translated; the
// other cases have their own strings in every language.
//
// No imports, so scripts/test-calendar-mark.mjs can run it as is.

export const CALENDAR_MARK = '📅'

/** True when a booking made this clean (the sync linked it to the booking). */
export function isCalendarMade(job: { reservation_id?: string | null } | null | undefined): boolean {
  return !!job?.reservation_id
}

// Display names for the platforms a booking can carry (property_reservations.platform),
// as the web app's lib/platforms.ts names them.
const PLATFORM_NAMES: Record<string, string> = {
  airbnb: 'Airbnb',
  vrbo: 'VRBO',
  homeaway: 'VRBO',
  hospitable: 'Hospitable',
  hostaway: 'Hostaway',
  guesty: 'Guesty',
  ownerrez: 'OwnerRez',
  booking: 'Booking.com',
  expedia: 'Expedia',
  lodgify: 'Lodgify',
  hosttools: 'Host Tools',
  streamline: 'Streamline',
  evolve: 'Evolve',
}

export type CalendarSource =
  | { kind: 'platform'; name: string }
  | { kind: 'owner_block' }
  | { kind: 'by_hand' }
  | { kind: 'calendar' }

/**
 * Where the booking behind a clean came from, from the booking row the job
 * screen reads (property_reservations embedded on the job). Null when the clean
 * has no booking. 'calendar' when the booking can't be read or its platform has
 * no name we know ("other", "direct").
 */
export function calendarSource(
  booking: { platform?: string | null; reservation_id?: string | null } | null | undefined,
  hasReservation: boolean,
): CalendarSource | null {
  if (!booking) return hasReservation ? { kind: 'calendar' } : null
  if (String(booking.reservation_id ?? '').startsWith('manual:')) return { kind: 'by_hand' }
  const key = String(booking.platform ?? '').toLowerCase().trim()
  if (key === 'owner_block') return { kind: 'owner_block' }
  const name = PLATFORM_NAMES[key]
  return name ? { kind: 'platform', name } : { kind: 'calendar' }
}

/** The job screen's line, in the crew's language, e.g. "📅 From the calendar: Airbnb". */
export function calendarSourceLine(
  source: CalendarSource | null,
  t: (key: 'cal_from_platform' | 'cal_from_owner_block' | 'cal_from_by_hand' | 'cal_from_calendar') => string,
): string | null {
  if (!source) return null
  switch (source.kind) {
    case 'platform': return `${CALENDAR_MARK} ${t('cal_from_platform').replace('{{platform}}', source.name)}`
    case 'owner_block': return `${CALENDAR_MARK} ${t('cal_from_owner_block')}`
    case 'by_hand': return `${CALENDAR_MARK} ${t('cal_from_by_hand')}`
    default: return `${CALENDAR_MARK} ${t('cal_from_calendar')}`
  }
}
