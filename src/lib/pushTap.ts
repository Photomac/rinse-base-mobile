// Tapping a crew job push opens the job it is about.
//
// The server sends three pushes about a crew member's clean, all with data
// { type, jobId, tenantId }: 'job_assigned' (notify-crew-assigned: the office
// put them on it), 'job_reminder' (send-job-reminders: the day-before
// reminder, which replaces most crew texts) and 'home_prepped'
// (notify-home-prepped, rinse-base-app 2026-10-21: "Catherine has prepped
// CAYUSE B for you.", jobId = their next clean there). A tap used to open the app
// wherever it was (Home on a cold start), and the crew member had to go and
// find the job.
//
// What a tap does now (App.tsx wires it; this file decides):
// - Opens the job's screen with the row Schedule would hand it: the same
//   columns (SCHEDULE_JOB_SELECT), and only a job Schedule lists for this
//   person: not cancelled, and for crew one they are on. An office phone opens
//   any of the company's, as its Schedule shows them all.
// - No signal: the saved copy, from the offline day pack's Home read, else
//   Schedule's own. A weak link gets LIVE_WAIT_MS before the saved copy is
//   used, so a tap on one bar doesn't sit for the 15 s read deadline.
// - A job it can't have (gone, taken off it, cancelled, not on the phone):
//   the Schedule tab instead.
// - Over a full screen (a job, a chat thread, SOS, Mileage or Team today) the
//   tap waits, and opens when the person is back on the tabs, unless it is
//   about the job already open. Those screens hold what only they keep: a
//   clean's timer and checklist mid-tick, the camera, a half-typed message, an
//   SOS still sending, a trip on the odometer. None has a back stack, so the
//   tapped job could not hand the person back to where they were. A tap still
//   waiting after QUEUE_MAX_MS is dropped rather than spring a job on someone
//   leaving a clean an hour later.
// - Each tap is handled once (tapLedger, by notification id), whether it
//   reaches the app as the tap that launched it or while it runs.
// - Any other push, a push with no job id, or one for another company than
//   the account on the phone: nothing, as before.
//
// Pure apart from what `io` and the ledger's store do, so
// scripts/test-push-tap.mjs runs it with fakes.
import { isMyJob, isOfficeRole } from './jobScope'

/** The pushes a tap opens a job for (data.type). */
export const JOB_PUSH_TYPES = ['job_reminder', 'job_assigned', 'home_prepped']

/** How long a tap waits for the live job before using the saved copy. */
export const LIVE_WAIT_MS = 4000

/** How long a tap waits behind a full screen before it is dropped. */
export const QUEUE_MAX_MS = 10 * 60_000

/** Handled notification ids kept on the phone (tapLedger). */
export const HANDLED_KEEP = 20
export const HANDLED_TAPS_KEY = 'pushTap:handled'

/** ScheduleScreen's columns, so the job screen gets the row it gets from
 *  Schedule. scripts/test-push-tap.mjs fails if the two drift apart. */
export const SCHEDULE_JOB_SELECT = 'id, job_number, status, scheduled_start, scheduled_end, is_turnover, route_order, window_minutes, job_type, internal_notes, source_report_id, service_types!jobs_service_id_fkey(name), clients!jobs_client_id_fkey(full_name, client_type), client_addresses!jobs_address_id_fkey(id, street, city, nickname, photo_url), job_assignments(user_id), crew:job_assignments!job_assignments_job_id_fkey(user_id, is_lead, users!job_assignments_user_id_fkey(full_name))'

/** The saved reads a tap looks in with no signal, best first: Home's day
 *  (lib/jobReads dashTodayRead, which the offline day pack keeps), then
 *  Schedule's copy (its cachedQuery key), which reaches further ahead. */
export function savedKeys(userId: string): string[] {
  return [`dash:today:${userId}`, `sched:${userId}`]
}

/** The job a tapped push is about, or null when the tap should do nothing. */
export function tappedJobId(data: any, tenantId: string | null | undefined): string | null {
  if (!data || !JOB_PUSH_TYPES.includes(data.type)) return null
  const id = typeof data.jobId === 'string' ? data.jobId.trim() : ''
  if (!id) return null
  // Another company's push on a phone signed in to this one (a shared phone).
  if (data.tenantId && tenantId && data.tenantId !== tenantId) return null
  return id
}

/** What App.tsx has on screen, in the order its render picks them. */
export type OnScreen =
  | { what: 'tabs' }
  | { what: 'job'; jobId: string }
  | { what: 'chat' }
  | { what: 'sos' }
  | { what: 'sub' }

export function onScreen(s: { selectedJob: any; activeChannel: any; showSOS: boolean; subScreen: string | null }): OnScreen {
  if (s.activeChannel) return { what: 'chat' }
  if (s.showSOS) return { what: 'sos' }
  if (s.subScreen) return { what: 'sub' }
  if (s.selectedJob) return { what: 'job', jobId: s.selectedJob.id }
  return { what: 'tabs' }
}

/** 'now': open it. 'wait': behind a full screen, until the tabs are back.
 *  'here': the job is the one already open. */
export type TapWhen = 'now' | 'wait' | 'here'

export function tapWhen(screen: OnScreen, jobId: string): TapWhen {
  if (screen.what === 'tabs') return 'now'
  if (screen.what === 'job' && screen.jobId === jobId) return 'here'
  return 'wait'
}

export function stillWanted(queuedAt: number, now: number): boolean {
  return now - queuedAt <= QUEUE_MAX_MS
}

/** A job Schedule lists for this person: not cancelled; crew only their own. */
export function openable(job: any, user: any): boolean {
  if (!job?.id || job.status === 'cancelled') return false
  return isOfficeRole(user?.role) || isMyJob(job, user?.id)
}

export interface TapIO {
  /** The job, live, as supabase-js answers: status 0 = the network failed. */
  live: (jobId: string) => PromiseLike<{ data: any; error: any; status?: number }>
  /** A saved read, by cache key (lib/dataCache readCacheEntry). */
  saved: (key: string) => Promise<any>
  /** Writes still queued on this phone, laid over the rows (lib/outbox). */
  overlay: (rows: any[]) => Promise<any[]>
  wait?: (ms: number) => Promise<void>
}

export type TappedJob = { job: any; fromCache: boolean } | null

type Live = { offline: true } | { offline: false; job: any }
const OFFLINE: Live = { offline: true }

async function savedJob(jobId: string, user: any, io: TapIO): Promise<any | null> {
  for (const key of savedKeys(user.id)) {
    let rows: any = null
    try { rows = await io.saved(key) } catch { /* nothing saved there */ }
    const hit = Array.isArray(rows) ? rows.find((r: any) => r?.id === jobId) : null
    if (hit) return hit
  }
  return null
}

/** The tapped job, ready for JobDetailScreen, or null (open Schedule). */
export async function loadTappedJob(jobId: string, user: any, io: TapIO): Promise<TappedJob> {
  const wait = io.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  // A server answer (no row, RLS, a 4xx) is final, as in lib/dataCache: only
  // the network's silence falls back to the saved copy.
  const live: Promise<Live> = Promise.resolve()
    .then(() => io.live(jobId))
    .then((r: any) => (r?.error ? ((Number(r.status) || 0) === 0 ? OFFLINE : { offline: false, job: null }) : { offline: false, job: r?.data ?? null }),
      () => OFFLINE)
  let answer: Live | null = await Promise.race([live, wait(LIVE_WAIT_MS).then(() => null)])
  let job: any = null
  let fromCache = false
  if (!answer) {
    // A slow link: the saved copy now if there is one, else the live answer.
    job = await savedJob(jobId, user, io)
    if (job) fromCache = true
    else answer = await live
  }
  if (answer?.offline) {
    job = await savedJob(jobId, user, io)
    fromCache = !!job
  } else if (answer) {
    job = answer.job
  }
  if (!job) return null
  let shown = job
  try { shown = (await io.overlay([job]))[0] ?? job } catch { /* the row as read */ }
  return openable(shown, user) ? { job: shown, fromCache } : null
}

/**
 * The tap's moves, in order: open now or wait behind a full screen, re-check
 * what is on screen once the job has loaded (the person may have opened
 * something meanwhile), and a later tap replaces an earlier one still loading
 * or waiting. App.tsx calls tap() for each new tap and screenChanged() when
 * what it shows changes.
 */
export function tapRouter(d: {
  screen: () => OnScreen
  load: (jobId: string) => Promise<TappedJob>
  openJob: (job: any) => void
  openSchedule: () => void
  now?: () => number
}) {
  const now = d.now ?? (() => Date.now())
  let waiting: { jobId: string; at: number } | null = null
  let seq = 0

  async function open(jobId: string): Promise<void> {
    const mine = ++seq
    let got: TappedJob = null
    try { got = await d.load(jobId) } catch { /* as if not found */ }
    if (mine !== seq) return // a later tap took over
    const when = tapWhen(d.screen(), jobId)
    if (when === 'here') return
    if (when === 'wait') { waiting = { jobId, at: now() }; return }
    if (got) d.openJob(got.job)
    else d.openSchedule()
  }

  return {
    tap(jobId: string): Promise<void> {
      seq++ // drops an earlier tap still loading
      const when = tapWhen(d.screen(), jobId)
      waiting = when === 'wait' ? { jobId, at: now() } : null
      return when === 'now' ? open(jobId) : Promise.resolve()
    },
    screenChanged(): Promise<void> {
      const w = waiting
      if (!w) return Promise.resolve()
      if (!stillWanted(w.at, now())) { waiting = null; return Promise.resolve() }
      const when = tapWhen(d.screen(), w.jobId)
      if (when === 'wait') return Promise.resolve()
      waiting = null
      return when === 'now' ? open(w.jobId) : Promise.resolve()
    },
    /** The job a tap is waiting to open, if any. */
    waiting: (): string | null => waiting?.jobId ?? null,
  }
}

/** Remembers handled taps across launches. `store` = AsyncStorage.
 *  Keyed by the notification's request id, which is per push on both
 *  platforms (iOS: the APNs request; Android: FCM's message id) as long as the
 *  sender sets no Android `tag`: one that did would have to make it unique. */
export function tapLedger(store: { getItem: (k: string) => Promise<string | null>; setItem: (k: string, v: string) => Promise<void> }) {
  const handled = new Set<string>()
  return {
    /** True the first time this notification id is seen, on this phone. */
    async first(id: string): Promise<boolean> {
      if (!id || handled.has(id)) return false
      handled.add(id)
      let seen: string[] = []
      try {
        const raw = JSON.parse((await store.getItem(HANDLED_TAPS_KEY)) || '[]')
        if (Array.isArray(raw)) seen = raw.filter(x => typeof x === 'string')
      } catch { /* unreadable: treat as none */ }
      if (seen.includes(id)) return false
      try { await store.setItem(HANDLED_TAPS_KEY, JSON.stringify([...seen, id].slice(-HANDLED_KEEP))) } catch { /* best effort */ }
      return true
    },
  }
}
