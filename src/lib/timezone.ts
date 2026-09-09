// src/lib/timezone.ts
// Tenant-aware date/time formatting for the crew app.
//
// WHY THIS EXISTS: every screen used to call
//   new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
// with no `timeZone`, so a job rendered in the PHONE's timezone while the web
// app rendered the same row in the TENANT's timezone (src/lib/timezone.ts in
// the web repo). Same clean, two answers: an owner in Chicago read "11:00 AM"
// while the crew's phone in Lisbon read "5:00 PM". Verified on the Isiscare
// tenant 2026-09-04. It bites any owner and crew in different zones, not just
// non-US ones — a US owner with a crew member travelling is enough.
//
// RULE: anything that is a business wall-clock time — when a clean starts, when
// someone clocked in, which calendar day a job belongs to — goes through here.
// Things that are genuinely about the reader's own moment (chat timestamps) do
// not, and are deliberately left on device-local.

// The tenant's IANA zone, set once from the profile load in App.tsx and reused
// by every screen. Null until the tenant row lands (first paint, or a cold
// start with no signal and no cached profile).
let _tenantTz: string | null = null

/** The phone's own zone. This is what every call site used before, so it is
 *  the fallback whenever the tenant zone is unknown or unusable — the change
 *  can then never render worse than what shipped. */
export function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// Hermes is built with Intl on both platforms, but the `timeZone` option is the
// part that depends on the ICU data actually being linked in — and a build that
// lacks it does not fail loudly, it either throws RangeError or silently ignores
// the zone. Probe once with an instant whose answer we know: 2021-01-01T00:00Z
// is 19:00 the previous day in New York. If the runtime can't do that, every
// helper here quietly falls back to device-local, i.e. today's behaviour.
let _ianaOk: boolean | null = null
export function supportsIanaZones(): boolean {
  if (_ianaOk !== null) return _ianaOk
  try {
    const probe = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23',
    }).format(new Date('2021-01-01T00:00:00Z'))
    _ianaOk = probe.indexOf('19') !== -1
  } catch {
    _ianaOk = false
  }
  return _ianaOk
}

/** Set the tenant zone. Called from App.tsx on profile load — including the
 *  cached-profile path, so an offline crew member still gets tenant time. */
export function setCurrentTz(tz: string | null | undefined) {
  _tenantTz = tz && tz.trim() ? tz.trim() : null
}

/** The zone every helper renders in. */
export function getCurrentTz(): string {
  if (_tenantTz && supportsIanaZones()) return _tenantTz
  return deviceTz()
}

/** True when we are rendering the tenant's zone and it differs from the
 *  phone's — the case worth telling the crew about on a job screen. */
export function isForeignTz(): boolean {
  if (!_tenantTz || !supportsIanaZones()) return false
  return _tenantTz !== deviceTz()
}

function toDate(input: Date | string | null | undefined): Date | null {
  if (!input) return null
  const d = typeof input === 'string' ? new Date(input) : input
  return Number.isNaN(d.getTime()) ? null : d
}

// Postgres `date` columns arrive as 'YYYY-MM-DD'. new Date('2026-05-09') is
// parsed as UTC midnight, which renders as May 8 anywhere west of UTC, so
// calendar dates are formatted from their literal Y/M/D instead of being
// round-tripped through a zone at all.
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Format a wall-clock time in the tenant's zone, e.g. '11:30 AM'. */
export function fmtTime(input: Date | string | null | undefined, locale = 'en-US'): string {
  const d = toDate(input)
  if (!d) return ''
  try {
    return d.toLocaleTimeString(locale, {
      timeZone: getCurrentTz(), hour: 'numeric', minute: '2-digit',
    })
  } catch {
    return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  }
}

/** Format a date in the tenant's zone. Date-only strings render as that
 *  literal calendar date, never shifted. */
export function fmtDate(
  input: Date | string | null | undefined,
  locale = 'en-US',
  opts?: Intl.DateTimeFormatOptions,
): string {
  if (!input) return ''
  const fmtOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(opts || {}) }
  if (typeof input === 'string') {
    const m = DATE_ONLY_RE.exec(input)
    if (m) {
      // Noon UTC is safe in every zone — no DST jump flips the calendar day at
      // noon — so formatting it in UTC always yields the intended Y/M/D.
      const noonUtc = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`)
      try {
        return noonUtc.toLocaleDateString(locale, { timeZone: 'UTC', ...fmtOpts })
      } catch {
        return noonUtc.toLocaleDateString(locale, fmtOpts)
      }
    }
  }
  const d = toDate(input)
  if (!d) return ''
  try {
    return d.toLocaleDateString(locale, { timeZone: getCurrentTz(), ...fmtOpts })
  } catch {
    return d.toLocaleDateString(locale, fmtOpts)
  }
}

/** Format a full datetime in the tenant's zone. */
export function fmtDateTime(input: Date | string | null | undefined, locale = 'en-US'): string {
  if (typeof input === 'string' && DATE_ONLY_RE.test(input)) return fmtDate(input, locale)
  const d = toDate(input)
  if (!d) return ''
  try {
    return d.toLocaleString(locale, {
      timeZone: getCurrentTz(),
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  } catch {
    return d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
}

// ── Day bucketing ────────────────────────────────────────────────────────────
// Which day a job belongs to has to agree with the time printed on it. If the
// time is tenant-zone but the bucket is phone-zone, an 11 PM clean renders on
// the wrong day of the calendar — a different wrong answer, not a fix.

// Building an Intl.DateTimeFormat is far more expensive than using one, and
// dayKey() runs once per job per calendar cell — a month grid with a busy book
// is thousands of calls per render. One formatter per zone, kept.
const _partsFmt = new Map<string, Intl.DateTimeFormat>()
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = _partsFmt.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    _partsFmt.set(tz, f)
  }
  return f
}

/** Y/M/D parts of an instant in a given zone. */
function partsInTz(d: Date, tz: string) {
  const p = partsFormatter(tz).formatToParts(d)
  const get = (type: string) => Number(p.find(x => x.type === type)?.value ?? '0')
  return {
    y: get('year'), m: get('month'), d: get('day'),
    // ICU has historically returned 24 for midnight under h23; normalise it.
    h: get('hour') % 24, mi: get('minute'), s: get('second'),
  }
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n))

/** 'YYYY-MM-DD' for an instant, in the tenant's zone. The key both sides of a
 *  day comparison must be built with. */
export function dayKey(input: Date | string | null | undefined): string {
  const d = toDate(input)
  if (!d) return ''
  const tz = getCurrentTz()
  try {
    const { y, m, d: day } = partsInTz(d, tz)
    return `${y}-${pad(m)}-${pad(day)}`
  } catch {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
}

/** 'YYYY-MM-DD' for a Date built as a local calendar day (new Date(y, m, i) —
 *  a grid cell, a picker selection). Its literal Y/M/D is what the user sees,
 *  so it is read directly rather than converted through any zone. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Today's 'YYYY-MM-DD' in the tenant's zone. */
export function todayKey(): string {
  return dayKey(new Date())
}

/** Offset in ms between UTC and `tz` at a given instant (positive east). */
function tzOffsetMs(d: Date, tz: string): number {
  const { y, m, d: day, h, mi, s } = partsInTz(d, tz)
  const asUtc = Date.UTC(y, m - 1, day, h, mi, s, d.getUTCMilliseconds())
  return asUtc - d.getTime()
}

/** Midnight at the start of `date`'s day in the tenant's zone, as a real
 *  instant — for the `gte`/`lte` bounds of a "today" query. */
export function startOfDayInTz(date: Date): Date {
  const tz = getCurrentTz()
  try {
    const { y, m, d } = partsInTz(date, tz)
    // Guess the instant assuming the zone's offset at `date`, then correct once
    // in case midnight sits on the far side of a DST transition.
    const naive = Date.UTC(y, m - 1, d, 0, 0, 0, 0)
    const guess = new Date(naive - tzOffsetMs(date, tz))
    return new Date(naive - tzOffsetMs(guess, tz))
  } catch {
    const r = new Date(date)
    r.setHours(0, 0, 0, 0)
    return r
  }
}

/** The last millisecond of `date`'s day in the tenant's zone. */
export function endOfDayInTz(date: Date): Date {
  const start = startOfDayInTz(date)
  // Step forward 26h to land safely inside the next day across any DST jump,
  // then take that day's start and back off a millisecond.
  const nextish = new Date(start.getTime() + 26 * 3600_000)
  return new Date(startOfDayInTz(nextish).getTime() - 1)
}

/** Midnight on the 1st of `date`'s month, in the tenant's zone — the lower
 *  bound of the "this month" stats, which have to agree with the owner's. */
export function startOfMonthInTz(date: Date): Date {
  const start = startOfDayInTz(date)
  const dayOfMonth = Number(dayKey(start).slice(8, 10)) || 1
  // Step back to the 1st, then re-anchor: a DST shift in between would
  // otherwise leave the result an hour off midnight.
  return startOfDayInTz(new Date(start.getTime() - (dayOfMonth - 1) * 86400_000))
}

/** A LOCAL Date whose calendar Y/M/D is the tenant's today. Calendar grids are
 *  built from local Dates (new Date(y, m, i)) and their literal Y/M/D is what
 *  the cell shows — this is the anchor to build them around, so the grid opens
 *  on the tenant's day rather than the phone's. */
export function todayAsLocalDate(): Date {
  const [y, m, d] = todayKey().split('-').map(Number)
  if (!y || !m || !d) return new Date()
  return new Date(y, m - 1, d)
}
