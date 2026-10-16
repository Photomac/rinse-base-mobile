// The cached reads behind Home, a job's screen, its Supplies and walkthrough,
// and the prep card — built HERE and nowhere else.
//
// The offline day pack (lib/offlinePrefetch.ts) warms these same reads ahead
// of time so a crew member who opens the app in a dead zone still has the
// day's stops, door codes, arrival notes and checklists. That only works if
// the pack stores EXACTLY the key the screen will look up, holding EXACTLY the
// columns the screen selects. Both sides call these builders, so they cannot
// drift: scripts/test-offline-day-pack.mjs fails if a day-pack screen builds
// its own cachedQuery() key, or reads something jobPackReads() doesn't warm.
//
// Each builder returns { key, q }; q() builds the query when it runs, so
// calling a builder sends nothing.
import { supabase } from './supabase'
import type { CacheRead } from './dataCache'
import { dayKey, startOfDayInTz, endOfTomorrowInTz } from './timezone'
import { shiftYmd } from './nextArrival'
import { WALKTHROUGH_BAND, isWalkthroughJob } from './walkthrough'
import { isOfficeRole, isMyJob } from './jobScope'

/** The property a job is at, however the screen that opened it shaped the row. */
export function jobAddressId(job: any): string | null {
  return job?.client_addresses?.id || job?.address_id || null
}

/** Laundry runs, tasks and inspections: no property checklist, no supplies. */
export function isTaskJob(job: any): boolean {
  return !!job?.job_type && job.job_type !== 'clean'
}

// ── Home ────────────────────────────────────────────────────────────────────

/**
 * Home's day: the whole company's jobs from the start of today to the end of
 * TOMORROW (tenant zone). Home only ever shows today — DashboardScreen runs
 * every row, live or cached, through homeDayRows() — but the copy saved
 * tonight has to still hold the morning's jobs when the phone has no signal
 * tomorrow. (A strict today window saved at night came back EMPTY offline the
 * next morning: CKS, 2026-10-13.)
 */
export function dashTodayRead(user: any, now: Date): CacheRead {
  const from = startOfDayInTz(now)
  const to = endOfTomorrowInTz(now)
  return {
    key: `dash:today:${user.id}`,
    q: () => supabase.from('jobs')
      .select('id, job_number, tenant_id, status, scheduled_start, scheduled_end, is_turnover, route_order, window_minutes, job_type, internal_notes, service_types!jobs_service_id_fkey(name), clients!jobs_client_id_fkey(full_name, phone, client_type), client_addresses!jobs_address_id_fkey(id, street, city, nickname, lockbox_code, lat, lng, photo_url), job_assignments(user_id), crew:job_assignments!job_assignments_job_id_fkey(user_id, is_lead, users!job_assignments_user_id_fkey(full_name))')
      .eq('tenant_id', user.tenant_id)
      .gte('scheduled_start', from.toISOString())
      .lte('scheduled_start', to.toISOString())
      .order('scheduled_start'),
  }
}

/** The rows Home shows for one tenant day: the office's whole company, crew
 *  only their own. Rows outside `ymd` never pass — the read carries tomorrow,
 *  and a cached copy can be from an earlier day. */
export function homeDayRows(rows: any[] | null | undefined, user: any, ymd: string): any[] {
  return (isOfficeRole(user.role) ? (rows ?? []) : (rows ?? []).filter(j => isMyJob(j, user.id)))
    .filter(j => dayKey(j.scheduled_start) === ymd)
}

// ── A job's screen (JobDetailScreen) ────────────────────────────────────────

export const tenantVideoRead = (tenantId: string): CacheRead => ({
  key: `tenvideo:${tenantId}`,
  q: () => supabase.from('tenants')
    .select('video_walkthroughs_enabled').eq('id', tenantId).maybeSingle(),
})

/** The crew member's own route-ordered jobs on this job's day, for "Stop k of M".
 *  The day is the PHONE's calendar day, as the screen has always ranked it. */
export function routeStopRead(job: any, user: any): CacheRead {
  const day = new Date(job.scheduled_start)
  const start = new Date(day); start.setHours(0, 0, 0, 0)
  const end = new Date(day); end.setHours(23, 59, 59, 999)
  return {
    key: `route:${job.id}:${user.id}`,
    q: () => supabase.from('jobs')
      .select('id, route_order, job_assignments!inner(user_id)')
      .eq('tenant_id', user.tenant_id)
      .eq('job_assignments.user_id', user.id)
      .not('route_order', 'is', null)
      .gte('scheduled_start', start.toISOString())
      .lte('scheduled_start', end.toISOString()),
  }
}

/** Who arrives after this clean: the property's stays from the day before the
 *  clean on, and the property / company default check-in times. */
export function nextArrivalReads(job: any, addrId: string, tenantId: string) {
  const cleanYmd = dayKey(job.scheduled_start)
  return {
    stays: {
      key: `nextarr:${job.id}`,
      q: () => supabase.from('property_reservations')
        .select('id, platform, guest_name, calendar_id, checkin_date, checkout_date, checkin_time')
        .eq('address_id', addrId).eq('status', 'confirmed')
        .gte('checkout_date', shiftYmd(cleanYmd, -1))
        .order('checkin_date').limit(60),
    } as CacheRead,
    property: {
      key: `nextarr:addr:${addrId}`,
      q: () => supabase.from('client_addresses')
        .select('default_checkin_time').eq('id', addrId).maybeSingle(),
    } as CacheRead,
    company: {
      key: `nextarr:ten:${tenantId}`,
      q: () => supabase.from('tenants')
        .select('default_checkin_time').eq('id', tenantId).maybeSingle(),
    } as CacheRead,
  }
}

export const crewNoteRead = (jobId: string): CacheRead => ({
  key: `crewnote:${jobId}`,
  q: () => supabase.from('jobs')
    .select('crew_note, crew_note_at_clock_in').eq('id', jobId).maybeSingle(),
})

export const crewNoteAckRead = (jobId: string, userId: string): CacheRead => ({
  key: `crewnoteack:${jobId}:${userId}`,
  q: () => supabase.from('job_crew_note_acks')
    .select('note').eq('job_id', jobId).eq('user_id', userId),
})

/** Smart-lock code, laundry/pet flags, turnover times, client type, guest count. */
export const jobMetaRead = (jobId: string): CacheRead => ({
  key: `jobmeta:${jobId}`,
  q: () => supabase.from('jobs')
    .select('seam_access_code, laundry_done_onsite, pet_fee_applied, checkout_time, checkin_time, window_minutes, urgency, clients!jobs_client_id_fkey(client_type), property_reservations(guest_count, pet_count)')
    .eq('id', jobId)
    .maybeSingle(),
})

/** Everyone on the job, lead first. user_id is who the server counts as on
 *  it (is_my_job), even where the name can't be read. */
export const jobCrewRead = (jobId: string): CacheRead => ({
  key: `crew:${jobId}`,
  q: () => supabase.from('job_assignments')
    .select('user_id, is_lead, users!job_assignments_user_id_fkey(id, full_name)')
    .eq('job_id', jobId)
    .order('is_lead', { ascending: false }),
})

/** The property: size, crew notes, door code, arrival instructions, bag color,
 *  staging photos (URLs only), pets. */
export const propMetaRead = (addrId: string): CacheRead => ({
  key: `propmeta:${addrId}`,
  q: () => supabase.from('client_addresses')
    .select('bedrooms, bathrooms, sqft, beds, sleeps, crew_notes, lockbox_code, arrival_instructions, laundry_bag_color, staging_photos, pet_friendly, pet_fee')
    .eq('id', addrId)
    .maybeSingle(),
})

/** Every crew member's punches on the job (the on-the-clock line). */
export const crewClockRead = (jobId: string): CacheRead => ({
  key: `crewclock:${jobId}`,
  q: () => supabase.from('job_time_entries')
    .select('user_id, clocked_in_at, clocked_out_at, pause_reason')
    .eq('job_id', jobId),
})

/** The viewer's own punches on the job — or the whole job's, for desk staff
 *  recording hours on a clean they aren't crew on. */
export function timeEntriesRead(jobId: string, userId: string, wholeJob: boolean): CacheRead {
  return {
    key: `time:${jobId}:${wholeJob ? 'job' : userId}`,
    q: () => {
      let q = supabase.from('job_time_entries')
        .select(wholeJob ? '*, users!job_time_entries_user_id_fkey(full_name)' : '*')
        .eq('job_id', jobId)
      if (!wholeJob) q = q.eq('user_id', userId)
      return q.order('clocked_in_at')
    },
  }
}

export const checklistTemplateRead = (addressId: string): CacheRead => ({
  key: `tmpl:${addressId}`,
  q: () => supabase.from('address_checklist_templates')
    .select('id, room, title, sort_order, requires_photo')
    .eq('address_id', addressId)
    .order('room').order('sort_order'),
})

/** The job's own checklist rows — the list the owner dashboard reads too. */
export const checklistRowsRead = (jobId: string): CacheRead => ({
  key: `chkrows:${jobId}`,
  q: () => supabase.from('job_checklist_items')
    .select('id, room, task, sort_order, completed, photo_required, room_id, item_kind, level, result, issue_note')
    .eq('job_id', jobId)
    .order('room').order('sort_order'),
})

export const tenantSeedRead = (tenantId: string): CacheRead => ({
  key: `tenseed:${tenantId}`,
  q: () => supabase.from('tenants')
    .select('default_checklist_seed').eq('id', tenantId).maybeSingle(),
})

export const roomsRead = (addressId: string): CacheRead => ({
  key: `rooms:${addressId}`,
  q: () => supabase.from('property_rooms')
    .select('id, room_type, instance_no, name, sort_order, execution_mode')
    .eq('address_id', addressId).is('archived_at', null).order('sort_order'),
})

export const roomSignoffsRead = (jobId: string): CacheRead => ({
  key: `signoffs:${jobId}`,
  q: () => supabase.from('job_room_signoffs')
    .select('id, room_id, completed_at, job_id').eq('job_id', jobId),
})

export const addressModeRead = (addressId: string): CacheRead => ({
  key: `addrmode:${addressId}`,
  q: () => supabase.from('client_addresses')
    .select('checklist_execution_mode').eq('id', addressId),
})

export const tenantModeRead = (tenantId: string): CacheRead => ({
  key: `tenmode:${tenantId}`,
  q: () => supabase.from('tenants')
    .select('checklist_execution_mode').eq('id', tenantId),
})

export const photoRequirementsRead = (addressId: string): CacheRead => ({
  key: `preq:${addressId}`,
  q: () => supabase.from('property_photo_requirements')
    .select('id, room_id, required, area_name, sort_order, created_at')
    .eq('address_id', addressId).order('sort_order'),
})

/** Does the company hold crews to the property's required shots
 *  (tenants.enforce_photo_requirements)? The shot counter shows only when on. */
export const photoEnforceRead = (tenantId: string): CacheRead => ({
  key: `tenphotoreq:${tenantId}`,
  q: () => supabase.from('tenants')
    .select('enforce_photo_requirements').eq('id', tenantId).maybeSingle(),
})

/** The latest shot per required photo (URLs only — no image is downloaded). */
export const requirementShotsRead = (jobId: string): CacheRead => ({
  key: `pshot:${jobId}`,
  q: () => supabase.from('job_photos')
    .select('photo_requirement_id, photo_url, created_at')
    .eq('job_id', jobId).not('photo_requirement_id', 'is', null)
    .order('created_at', { ascending: false }),
})

/** Photo counts per checklist item. */
export const itemPhotosRead = (jobId: string): CacheRead => ({
  key: `photos:${jobId}`,
  q: () => supabase.from('job_photos').select('caption, checklist_item_id').eq('job_id', jobId),
})

// ── Check first (lib/checkFirst.ts) ─────────────────────────────────────────
// Each its own read, so a failed one shows nothing and blocks nothing.

/** The property's Check first lines (archived ones are never shown). */
export const checkFirstLinesRead = (addrId: string): CacheRead => ({
  key: `cflines:${addrId}`,
  q: () => supabase.from('property_check_first_lines')
    .select('id, body, photo_required, sort_order, created_at, archived_at')
    .eq('address_id', addrId).is('archived_at', null)
    .order('sort_order').order('created_at'),
})

/** Who ticked which line on this clean, and when. */
export const checkFirstTicksRead = (jobId: string): CacheRead => ({
  key: `cfticks:${jobId}`,
  q: () => supabase.from('job_check_first_ticks')
    .select('line_id, user_id, line_text, ticked_at, users!job_check_first_ticks_user_id_fkey(full_name)')
    .eq('job_id', jobId),
})

/** The photos photo lines asked for (URLs only). */
export const checkFirstPhotosRead = (jobId: string): CacheRead => ({
  key: `cfphotos:${jobId}`,
  q: () => supabase.from('job_photos')
    .select('check_first_line_id, photo_url')
    .eq('job_id', jobId).not('check_first_line_id', 'is', null),
})

/** When the clean started (daily mode has no clock-in): a line written after it doesn't block. */
export const checkFirstStartRead = (jobId: string): CacheRead => ({
  key: `cfstart:${jobId}`,
  q: () => supabase.from('jobs').select('started_at').eq('id', jobId).maybeSingle(),
})

/** The company's switch (tenants.check_first_required): lines block Complete only when on. */
export const checkFirstTenantRead = (tenantId: string): CacheRead => ({
  key: `cften:${tenantId}`,
  q: () => supabase.from('tenants')
    .select('check_first_required').eq('id', tenantId).maybeSingle(),
})

// ── Supplies (JobInventoryScreen) ───────────────────────────────────────────

export const inventoryItemsRead = (addrId: string): CacheRead => ({
  key: `inv:items:${addrId}`,
  q: () => supabase.from('address_inventory')
    .select('id, item_name, category, par_level, unit, room_id')
    .eq('address_id', addrId)
    .order('category', { nullsFirst: false })
    .order('item_name'),
})

export const inventoryLogRead = (jobId: string): CacheRead => ({
  key: `inv:log:${jobId}`,
  q: () => supabase.from('job_inventory_log')
    .select('id, job_id, inventory_id, item_name, qty_used, qty_remaining, needs_restock, notes, incident_id, restocked_at, client_notified_at, created_at')
    .eq('job_id', jobId),
})

export const inventoryRoomsRead = (addrId: string): CacheRead => ({
  key: `inv:rooms:${addrId}`,
  q: () => supabase.from('property_rooms')
    .select('id, room_type, instance_no, name, sort_order')
    .eq('address_id', addrId)
    .is('archived_at', null)
    .order('sort_order'),
})

/** Extra linen the office added for this booking on the Linen Pull Sheet. */
export const linenExtrasRead = (jobId: string): CacheRead => ({
  key: `inv:extras:${jobId}`,
  q: () => supabase.from('turnover_linen_extras')
    .select('inventory_id, extra_qty')
    .eq('job_id', jobId),
})

// ── The inspection walkthrough (WalkthroughChecklist) ───────────────────────

export const walkthroughLinesRead = (jobId: string): CacheRead => ({
  key: `wtlines:${jobId}`,
  q: () => supabase.from('job_checklist_items')
    .select('id, room, task, sort_order, result, issue_note, photo_required, follow_up, info_key')
    .eq('job_id', jobId).gte('sort_order', WALKTHROUGH_BAND).order('sort_order'),
})

export const walkthroughPhotosRead = (jobId: string): CacheRead => ({
  key: `wtphotos:${jobId}`,
  q: () => supabase.from('job_photos')
    .select('checklist_item_id').eq('job_id', jobId).not('checklist_item_id', 'is', null),
})

export const trashDaysRead = (addrId: string): CacheRead => ({
  key: `wttrash:${addrId}`,
  q: () => supabase.from('client_addresses').select('trash_pickup_days').eq('id', addrId).maybeSingle(),
})

// ── "Get ready for today" (PrepCard) ────────────────────────────────────────

/** The cleans the prep card covers: still ahead of (or under) the crew, at a
 *  real property. Laundry runs, tasks and inspections take nothing along. */
export function prepJobs(jobs: any[]): any[] {
  return jobs.filter((j: any) =>
    (j.job_type ?? 'clean') === 'clean' && j.client_addresses?.id &&
    ['scheduled', 'en_route', 'in_progress'].includes(j.status))
}

/**
 * The prep card's reads for one tenant day. Keyed by the day, so the copy the
 * day pack saves for tomorrow is not overwritten by today's card, and comes
 * back tomorrow morning with no signal. Rows are looked up by property / job
 * id, so a copy saved for a slightly different set of cleans still serves the
 * ones it holds.
 */
export function prepReads(user: any, cleans: any[], ymd: string) {
  const addrIds = [...new Set(cleans.map((j: any) => j.client_addresses.id as string))]
  const jobIds = cleans.map((j: any) => j.id as string)
  return {
    tenant: {
      key: `prep:ten:${user.tenant_id}`,
      q: () => supabase.from('tenants')
        .select('crew_prep_linens, default_checkin_time').eq('id', user.tenant_id).maybeSingle(),
    } as CacheRead,
    addresses: {
      key: `prep:addr:${user.id}:${ymd}`,
      q: () => supabase.from('client_addresses')
        .select('id, lockbox_code, arrival_instructions, laundry_bag_color, default_checkin_time').in('id', addrIds),
    } as CacheRead,
    // Yesterday → tomorrow, blocks included: a block is only noise when the
    // stay it echoes or buffers is in view (see lib/nextArrival).
    stays: {
      key: `prep:resv2:${user.id}:${ymd}`,
      q: () => supabase.from('property_reservations')
        .select('id, address_id, platform, guest_name, calendar_id, checkin_date, checkout_date, checkin_time').in('address_id', addrIds)
        .gte('checkout_date', shiftYmd(ymd, -1)).lte('checkin_date', shiftYmd(ymd, 1)).eq('status', 'confirmed'),
    } as CacheRead,
    restock: {
      key: `prep:restock:${user.id}:${ymd}`,
      q: () => supabase.from('job_inventory_log')
        .select('item_name, jobs!inner(address_id)').eq('needs_restock', true).in('jobs.address_id', addrIds),
    } as CacheRead,
    linen: {
      key: `prep:linen:${user.id}:${ymd}`,
      q: () => supabase.from('address_inventory')
        .select('id, address_id, item_name, par_level, sort_order').in('address_id', addrIds)
        .eq('category', 'Linens').gt('par_level', 0),
    } as CacheRead,
    extras: {
      key: `prep:extras:${user.id}:${ymd}`,
      q: () => supabase.from('turnover_linen_extras')
        .select('job_id, inventory_id, extra_qty').in('job_id', jobIds),
    } as CacheRead,
    // Check first lines at the day's properties (lib/checkFirst.ts).
    checkFirst: {
      key: `prep:cflines:${user.id}:${ymd}`,
      q: () => supabase.from('property_check_first_lines')
        .select('address_id, body, photo_required, sort_order, created_at, archived_at').in('address_id', addrIds)
        .is('archived_at', null),
    } as CacheRead,
  }
}

/** The prep card's day-keyed reads carry the day as their last segment. */
export const PREP_DAY_KEY = /^prep:(addr|resv2|restock|linen|extras|cflines):([^:]+)(?::(\d{4}-\d{2}-\d{2}))?$/

// ── Whose keys these are (lib/cachePrune) ──────────────────────────────────

// The keys above that belong to ONE job (keyed by its id, then sometimes a
// user) or to ONE property. cachePrune.ts drops them when no stop worth
// keeping is left; everything else (Home, Schedule, company settings, the prep
// card's day keys) is never dropped there. A new per-job or per-property
// builder must be listed here, or its keys are kept for ever:
// scripts/test-cache-prune.mjs fails until it is.
const JOB_KEYS = new Set(['chkrows', 'jobmeta', 'crew', 'crewclock', 'time', 'photos', 'pshot', 'signoffs',
  'route', 'crewnote', 'crewnoteack', 'wtlines', 'wtphotos', 'cfticks', 'cfphotos', 'cfstart',
  // lib/crewNote: "Got it" remembered on this device (dataCache:crewNoteAck:<job>:<user>)
  'crewNoteAck'])
const PROPERTY_KEYS = new Set(['tmpl', 'rooms', 'addrmode', 'preq', 'propmeta', 'wttrash', 'cflines'])

/** The job or property a cache key (without dataCache's prefix) belongs to,
 *  or null when it belongs to neither. */
export function cacheKeyOwner(key: string): { job: string } | { property: string } | null {
  const [kind, a, b] = key.split(':')
  const job = (id?: string) => (id ? { job: id } : null)
  const property = (id?: string) => (id ? { property: id } : null)
  if (kind === 'inv') return a === 'log' || a === 'extras' ? job(b) : a === 'items' || a === 'rooms' ? property(b) : null
  if (kind === 'nextarr') return a === 'addr' ? property(b) : a === 'ten' ? null : job(a)
  if (JOB_KEYS.has(kind)) return job(a)
  if (PROPERTY_KEYS.has(kind)) return property(a)
  return null
}

// ── The day pack: everything one job's screens read on open ─────────────────

/** A pack read; `then` names reads that only apply once this one's answer is
 *  known (the walkthrough, only on a job whose checklist is one). */
export type PackRead = CacheRead & { then?: (data: any) => CacheRead[] }

/**
 * Every cached read a crew member's phone makes on opening this job — the job
 * screen, its Supplies screen, and its walkthrough — gated the way those
 * screens gate them, for `user` as a crew member ON the job.
 */
export function jobPackReads(job: any, user: any): PackRead[] {
  const addrId = jobAddressId(job)
  const isTask = isTaskJob(job)
  const dailyMode = user._timeMode === 'daily'
  const walkthrough = (): CacheRead[] => [
    walkthroughLinesRead(job.id), walkthroughPhotosRead(job.id),
    ...(addrId ? [trashDaysRead(addrId)] : []),
  ]
  const reads: PackRead[] = [
    tenantVideoRead(user.tenant_id),
    // loadChecklist / loadChecklistForAddress
    ...(addrId ? [checklistTemplateRead(addrId)] : []),
    { ...checklistRowsRead(job.id), then: rows => (!isTask && Array.isArray(rows) && isWalkthroughJob(rows) ? walkthrough() : []) },
    tenantSeedRead(user.tenant_id),
    ...(addrId ? [
      roomsRead(addrId), roomSignoffsRead(job.id), addressModeRead(addrId),
      tenantModeRead(user.tenant_id), photoRequirementsRead(addrId), requirementShotsRead(job.id),
    ] : []),
    // loadPhotoRequirements (cleans at a property): the company's switch; the
    // shots and requirements are the checklist card's reads above.
    ...(addrId && !isTask ? [photoEnforceRead(user.tenant_id)] : []),
    itemPhotosRead(job.id),
    // loadTimeEntries / loadCrewClock
    timeEntriesRead(job.id, user.id, false),
    ...(!dailyMode && !isTask ? [crewClockRead(job.id)] : []),
    // loadPropMeta
    jobMetaRead(job.id),
    jobCrewRead(job.id),
    ...(addrId ? [propMetaRead(addrId)] : []),
    // loadCrewNote
    crewNoteRead(job.id),
    crewNoteAckRead(job.id, user.id),
  ]
  // loadNextArrival
  if (!isTask && job.client_addresses?.id && job.scheduled_start) {
    const n = nextArrivalReads(job, job.client_addresses.id, user.tenant_id)
    reads.push(n.stays, n.property, n.company)
  }
  // loadRouteStop: a job with no route order is never ranked.
  if (job.route_order != null && job.scheduled_start) reads.push(routeStopRead(job, user))
  // The Supplies screen (cleans only).
  if (!isTask && addrId) {
    reads.push(inventoryItemsRead(addrId), inventoryLogRead(job.id), inventoryRoomsRead(addrId), linenExtrasRead(job.id))
  }
  // loadCheckFirst (cleans only): the clean's ticks, line photos and start are
  // read only at a property that has lines.
  if (!isTask && addrId) {
    reads.push(
      checkFirstTenantRead(user.tenant_id),
      { ...checkFirstLinesRead(addrId), then: rows => (Array.isArray(rows) && rows.length
        ? [checkFirstTicksRead(job.id), checkFirstPhotosRead(job.id), checkFirstStartRead(job.id)] : []) },
    )
  }
  // An inspection visit opens the walkthrough directly.
  if (job.job_type === 'inspection') reads.push(...walkthrough())
  return reads
}
