// The office's "Edit time & crew" on a clean's screen (components/OfficeEditSheet).
//
// Z & K Cleaning, 2026-10-27 (Kyle, the owner): out on the road, the crew app
// showed the office every clean (Mine / Everyone, Team today) but nothing in it
// could move one or change who is on it, and the web Schedule is a desktop
// grid. Todd's call, 2026-10-28: an edit form, never drag and drop. On a phone a
// drag fights the scroll, the drop target is a few pixels, and a drop changes
// the clean (and emails people) before any warning can be read.
//
// What a save does is what the web's Edit tab does (rinsebase-app
// src/components/JobPanel.tsx, EditTab handleSave), in the same order:
//   1. A new time is recorded in job_reschedules first (who, from when, to
//      when), source 'job_edit', the web Edit tab's own value. No record, no
//      move (rinsebase-app src/lib/cleanMove.ts).
//   2. The jobs row gets the new time and manually_retimed_at, so calendar sync
//      keeps the time a person set. A crew change sets the crew size the way
//      the web does (min_crew/max_crew; at a property with a minimum, max_crew
//      only). A write that matches no row closes the record as not made.
//   3. The crew is rewritten (delete, then insert) only when it changed. The
//      database pushes each person added (trg_notify_crew_assigned, once per
//      person per clean).
//   4. A move to another day emails the crew and the client through
//      notify-reschedule, as a web Schedule drag does.
// Two things the phone adds, because the clean on screen can be an hour-old
// saved copy: the sheet reads the clean fresh when it opens (loadEditBase), and
// the jobs write only lands while the clean still has the start time and a
// not-started status the sheet read. Otherwise nothing is changed and the owner
// is told someone else got there first.
//
// The warnings are the web Edit tab's, shown on the sheet as they apply rather
// than as a run of dialogs: outside the booking window, before 7 AM or from
// 7 PM, approved time off, not on their weekly schedule, over the property's
// maximum, under its minimum. The rules are copied from the web
// (leadSelection.ts, weeklySchedule.ts, jobQueue.ts propertyMinCrew,
// bookingWindow.ts); scripts/test-office-edit.mjs runs both copies over the
// same cases when the web repo is on this machine.
//
// Online only. A move queued offline and replayed hours later would be worse
// than no move, so nothing here goes through the outbox.
import { isOfficeRole } from './jobScope'
import { dayKey, wallTimeInTz, clockInTz } from './timezone'

/** Statuses a clean can be edited in: not started. */
export const EDITABLE_STATUSES = ['pending_approval', 'scheduled', 'en_route']

/** Who sees "Edit time & crew", and on what: the office, on a clean that hasn't started. */
export function canEditClean(role: string | null | undefined, job: { status?: string | null; job_type?: string | null } | null | undefined): boolean {
  if (!job || !isOfficeRole(role)) return false
  // Cleans only for now: an inspection's or task's crew has rules of its own
  // (the booked inspector), which the web owns.
  if ((job.job_type ?? 'clean') !== 'clean') return false
  return EDITABLE_STATUSES.includes(String(job.status ?? ''))
}

// ── Lead (rinsebase-app src/lib/leadSelection.ts) ───────────────────────────

/** Seniority for leading a clean. Lower leads; an unknown role sorts last. */
const LEAD_RANK: Record<string, number> = {
  owner: 0, manager: 1, dispatcher: 2, lead_cleaner: 3, inspector: 4, cleaner: 5, trainee: 6,
  laundry_runner: 7, maintenance: 7,
}
const rankOf = (role: string | null | undefined) => (role && role in LEAD_RANK ? LEAD_RANK[role] : Number.MAX_SAFE_INTEGER)

export type LeadCandidate = { id: string; role?: string | null }

/** The most senior person picked; on a tie, the one picked first. '' for nobody. */
export function pickLead(selectedIds: string[], crew: readonly LeadCandidate[]): string {
  if (!selectedIds.length) return ''
  const roleById = new Map(crew.map(c => [c.id, c.role]))
  let bestId = selectedIds[0]
  let bestRank = rankOf(roleById.get(bestId))
  for (let i = 1; i < selectedIds.length; i++) {
    const rank = rankOf(roleById.get(selectedIds[i]))
    if (rank < bestRank) { bestId = selectedIds[i]; bestRank = rank }
  }
  return bestId
}

/** A lead already chosen stands while they are still picked; otherwise pickLead. */
export function resolveLead(currentLeadId: string | null | undefined, selectedIds: string[], crew: readonly LeadCandidate[]): string {
  if (currentLeadId && selectedIds.includes(currentLeadId)) return currentLeadId
  return pickLead(selectedIds, crew)
}

// ── Weekly schedule (rinsebase-app src/lib/weeklySchedule.ts) ───────────────

export interface WeeklyScheduleRow {
  day_of_week: number
  is_available: boolean
  every_other_week?: boolean | null
  week_anchor?: string | null
}
export type ScheduleOff = 'weekday' | 'off_week'

function ymdParts(ymd: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function daysBetween(a: string, b: string): number {
  const pa = ymdParts(a), pb = ymdParts(b)
  if (!pa || !pb) return NaN
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86_400_000)
}
/** Weekday (0 = Sunday) of a calendar date; NaN when it isn't one. */
export function weekdayOfYmd(ymd: string): number {
  const p = ymdParts(ymd)
  return p ? new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() : NaN
}
function isOnWeek(anchor: string, ymd: string): boolean {
  const weeks = Math.floor(daysBetween(anchor, ymd) / 7)
  return Number.isFinite(weeks) && ((weeks % 2) + 2) % 2 === 0
}

/** Off on `ymd` by one person's weekly schedule, and why; null when they work it (or have no schedule). */
export function scheduleOffOn(rows: WeeklyScheduleRow[], ymd: string): ScheduleOff | null {
  if (!rows.length) return null
  const dow = weekdayOfYmd(ymd)
  if (Number.isNaN(dow)) return null
  const day = rows.find(r => r.day_of_week === dow)
  if (!day || !day.is_available) return 'weekday'
  if (day.every_other_week && !(day.week_anchor && isOnWeek(day.week_anchor, ymd))) return 'off_week'
  return null
}

// ── Crew size (rinsebase-app src/lib/jobQueue.ts propertyMinCrew) ───────────

/** The property's minimum crew for this clean, or null when it sets none. */
export function propertyMinCrew(j: { job_type?: string | null; client_addresses?: { min_cleaners?: number | null } | null }): number | null {
  if ((j.job_type ?? 'clean') !== 'clean') return null
  const n = Number(j.client_addresses?.min_cleaners)
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** The property's maximum, or null when it sets none. */
export function propertyMaxCrew(j: { client_addresses?: { max_cleaners?: number | null } | null }): number | null {
  const n = Number(j.client_addresses?.max_cleaners)
  return j.client_addresses?.max_cleaners != null && Number.isInteger(n) && n >= 1 ? n : null
}

/** The crew-size columns a crew change writes (the web Edit tab's rule). At a
 *  property with a minimum, min_crew is the requirement the database set and is
 *  left alone; max_crew never drops below it. */
export function crewSizeFields(base: EditBase, crewCount: number): Record<string, number> {
  return propertyMinCrew(base) != null
    ? { max_crew: Math.max(crewCount, Number(base.min_crew ?? 1), 1) }
    : { min_crew: crewCount || 1, max_crew: crewCount || 1 }
}

// ── The clean as the sheet reads it ─────────────────────────────────────────

export interface EditBase {
  id: string
  tenant_id: string
  status: string
  job_type: string | null
  scheduled_start: string
  scheduled_end: string
  manually_retimed_at: string | null
  min_crew: number | null
  max_crew: number | null
  is_turnover: boolean | null
  reservation_id: string | null
  address_id: string | null
  client_addresses: { id?: string; nickname?: string | null; street?: string | null; max_cleaners?: number | null; min_cleaners?: number | null } | null
  /** Who is on it now: user ids in lead-first order, and the lead ('' for none). */
  crew: string[]
  lead: string
}

export interface CrewMember { id: string; full_name: string; role: string | null }

/** What the sheet edits: the day ('YYYY-MM-DD', company clock), the start on
 *  that day (null while the typed time can't be read), the length, the crew. */
export interface EditDraft {
  ymd: string
  start: { h: number; mi: number } | null
  minutes: number
  crew: string[]
  lead: string
}

/** The sheet's starting values for a clean. */
export function draftFrom(base: EditBase): EditDraft {
  const ms = Date.parse(base.scheduled_end) - Date.parse(base.scheduled_start)
  return {
    ymd: dayKey(base.scheduled_start),
    start: clockInTz(base.scheduled_start),
    minutes: ms > 0 ? Math.round(ms / 60_000) : 120,
    crew: [...base.crew],
    lead: base.lead,
  }
}

/** Lengths the sheet steps through: 15 minutes to 12 hours. */
export const LENGTH_STEP = 15
export const LENGTH_MIN = 15
export const LENGTH_MAX = 12 * 60

/** One step longer or shorter, landing on the 15-minute grid from an off-grid length. */
export function stepLength(minutes: number, dir: 1 | -1): number {
  const snapped = dir > 0
    ? Math.floor(minutes / LENGTH_STEP) * LENGTH_STEP + LENGTH_STEP
    : Math.ceil(minutes / LENGTH_STEP) * LENGTH_STEP - LENGTH_STEP
  return Math.min(LENGTH_MAX, Math.max(LENGTH_MIN, snapped))
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))

export interface EditPlan {
  /** Why it can't be saved yet; null when it can. */
  problem: 'no_time' | 'nothing' | null
  newStart: string | null
  newEnd: string | null
  timeChanged: boolean
  dayChanged: boolean
  crewChanged: boolean
}

/** What saving the draft would change. */
export function planEdit(base: EditBase, d: EditDraft): EditPlan {
  const startMs = d.start ? wallTimeInTz(d.ymd, d.start.h, d.start.mi).getTime() : NaN
  if (!Number.isFinite(startMs)) {
    return { problem: 'no_time', newStart: null, newEnd: null, timeChanged: false, dayChanged: false, crewChanged: false }
  }
  const endMs = startMs + d.minutes * 60_000
  // Instants, never strings: PostgREST spells a time '+00:00', toISOString '.000Z'.
  const timeChanged = startMs !== Date.parse(base.scheduled_start) || endMs !== Date.parse(base.scheduled_end)
  const dayChanged = d.ymd !== dayKey(base.scheduled_start)
  const crewChanged = !sameSet(d.crew, base.crew) || (d.crew.length > 0 && d.lead !== base.lead)
  return {
    problem: timeChanged || crewChanged ? null : 'nothing',
    newStart: new Date(startMs).toISOString(),
    newEnd: new Date(endMs).toISOString(),
    timeChanged, dayChanged, crewChanged,
  }
}

// ── Warnings ────────────────────────────────────────────────────────────────

/** The booking a turnover belongs between: checkout day, next guest's arrival day. */
export interface BookingWindow { lo: string; hi: string | null }

export type EditWarning =
  | { code: 'window_before'; lo: string }
  | { code: 'window_after'; hi: string }
  | { code: 'off_hours' }
  | { code: 'past' }
  | { code: 'time_off'; ids: string[] }
  | { code: 'schedule_off'; ids: string[] }
  | { code: 'over_max'; max: number; n: number }
  | { code: 'under_min'; min: number; n: number }
  | { code: 'no_crew' }

export interface WarningInputs {
  window: BookingWindow | null
  /** Approved time off covering the draft's day, by user id. */
  timeOffIds: string[]
  /** Off that day by their weekly schedule, by user id. */
  scheduleOff: Map<string, ScheduleOff>
  nowMs: number
}

/** The web Edit tab's confirmations, as they apply to this draft. Time ones
 *  only when the time changes, crew ones only for people on the clean after
 *  the save (a time change moves the people already on it too). */
export function editWarnings(base: EditBase, d: EditDraft, plan: EditPlan, inp: WarningInputs): EditWarning[] {
  if (plan.problem || !plan.newStart) return []
  const out: EditWarning[] = []
  if (plan.timeChanged) {
    const w = inp.window
    if (w && d.ymd < w.lo) out.push({ code: 'window_before', lo: w.lo })
    else if (w?.hi && d.ymd > w.hi) out.push({ code: 'window_after', hi: w.hi })
    if (d.start && (d.start.h < 7 || d.start.h >= 19)) out.push({ code: 'off_hours' })
    if (Date.parse(plan.newStart) < inp.nowMs) out.push({ code: 'past' })
  }
  // Who these apply to: everyone on it after the save when the day or crew
  // changes; nobody when only the hour moves on the same day with the same crew
  // (their day off was already their day off).
  const checkCrew = plan.dayChanged || plan.crewChanged
  if (checkCrew) {
    const off = d.crew.filter(id => inp.timeOffIds.includes(id))
    if (off.length) out.push({ code: 'time_off', ids: off })
    const sched = d.crew.filter(id => inp.scheduleOff.has(id) && !off.includes(id))
    if (sched.length) out.push({ code: 'schedule_off', ids: sched })
  }
  if (plan.crewChanged) {
    const max = propertyMaxCrew(base)
    if (max != null && d.crew.length > max) out.push({ code: 'over_max', max, n: d.crew.length })
    const min = propertyMinCrew(base)
    if (min != null && d.crew.length > 0 && d.crew.length < min) out.push({ code: 'under_min', min, n: d.crew.length })
    if (d.crew.length === 0) out.push({ code: 'no_crew' })
  }
  return out
}

// ── Reads ───────────────────────────────────────────────────────────────────

// Every FK hinted: an unhinted embed turns into a 300 the day a second FK
// appears. One literal, so scripts/test-task-pay.mjs can read the columns.
const BASE_SELECT = 'id, tenant_id, status, job_type, scheduled_start, scheduled_end, manually_retimed_at, min_crew, max_crew, is_turnover, reservation_id, address_id, client_addresses!jobs_address_id_fkey(id, nickname, street, max_cleaners, min_cleaners), job_assignments!job_assignments_job_id_fkey(user_id, is_lead)'

/** The clean, read fresh. null + error when it can't be read. */
export async function loadEditBase(db: any, jobId: string): Promise<{ base: EditBase | null; error: string | null }> {
  const { data, error } = await db.from('jobs').select(BASE_SELECT).eq('id', jobId).maybeSingle()
  if (error || !data) return { base: null, error: error?.message ?? 'not found' }
  const rows: { user_id: string; is_lead: boolean }[] = Array.isArray(data.job_assignments) ? data.job_assignments : []
  const lead = rows.find(r => r.is_lead)?.user_id ?? ''
  const crew = [...rows.filter(r => r.is_lead), ...rows.filter(r => !r.is_lead)].map(r => r.user_id)
  const { job_assignments: _a, ...rest } = data
  return { base: { ...rest, crew, lead }, error: null }
}

/** Everyone who can be put on a clean: the company's active people (the web
 *  Edit tab's list), plus anyone already on this clean who has since been
 *  deactivated, so the list never hides a person the save would keep. */
export async function loadCrew(db: any, tenantId: string, onClean: string[] = []): Promise<CrewMember[]> {
  const { data } = await db.from('users').select('id, full_name, role')
    .eq('tenant_id', tenantId).eq('is_active', true).order('full_name')
  const list = (data ?? []) as CrewMember[]
  const missing = onClean.filter(id => !list.some(c => c.id === id))
  if (missing.length) {
    const { data: more } = await db.from('users').select('id, full_name, role').in('id', missing)
    list.push(...((more ?? []) as CrewMember[]))
  }
  return list
}

/** A turnover's booking window, or null when none applies (rinsebase-app bookingWindow.ts). */
export async function loadBookingWindow(db: any, base: EditBase): Promise<BookingWindow | null> {
  if (!base.is_turnover || !base.reservation_id || !base.address_id) return null
  const { data: res } = await db.from('property_reservations')
    .select('checkout_date, status').eq('id', base.reservation_id).maybeSingle()
  if (!res || res.status === 'cancelled' || !res.checkout_date) return null
  // The next GUEST: an owner block is not an arrival and must not close the window.
  const { data: next } = await db.from('property_reservations')
    .select('checkin_date')
    .eq('address_id', base.address_id).eq('status', 'confirmed').neq('platform', 'owner_block')
    .neq('id', base.reservation_id).gte('checkin_date', res.checkout_date)
    .order('checkin_date').limit(1).maybeSingle()
  return { lo: res.checkout_date, hi: next?.checkin_date ?? null }
}

/** Approved time off and weekly-schedule days off on `ymd`, for these people.
 *  Time off through time_off_for_users(): the table itself shows each person
 *  only their own rows. */
export async function loadDayOff(db: any, tenantId: string, userIds: string[], ymd: string): Promise<{ timeOffIds: string[]; scheduleOff: Map<string, ScheduleOff> }> {
  const scheduleOff = new Map<string, ScheduleOff>()
  if (!userIds.length || Number.isNaN(weekdayOfYmd(ymd))) return { timeOffIds: [], scheduleOff }
  const [off, sched] = await Promise.all([
    db.rpc('time_off_for_users', { p_user_ids: userIds, p_start: ymd, p_end: ymd, p_statuses: ['approved'] }),
    // '*': every_other_week / week_anchor are read when there, never required.
    db.from('crew_availability').select('*').eq('tenant_id', tenantId).in('user_id', userIds),
  ])
  const timeOffIds = [...new Set(((off.data ?? []) as { user_id: string }[]).map(r => r.user_id))]
  const byUser: Record<string, WeeklyScheduleRow[]> = {}
  for (const r of (sched.data ?? []) as (WeeklyScheduleRow & { user_id: string })[]) (byUser[r.user_id] ??= []).push(r)
  for (const [id, rows] of Object.entries(byUser)) {
    const why = scheduleOffOn(rows, ymd)
    if (why) scheduleOff.set(id, why)
  }
  return { timeOffIds, scheduleOff }
}

// ── The save ────────────────────────────────────────────────────────────────

export type SaveOutcome =
  | { ok: true; timeChanged: boolean; dayChanged: boolean; crewChanged: boolean; retimedAt: string | null }
  /** Nothing on the clean changed. `stale`: it moved, started or went since the sheet read it. */
  | { ok: false; stage: 'record' | 'job'; stale: boolean; error: string | null }
  /** The time (if any) is saved; the crew isn't. The clean may now have nobody on it. */
  | { ok: false; stage: 'crew'; stale: false; error: string; timeChanged: boolean; dayChanged: boolean; retimedAt: string | null }

/**
 * Save the draft: record → jobs → crew → tell people. `me` is users.id (RLS:
 * changed_by = get_my_user_id()). `newBatchId` is a fresh uuid.
 */
export async function saveEdit(db: any, p: {
  base: EditBase
  draft: EditDraft
  me: string
  newBatchId: () => string
  now?: () => string
}): Promise<SaveOutcome> {
  const { base, draft, me } = p
  const plan = planEdit(base, draft)
  if (plan.problem || !plan.newStart || !plan.newEnd) return { ok: false, stage: 'job', stale: false, error: plan.problem }
  const stamp = p.now?.() ?? new Date().toISOString()

  // 1. The record, before anything moves.
  let recordId: string | null = null
  if (plan.timeChanged) {
    const { data: saved, error } = await db.from('job_reschedules').insert({
      tenant_id: base.tenant_id,
      job_id: base.id,
      batch_id: p.newBatchId(),
      source: 'job_edit',
      old_start: new Date(Date.parse(base.scheduled_start)).toISOString(),
      old_end: base.scheduled_end ? new Date(Date.parse(base.scheduled_end)).toISOString() : null,
      old_manually_retimed_at: base.manually_retimed_at ?? null,
      new_start: plan.newStart,
      new_end: plan.newEnd,
      changed_by: me,
    }).select('id').single()
    if (error || !saved?.id) return { ok: false, stage: 'record', stale: false, error: error?.message ?? 'no row came back' }
    recordId = saved.id
  }

  // 2. The clean: only while it still has the start the sheet read and hasn't started.
  const fields: Record<string, unknown> = {
    ...(plan.crewChanged ? crewSizeFields(base, draft.crew.length) : {}),
    ...(plan.timeChanged ? { scheduled_start: plan.newStart, scheduled_end: plan.newEnd, manually_retimed_at: stamp } : {}),
  }
  const { data: wrote, error: jobErr } = await db.from('jobs')
    .update(fields)
    .eq('id', base.id)
    .eq('scheduled_start', base.scheduled_start)
    .in('status', EDITABLE_STATUSES)
    .select('id')
  if (jobErr || !wrote?.length) {
    // Closed as not made: the move never happened, so the activity leaves it out.
    if (recordId) {
      await db.from('job_reschedules')
        .update({ undone_at: stamp, undone_by: me, not_made: true })
        .eq('id', recordId).is('undone_at', null)
    }
    return { ok: false, stage: 'job', stale: !jobErr, error: jobErr?.message ?? null }
  }

  // 3. The crew, only when it changed.
  let crewErr: string | null = null
  if (plan.crewChanged) {
    const { error: delErr } = await db.from('job_assignments').delete().eq('job_id', base.id)
    crewErr = delErr?.message ?? null
    if (!crewErr && draft.crew.length > 0) {
      const lead = draft.crew.includes(draft.lead) ? draft.lead : draft.crew[0]
      const { error: insErr } = await db.from('job_assignments').insert(
        draft.crew.map(userId => ({ tenant_id: base.tenant_id, job_id: base.id, user_id: userId, is_lead: userId === lead })),
      )
      crewErr = insErr?.message ?? null
    }
  }

  // 4. A new day: the crew (as it is now) and the client hear about it, as
  // after a web Schedule drag, even when the crew change failed: the clean has
  // moved either way. A failed send never undoes the save.
  if (plan.dayChanged) {
    try {
      await db.functions.invoke('notify-reschedule', {
        body: { job_id: base.id, tenant_id: base.tenant_id, old_start: base.scheduled_start, new_start: plan.newStart },
      })
    } catch { /* the save stands; the email is best effort, as on the web */ }
  }
  const retimedAt = plan.timeChanged ? stamp : null
  if (crewErr) {
    return { ok: false, stage: 'crew', stale: false, error: crewErr, timeChanged: plan.timeChanged, dayChanged: plan.dayChanged, retimedAt }
  }
  return { ok: true, timeChanged: plan.timeChanged, dayChanged: plan.dayChanged, crewChanged: plan.crewChanged, retimedAt }
}
