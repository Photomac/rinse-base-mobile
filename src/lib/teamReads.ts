// The reads behind "Team today" (screens/TeamTodayScreen, rules in lib/teamDay).
//
// Three reads for one company day: the people (names, role, active), their
// clock entries around the day, and the day's cleans with their crews (for
// "on the schedule, not in yet" and the suggested end of a day). No pay: the
// users columns named here are all in USERS_READABLE_COLUMNS, and none of
// them is a rate; job_time_entries carries times only.
//
// Only TODAY's reads are kept for offline (one key each per company, so the
// cache doesn't grow a copy per day looked at). An earlier day is read live.
import { supabase } from './supabase'
import type { CacheRead } from './dataCache'

const HOUR = 3_600_000

export const TEAM_ENTRY_COLUMNS = 'id, user_id, job_id, entry_type, clocked_in_at, clocked_out_at, duration_minutes, pause_reason, edited_at, edited_by, original_clocked_in_at, original_clocked_out_at, clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng'

/** Everyone in the company, active or not (an inactive person's past hours
 *  still need a name). */
export function teamPeopleRead(tenantId: string): CacheRead {
  return {
    key: `team:people:${tenantId}`,
    q: () => supabase.from('users')
      .select('id, full_name, role, is_active, removed_at')
      .eq('tenant_id', tenantId)
      .order('full_name'),
  }
}

/**
 * Clock entries started from a day before the day to 16 h after it: the day's
 * own entries, one still running from yesterday (a day nobody ended; the
 * nightly close takes them at 16 h), and the next starts that bound an end
 * (lib/endDay validateEnd). lib/teamDay dayEntries() picks the day's.
 */
export function teamEntriesRead(tenantId: string, dayStartMs: number, dayEndMs: number): CacheRead {
  return {
    key: `team:entries:${tenantId}`,
    q: () => supabase.from('job_time_entries')
      .select(TEAM_ENTRY_COLUMNS)
      .eq('tenant_id', tenantId)
      .gte('clocked_in_at', new Date(dayStartMs - 24 * HOUR).toISOString())
      .lt('clocked_in_at', new Date(dayEndMs + 16 * HOUR).toISOString())
      .order('clocked_in_at')
      .limit(1000),
  }
}

/** The day's cleans (not cancelled), where (name and map pin), who's on them and who completed them. */
export function teamCleansRead(tenantId: string, dayStartMs: number, dayEndMs: number): CacheRead {
  return {
    key: `team:cleans:${tenantId}`,
    q: () => supabase.from('jobs')
      .select('id, status, job_type, scheduled_start, scheduled_end, completed_at, completed_by_user_id, client_addresses!jobs_address_id_fkey(nickname, street, lat, lng, geocode_precision), job_assignments!job_assignments_job_id_fkey(user_id)')
      .eq('tenant_id', tenantId)
      .gte('scheduled_start', new Date(dayStartMs).toISOString())
      .lt('scheduled_start', new Date(dayEndMs).toISOString())
      .neq('status', 'cancelled')
      .order('scheduled_start')
      .limit(500),
  }
}

/** One entry as the server has it now, for a re-read before and after a fix. */
export function readEntryNow(id: string) {
  return supabase.from('job_time_entries').select(TEAM_ENTRY_COLUMNS).eq('id', id).maybeSingle()
}

/** The person's open day shift as the server has it now. */
export function readOpenShiftNow(userId: string) {
  return supabase.from('job_time_entries')
    .select('id, clocked_in_at')
    .eq('user_id', userId).eq('entry_type', 'shift').is('clocked_out_at', null)
    .order('clocked_in_at', { ascending: false }).limit(1)
}
