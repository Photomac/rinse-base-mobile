// The Profile tab's Sign out: what it signs out, and what the confirm says
// first.
//
// Why (CKS Perfections, 2026-11-16): a cleaner's app showed the login screen
// one morning, her iPhone then hid the saved password behind a Face ID check
// that failed, and she couldn't clock in for her first cleans. The server log
// showed the phone's own Sign out button (confirmed through "Are you sure?").
// That sign-out used supabase-js's default scope, GLOBAL, which ends the
// person's sign-in on every device. The owner asked for a warning before crew
// get signed out, because that is how clock-ins get missed.
//
// So:
// - signOutThisPhone() ends the sign-in on THIS phone only (scope 'local'),
//   the same call the automatic refusal makes (App.tsx, lib/signInRefusal.ts).
//   It still fires SIGNED_OUT, so App.tsx still clears the offline copies.
// - signOutConfirm() says plainly that they'll need their password to get
//   back in, and, when it knows, that they're clocked in or have cleans left
//   today.
//
// The facts come from reads the app already makes and saves; nothing new and
// nothing heavy on the tap:
// - Clocked in: the location tracker's open-punch read (openPunchesRead in
//   locationTracker.ts, the read checkWork() decides "working" from), live
//   when it answers quickly, else its saved copy, with clock-ins and
//   clock-outs queued offline laid over it. Any open punch counts: a per-job
//   clock or a day shift.
// - Cleans left today: Home's saved day read (dash:today). The person's own
//   cleans, today in the company's zone, not finished or called off, with
//   queued status changes laid over. Home's read carries tomorrow too, so
//   last night's copy still holds this morning's cleans with no signal.
// What it can't tell (no saved copy, a failed read) it doesn't mention: the
// confirm never claims something it can't see.
import { isMyJob } from './jobScope'
import { dayKey } from './timezone'
import type { TranslationKey } from './i18n'

/** Sign this phone out, and only this phone. Never the default (global)
 *  scope, which signs the person out on every device they use. */
export function signOutThisPhone(auth: { signOut: (o: { scope: 'local' }) => Promise<unknown> }): Promise<unknown> {
  return auth.signOut({ scope: 'local' })
}

/** Statuses that are still work today. Not pending_approval: the office
 *  hasn't confirmed those cleans yet. */
export const CLEAN_LEFT_STATUSES: readonly string[] = ['scheduled', 'en_route', 'in_progress']

/** null = unknown, and then the confirm says nothing about it. */
export interface SignOutFacts {
  clockedIn: boolean | null
  cleansLeft: number | null
}

/** Any punch with no clock-out: checkWork()'s own test for "working". */
export function isOnTheClock(rows: any[], userId: string): boolean {
  return rows.some(e => e && e.user_id === userId && !e.clocked_out_at)
}

/** The viewer's own cleans on `today` (company zone) that are still to do. */
export function cleansLeftToday(rows: any[], userId: string, today: string): number {
  return rows.filter(j => isMyJob(j, userId)
    && dayKey(j.scheduled_start) === today
    && CLEAN_LEFT_STATUSES.includes(j.status)).length
}

export interface SignOutFactsIO {
  userId: string
  /** Today's 'YYYY-MM-DD' in the company's zone (todayKey()). */
  today: string
  /** The open-punch rows (live or saved), or null when there's nothing to go on. */
  openPunches: () => Promise<any[] | null>
  /** Home's saved day rows, or null when nothing is saved. */
  dayRows: () => Promise<any[] | null>
  /** outbox.overlayPending: queued offline writes laid over rows. */
  overlay: (table: string, rows: any[], include?: (v: Record<string, any>) => boolean) => Promise<any[]>
  /** The most the confirm waits for either read; past it, that fact is
   *  unknown. (With nothing saved, a live read on a link that swallows
   *  requests would otherwise hold the confirm for the 15 s read deadline.) */
  deadlineMs: number
}

/** The answer, or null once `ms` passes (or on a failure). */
function within<T>(p: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: any
  return Promise.race([
    Promise.resolve().then(p).catch(() => null),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export async function loadSignOutFacts(io: SignOutFactsIO): Promise<SignOutFacts> {
  const [punches, day] = await Promise.all([
    within(io.openPunches, io.deadlineMs),
    within(io.dayRows, io.deadlineMs),
  ])
  let clockedIn: boolean | null = null
  let cleansLeft: number | null = null
  try {
    // A clock-in made offline is a queued upsert; a clock-out or pause is a
    // queued update that stamps clocked_out_at on it (as checkWork does).
    if (punches) clockedIn = isOnTheClock(await io.overlay('job_time_entries', punches, v => v.user_id === io.userId), io.userId)
  } catch { clockedIn = null }
  try {
    if (day) cleansLeft = cleansLeftToday(await io.overlay('jobs', day), io.userId, io.today)
  } catch { cleansLeft = null }
  return { clockedIn, cleansLeft }
}

type Tr = (key: TranslationKey) => string

/** The confirm's title and body. Facts that are unknown or nothing (not
 *  clocked in, no cleans left) say nothing. */
export function signOutConfirm(facts: SignOutFacts | null, t: Tr): { title: string; body: string } {
  const lines: string[] = []
  if (facts?.clockedIn) lines.push(t('sign_out_clocked_in'))
  const n = facts?.cleansLeft ?? 0
  if (n === 1) lines.push(t('sign_out_cleans_one'))
  else if (n > 1) lines.push(t('sign_out_cleans_many').split('{n}').join(String(n)))
  const password = t('sign_out_password')
  const body = lines.length
    ? `${lines.join('\n')}\n\n${password} ${t('sign_out_until')}`
    : password
  return { title: t('sign_out_title'), body }
}
