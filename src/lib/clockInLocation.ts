// The crew app's side of "clock-in only at the property": the phone's and the
// database's answers for lib/clockInGate. The crew web view has the same file
// for the browser (rinsebase-app src/lib/clockInLocation.ts).
import * as Location from 'expo-location'
import { supabase } from './supabase'
import { readSoon } from './dataCache'
import { clockInRuleRead, clockInSiteRead } from './jobReads'
import { linkAnswering } from './netFetch'
import { ensureForegroundLocation, getForegroundLocationStatus } from './permissions'
import { CLOCK_IN_FIX_WAIT_MS, runClockInGate, siteOf, type ClockInDecision, type ClockInFix, type ClockInSite } from './clockInGate'
import { DAY_END_GATE, companyLocationSite, dayEndDecision, dayEndSites, type DayEndDecision } from './dayClock'

// How long a punch waits on a read before using the saved copy, and on the
// office's override before treating it as no answer.
const READ_WAIT_MS = 2_500
const OVERRIDE_WAIT_MS = 5_000

function timesOut<T>(ask: PromiseLike<T>, ms: number): Promise<T> {
  let timer: any
  return Promise.race([
    Promise.resolve(ask),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * The company's switch and its location, from the saved copy on a weak signal.
 * A read that fails, or no saved copy, means off with no location: before a
 * migration a column doesn't exist, and then a punch is exactly what it always
 * was.
 *
 * The location comes back whether or not the switch is on: a person whose day
 * is limited to it is checked either way (lib/dayClock). It is exact only when
 * the office placed it (tenants.home_base_precision); a pin the geocode cron
 * placed may be a town centre, and can't turn anyone away.
 */
export async function clockInRule(tenantId: string): Promise<{ required: boolean; office: ClockInSite | null }> {
  try {
    const { data, error } = await readSoon<any>(clockInRuleRead(tenantId), READ_WAIT_MS)
    if (error || !data) return { required: false, office: null }
    return { required: !!data.clock_in_location_required, office: companyLocationSite(data) }
  } catch {
    return { required: false, office: null }
  }
}

/**
 * The clean's property with its pin precision. Read here rather than off the
 * job the list screen handed over: not every list selects the pin. The day pack
 * saves it for dead zones.
 */
export async function clockInSite(job: any): Promise<ClockInSite> {
  try {
    const { data } = await readSoon<any>(clockInSiteRead(job.id), READ_WAIT_MS)
    if (data?.client_addresses) return siteOf(data.client_addresses)
  } catch { /* the job's own copy, then */ }
  return siteOf(job.client_addresses)
}

async function phoneFix(): Promise<ClockInFix | null> {
  const fix = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    new Promise<null>(resolve => setTimeout(() => resolve(null), CLOCK_IN_FIX_WAIT_MS)),
  ])
  if (!fix) return null
  return { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy ?? null, at: fix.timestamp }
}

export function checkClockIn(args: { sites: ClockInSite[]; jobId: string | null; userId: string }): Promise<ClockInDecision> {
  return runClockInGate({
    sites: () => args.sites,
    permission: async () => {
      const status = await getForegroundLocationStatus()
      if (status === 'granted') return 'granted'
      if (status === 'undetermined' && (await ensureForegroundLocation({ silent: true })) === 'granted') return 'granted'
      return 'denied'
    },
    fix: phoneFix,
    online: linkAnswering,
    overridden: async () => {
      // Start my day has no override row: the office starts the day for them.
      if (!args.jobId) return false
      const { data, error } = await timesOut(supabase.from('clock_in_location_events')
        .select('id').eq('job_id', args.jobId).eq('user_id', args.userId).eq('kind', 'allowed').limit(1), OVERRIDE_WAIT_MS)
      if (error) throw error
      return (data?.length ?? 0) > 0
    },
  })
}

/** Where End my day happened, against the company location (lib/dayClock). Never refuses. */
export async function checkDayEnd(office: ClockInSite | null): Promise<DayEndDecision> {
  return dayEndDecision(await runClockInGate({
    sites: () => dayEndSites(office),
    permission: async () => ((await getForegroundLocationStatus()) === 'granted' ? 'granted' : 'denied'),
    fix: phoneFix,
    ...DAY_END_GATE,
  }))
}

/** Keep the refusal for the office. A refusal only happens online; losing this row costs nothing but the note. */
export async function recordRefusal(d: ClockInDecision, args: { tenantId: string; jobId: string | null; userId: string }): Promise<void> {
  if (d.allow) return
  try {
    const { error } = await timesOut(supabase.from('clock_in_location_events').insert({
      tenant_id: args.tenantId, job_id: args.jobId, user_id: args.userId, kind: 'refused',
      distance_m: d.distanceM, accuracy_m: d.accuracyM, lat: d.stamp.lat, lng: d.stamp.lng,
    }), OVERRIDE_WAIT_MS)
    if (error) console.warn('clock-in refusal not recorded:', error.message)
  } catch (e) {
    console.warn('clock-in refusal not recorded:', e)
  }
}

export interface ClockInEvent {
  id: string
  user_id: string
  kind: 'refused' | 'allowed'
  distance_m: number | null
  created_at: string
}

/** This clean's refusals and overrides, for the office's card. Soft: none on any failure. */
export async function clockInEvents(jobId: string): Promise<ClockInEvent[]> {
  try {
    const { data, error } = await timesOut(supabase.from('clock_in_location_events')
      .select('id, user_id, kind, distance_m, created_at').eq('job_id', jobId)
      .order('created_at', { ascending: false }).limit(50), OVERRIDE_WAIT_MS)
    return error ? [] : ((data as ClockInEvent[]) ?? [])
  } catch {
    return []
  }
}

/** The office lets someone clock in here. The server records who and when. */
export async function allowClockInHere(jobId: string, userId: string): Promise<{ error: string | null }> {
  try {
    const { error } = await timesOut(supabase.rpc('allow_clock_in_here', { p_job_id: jobId, p_user_id: userId }), OVERRIDE_WAIT_MS)
    return { error: error?.message ?? null }
  } catch (e: any) {
    return { error: e?.message ?? 'failed' }
  }
}
