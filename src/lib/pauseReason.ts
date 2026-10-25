// job_time_entries.pause_reason, shown in the crew's language.
//
// The column stays English: the office reads it on Payroll and Team, and the
// web, the nightly auto-close and the end-day RPC all write it in English. So
// the crew app stores the English value and translates on display. A note the
// office typed by hand, or any value not listed here, shows as written.
//
// Several notes can share one entry, joined by " · " (the crew paused for a
// supply run, then the office ended the day): each part is translated alone.
import type { TranslationKey } from './i18n'

/** The crew's own Pause reasons: the stored value and its label. */
export const PAUSE_REASONS = [
  { value: 'Waiting for laundry', key: 'waiting_laundry' as const },
  { value: 'Going to another job', key: 'going_another_job' as const },
  { value: 'Supply run', key: 'supply_run' as const },
  { value: 'Waiting for access', key: 'waiting_access' as const },
  { value: 'Break', key: 'break_time' as const },
  { value: 'Other', key: 'other' as const },
]

// Fixed notes other writers leave (rinsebase-app: shift auto-close and
// one-open-day-shift migrations, Payroll/JobPanel manual entry, an older
// Payroll close-out still on 13 entries; this app's outbox when a queued
// start lands after a new day). Checked before the "by <name>" notes below.
const SYSTEM_NOTES: Record<string, TranslationKey> = {
  'Auto-closed: forgot to clock out': 'pr_auto_forgot',
  'Auto-closed: a new day was started': 'pr_auto_new_day',
  'Auto-closed: another day shift started, ended at its start': 'pr_auto_next_shift',
  'Auto-closed: inside another day shift, ended with it': 'pr_auto_inside_shift',
  // The company's own close time (Payroll's "Close open days at", rinsebase-app
  // 20261023170814_day_shift_close_time).
  'Auto-closed: ended at the last clean of the day': 'pr_auto_last_clean',
  'Auto-closed: no clean finished, ended at the closing time': 'pr_auto_closing_time',
  // ...and leaving that clean's home or the office after it, with arrive/leave
  // on (rinsebase-app 20261023210200_complete_cleans_left_behind).
  'Auto-closed: ended when they left the last home': 'pr_auto_left_home',
  'Auto-closed: ended when they left the office': 'pr_auto_left_office',
  'Manual entry by owner': 'pr_manual_owner',
  'Clocked out by owner (left open)': 'pr_clocked_out_owner_open',
}

// lib/endDay.ts endedNote / startedNote (and the web's), which name who did
// it, or say "the office" when the name couldn't be read. That one is a whole
// phrase per language: Portuguese contracts "por o" to "pelo".
const BY_NOTES: [RegExp, TranslationKey, TranslationKey][] = [
  [/^Day ended by (.+)$/, 'pr_day_ended_by', 'pr_day_ended_office'],
  [/^Clocked out by (.+)$/, 'pr_clocked_out_by', 'pr_clocked_out_office'],
  [/^Day started by (.+)$/, 'pr_day_started_by', 'pr_day_started_office'],
]

const KNOWN: Record<string, TranslationKey> = {
  ...Object.fromEntries(PAUSE_REASONS.map(r => [r.value, r.key])),
  ...SYSTEM_NOTES,
}

function part(p: string, t: (k: TranslationKey) => string): string {
  const key = KNOWN[p]
  if (key) return t(key)
  for (const [re, byName, byOffice] of BY_NOTES) {
    const m = p.match(re)
    if (m) return m[1] === 'the office' ? t(byOffice) : t(byName).split('{who}').join(m[1])
  }
  return p
}

export function pauseReasonLabel(reason: string | null | undefined, t: (k: TranslationKey) => string): string {
  if (!reason) return ''
  return reason.split(' · ').map(p => part(p.trim(), t)).join(' · ')
}
