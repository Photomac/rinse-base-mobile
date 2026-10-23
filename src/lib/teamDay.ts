// "Team today": the office's clock roster for one company day, on the phone.
//
// CKS Perfections (Catherine Krause, 2026-10-19, with a Homebase screenshot as
// the model): she won't keep Safari open all day, so the office wants the
// day's clock-ins in the app: who's in, since when and for how long; who's out,
// with their in and out times and total; who hasn't clocked in. The owner
// fixes them from there (end a day, start a day, correct a time: lib/endDay).
// Pay never appears: nothing here reads a rate or an amount.
//
// Daily time tracking: one "Start my day" shift row per person (job_id null,
// entry_type 'shift'), sometimes two (a slip: start, end, start). Per-job
// tracking: one 'work' row per clean. Either way a person is one row here:
// first clock-in, last clock-out, and the time between counted once where
// entries overlap (payroll pays overlapping minutes once, too).
//
// Pure (no React, no Supabase; jobScope is import-free) so
// scripts/test-team-today.mjs runs it under Node.

import { isOfficeRole } from './jobScope'

export type TeamPerson = {
  id: string
  full_name?: string | null
  role?: string | null
  is_active?: boolean | null
  removed_at?: string | null
}

export type TeamEntry = {
  id: string
  user_id: string
  job_id?: string | null
  entry_type?: string | null
  clocked_in_at: string
  clocked_out_at?: string | null
  duration_minutes?: number | null
  pause_reason?: string | null
  edited_at?: string | null
  edited_by?: string | null
  original_clocked_in_at?: string | null
  original_clocked_out_at?: string | null
}

export type TeamClean = {
  id: string
  status: string
  job_type?: string | null
  scheduled_start?: string | null
  scheduled_end?: string | null
  completed_at?: string | null
  completed_by_user_id?: string | null
  /** users.id of everyone on its crew (job_assignments) */
  crew: string[]
  /** where: the property's nickname or street */
  label: string
}

/** Owners, managers and dispatchers see the roster. Crew never do. */
export function canSeeTeam(role: string | null | undefined): boolean {
  return isOfficeRole(role)
}

/** Only the owner fixes times from the phone. Managers and dispatchers see
 *  who's in and out (CKS: Nichole, a manager, may see that, not what anyone
 *  makes) with no edit buttons. The database would let them (job_time_entries
 *  policies are owner/manager/dispatcher); widening this is a one-line change. */
export function canFixTeamTime(role: string | null | undefined): boolean {
  return role === 'owner'
}

/** The roster takes Mileage's tab slot for the office of a day-shift company
 *  (CKS logged 4 mileage entries in 30 days); Mileage moves under Profile.
 *  Everyone else keeps Mileage, and an office on per-job tracking opens the
 *  roster from Profile. */
export function teamTabReplacesMileage(user: { role?: string | null; _timeMode?: string | null }): boolean {
  return canSeeTeam(user.role) && user._timeMode === 'daily'
}

/** The crew of a day-shift company get My week ("Pay") in that slot instead:
 *  their driving is paid on the clock, and their own hours and pay are what
 *  they ask the office about every week (CKS, Catherine + Nichole, 2026-10-22).
 *  Mileage moves under Profile for them too. A per-job company's crew keep
 *  Mileage and open My week from Home's earnings card. */
export function weekTabReplacesMileage(user: { role?: string | null; _timeMode?: string | null }): boolean {
  return !canSeeTeam(user.role) && user._timeMode === 'daily'
}

export type RosterRow = {
  personId: string
  name: string
  initials: string
  /** that day's entries (plus, today, one still running from an earlier day), oldest first */
  entries: TeamEntry[]
  firstInMs: number
  /** the latest clock-out, when nothing is running */
  lastOutMs: number | null
  /** the entry running now, if any (the latest one) */
  open: TeamEntry | null
  /** the running entry began before this day: a day nobody ended */
  openFromEarlierDay: boolean
  /** time on the clock, overlaps counted once; a running entry counts to now */
  workedMs: number
}

export type NotInRow = {
  personId: string
  name: string
  initials: string
  /** that day's cleans with them on the crew */
  cleans: number
  firstCleanMs: number | null
}

export type Roster = { rows: RosterRow[]; notIn: NotInRow[] }

const startOf = (e: TeamEntry) => Date.parse(e.clocked_in_at)
const endOf = (e: TeamEntry) => (e.clocked_out_at ? Date.parse(e.clocked_out_at) : null)

export function displayName(p: TeamPerson | undefined | null): string {
  return (p?.full_name || '').trim() || '—'
}

/** "Jennifer Cole" → "JC", "Lilly" → "L", "JENNIFER C." → "JC". */
export function initials(name: string): string {
  // Leading punctuation off each word ("(Lilly)"); no \p{L}, which not every
  // Hermes build parses.
  const words = name.trim().split(/\s+/).map(w => w.replace(/^[^A-Za-z0-9À-ÖØ-öø-ÿ]+/, '')).filter(Boolean)
  if (!words.length) return '?'
  const first = words[0][0] ?? ''
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : ''
  return (first + last).toUpperCase() || '?'
}

/**
 * The entries that belong to a day: those clocked in during it. Today also
 * keeps one still running from an earlier day (forgotten, or the day before's
 * late start), so the person shows as on the clock rather than "not in".
 */
export function dayEntries(entries: TeamEntry[], dayStartMs: number, dayEndMs: number, isToday: boolean): TeamEntry[] {
  return entries.filter(e => {
    const s = startOf(e)
    if (!Number.isFinite(s)) return false
    if (s >= dayStartMs && s < dayEndMs) return true
    return isToday && !e.clocked_out_at && s < dayStartMs
  })
}

/** Time covered by the entries, overlaps once; a running one counts to now. */
export function workedMs(entries: TeamEntry[], nowMs: number): number {
  const spans = entries
    .map(e => { const s = startOf(e); const end = endOf(e) ?? nowMs; return [s, Math.max(s, end)] as const })
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e))
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let cs = -Infinity, ce = -Infinity
  for (const [s, e] of spans) {
    if (s > ce) {
      if (ce > cs) total += ce - cs
      cs = s; ce = e
    } else if (e > ce) ce = e
  }
  if (ce > cs) total += ce - cs
  return total
}

/** Can this person be on the clock today? Active and not removed. */
function isWorking(p: TeamPerson): boolean {
  return p.is_active !== false && !p.removed_at
}

export function buildRoster(p: {
  people: TeamPerson[]
  /** entries read around the day (the screen reads 16 h either side) */
  entries: TeamEntry[]
  cleans?: TeamClean[]
  dayStartMs: number
  dayEndMs: number
  nowMs: number
  isToday: boolean
}): Roster {
  const byId = new Map(p.people.map(x => [x.id, x]))
  const mine = new Map<string, TeamEntry[]>()
  for (const e of dayEntries(p.entries, p.dayStartMs, p.dayEndMs, p.isToday)) {
    const list = mine.get(e.user_id) ?? []
    list.push(e)
    mine.set(e.user_id, list)
  }

  const rows: RosterRow[] = []
  for (const [personId, list] of mine) {
    const entries = list.slice().sort((a, b) => startOf(a) - startOf(b))
    const running = entries.filter(e => !e.clocked_out_at)
    const open = running.length ? running[running.length - 1] : null
    const ends = entries.map(endOf).filter((x): x is number => x != null && Number.isFinite(x))
    const name = displayName(byId.get(personId))
    rows.push({
      personId, name, initials: initials(name), entries,
      firstInMs: startOf(entries[0]),
      lastOutMs: open ? null : (ends.length ? Math.max(...ends) : null),
      open,
      openFromEarlierDay: !!open && startOf(open) < p.dayStartMs,
      workedMs: workedMs(entries, p.nowMs),
    })
  }
  rows.sort((a, b) => a.firstInMs - b.firstInMs || a.name.localeCompare(b.name))

  const cleans = (p.cleans ?? []).filter(c => c.status !== 'cancelled')
  const notIn: NotInRow[] = p.people
    .filter(x => isWorking(x) && !mine.has(x.id))
    .map(x => {
      const theirs = cleans.filter(c => c.crew.includes(x.id))
      const starts = theirs.map(c => Date.parse(c.scheduled_start || '')).filter(Number.isFinite)
      const name = displayName(x)
      return { personId: x.id, name, initials: initials(name), cleans: theirs.length, firstCleanMs: starts.length ? Math.min(...starts) : null }
    })
    // On the schedule first, by their first clean; then everyone else by name.
    .sort((a, b) => {
      if ((a.cleans > 0) !== (b.cleans > 0)) return a.cleans > 0 ? -1 : 1
      if (a.firstCleanMs != null && b.firstCleanMs != null && a.firstCleanMs !== b.firstCleanMs) return a.firstCleanMs - b.firstCleanMs
      return a.name.localeCompare(b.name)
    })
  return { rows, notIn }
}

/** Whole hours and minutes in a span. Running clocks round down (never ahead
 *  of the clock); a finished span rounds to the minute, as duration_minutes does. */
export function hoursMinutes(ms: number, running: boolean): { h: number; m: number } {
  const mins = Math.max(0, running ? Math.floor(ms / 60_000) : Math.round(ms / 60_000))
  return { h: Math.floor(mins / 60), m: mins % 60 }
}

/** The start of the person's next entry of the same kind after this one (the
 *  next clock-in on the same job, for a per-job entry), or null. An end can't
 *  go past it (lib/endDay validateEnd). */
export function nextStartAfter(entry: TeamEntry, all: TeamEntry[]): number | null {
  const s = startOf(entry)
  const shift = entry.entry_type === 'shift'
  const later = all
    .filter(e => e.id !== entry.id && e.user_id === entry.user_id && startOf(e) > s)
    .filter(e => (shift ? e.entry_type === 'shift' : e.entry_type !== 'shift' && !!entry.job_id && e.job_id === entry.job_id))
    .map(startOf)
  return later.length ? Math.min(...later) : null
}

/** A day's cleans as lib/endDay's suggestEnd wants them, for one person. */
export function cleansFor(personId: string, cleans: TeamClean[]) {
  return cleans
    .filter(c => c.crew.includes(personId) || c.completed_by_user_id === personId)
    .map(c => ({
      id: c.id, status: c.status, completedAt: c.completed_at ?? null,
      completedById: c.completed_by_user_id ?? null, assigned: c.crew.includes(personId),
    }))
}

// ── Typing a time ────────────────────────────────────────────────────────────

export type Meridiem = 'am' | 'pm'

/**
 * A typed time of day → 24-hour hour and minute, or null. Takes "8:21",
 * "821", "8", "08.21", "8:21 pm", "8:21p" and "14:05". An am/pm typed in the
 * text wins over the toggle; a 24-hour time (13-23, or 0) ignores the toggle.
 */
export function parseClock(text: string, meridiem: Meridiem): { h: number; mi: number } | null {
  let s = (text || '').trim().toLowerCase().replace(/\s+/g, '')
  let mer: Meridiem = meridiem
  const tail = /(a|p)\.?(m\.?)?$/.exec(s)
  if (tail) { mer = tail[1] === 'a' ? 'am' : 'pm'; s = s.slice(0, tail.index) }
  let h: number, mi: number
  const sep = /^(\d{1,2})[:.h](\d{2})$/.exec(s)
  if (sep) { h = Number(sep[1]); mi = Number(sep[2]) }
  else if (/^\d{1,2}$/.test(s)) { h = Number(s); mi = 0 }
  else if (/^\d{3,4}$/.test(s)) { h = Number(s.slice(0, s.length - 2)); mi = Number(s.slice(-2)) }
  else return null
  if (h > 23 || mi > 59) return null
  if (h === 0 || h >= 13) return { h, mi }
  if (mer === 'am') return { h: h === 12 ? 0 : h, mi }
  return { h: h === 12 ? 12 : h + 12, mi }
}

/** 24-hour hour and minute → what the time field shows ("8:21" + pm). */
export function clockText(h: number, mi: number): { text: string; meridiem: Meridiem } {
  const h12 = h % 12 === 0 ? 12 : h % 12
  return { text: `${h12}:${mi < 10 ? '0' : ''}${mi}`, meridiem: h < 12 ? 'am' : 'pm' }
}

/** 'YYYY-MM-DD' moved by whole days (calendar arithmetic, no zone involved). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, (m || 1) - 1, d || 1) + n * 86_400_000)
  const pad = (x: number) => (x < 10 ? `0${x}` : String(x))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}
