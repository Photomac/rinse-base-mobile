// The room-by-room inspection walkthrough, as the crew app reads it.
//
// The office writes the list in Settings → Services (web). The database puts
// it on the job as job_checklist_items rows with sort_order >= 20000 and no
// room: room = the section label ("Bedroom 2"), item_kind 'verify', plus
// follow_up / info_key / photo_required (web migration
// 20261013131047_inspection_walkthrough). It's the same list on an inspection
// visit and on a clean booked as the inspection service.
//
// No imports, so src/lib/__tests__/walkthrough.scenario.ts can run it as is.

export const WALKTHROUGH_BAND = 20000

export interface WalkthroughLine {
  id: string
  room: string
  task: string
  sort_order: number
  result: 'ok' | 'issue' | 'na' | null
  issue_note: string | null
  photo_required: boolean
  follow_up: 'deep_clean' | 'maintenance' | null
  info_key: string | null
}

export interface WalkthroughSection {
  name: string
  lines: WalkthroughLine[]
}

/** A job whose checklist is the walkthrough: it has rows and every one is in
 *  the band. (The database never mixes the two on one job.) */
export function isWalkthroughJob(rows: { sort_order?: number | null }[]): boolean {
  return rows.length > 0 && rows.every(r => (r.sort_order ?? 0) >= WALKTHROUGH_BAND)
}

/** Sections in walk order: consecutive lines with the same label, by sort_order. */
export function groupWalkthrough(lines: WalkthroughLine[]): WalkthroughSection[] {
  const sorted = lines
    .filter(l => (l.sort_order ?? 0) >= WALKTHROUGH_BAND)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
  const out: WalkthroughSection[] = []
  for (const l of sorted) {
    const last = out[out.length - 1]
    if (last && last.name === l.room) last.lines.push(l)
    else out.push({ name: l.room, lines: [l] })
  }
  return out
}

export function sectionState(s: WalkthroughSection) {
  const answered = s.lines.filter(l => l.result != null).length
  const issues = s.lines.filter(l => l.result === 'issue').length
  const open = s.lines.filter(l => l.result == null).map(l => l.id)
  return { answered, total: s.lines.length, issues, open, done: answered === s.lines.length }
}

const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Tue & Fri" for client_addresses.trash_pickup_days, in the crew's
 *  language when the device can name weekdays; null when unset. */
export function pickupDaysLabel(days: number[] | null | undefined, locale?: string, and = '&'): string | null {
  const valid = [...new Set((days ?? []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
  if (!valid.length) return null
  const name = (d: number) => {
    if (!locale) return DAY_EN[d]
    try {
      // 2026-01-04 is a Sunday.
      return new Date(2026, 0, 4 + d).toLocaleDateString(locale, { weekday: 'short' })
    } catch {
      return DAY_EN[d]
    }
  }
  const names = valid.map(name)
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`
}
