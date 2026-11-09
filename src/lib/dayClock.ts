// The day clock, person by person (iClean, 2026-11-09). A company clocks per
// clean or by the day (tenants.time_tracking_mode); the office can now put one
// person on the other clock (users.time_tracking_mode) and limit where their day
// starts, and ends, to the company location (users.day_clock_at_office, the pin
// in tenants.lat/lng the office placed with set_company_pin). Migrations
// 20261109200000_company_location_pin, 20261109200100_day_clock_per_person and
// 20261109200200_day_end_place_check.
//
// Pure, with the phone's and the network's answers passed in, so every case can
// be tested. This file is the same in rinsebase-app and rinsebase-mobile. The
// mobile test compares them when both repos are on the machine.
//
// The start follows lib/clockInGate's rule: refused only on proof that the phone
// is away from an exact pin. The end is never refused. Refusing it would keep
// the person's paid day running, the opposite of what a company limiting the
// end wants. An end away from the company location comes back as `away`, the
// app asks "End here anyway?", and the entry records it (clock_out_check).

// Types only: Node's type stripping erases them, so the tests in both repos
// load this file as it is, and neither app's bundler resolves anything new.
import type { ClockInCheck, ClockInDecision, ClockInSite } from './clockInGate'

export type TimeMode = 'per_job' | 'daily'
export type DayClockAtOffice = 'start' | 'start_and_end'

/** The person's own clock when the office set one, else the company's. */
export function effectiveTimeMode(person: string | null | undefined, company: string | null | undefined): TimeMode {
  if (person === 'daily' || person === 'per_job') return person
  return company === 'daily' ? 'daily' : 'per_job'
}

/** users.day_clock_at_office, with anything unknown read as no limit (fail open). */
export function dayClockAtOffice(value: string | null | undefined): DayClockAtOffice | null {
  return value === 'start' || value === 'start_and_end' ? value : null
}

export interface CompanyLocationRow {
  lat?: number | string | null
  lng?: number | string | null
  /** tenants.home_base_precision: 'exact' only when the office placed it. */
  home_base_precision?: string | null
  home_base_label?: string | null
}

/**
 * The company location as a place the gate measures from. Exact only when the
 * office placed it: the geocode cron fills tenants.lat/lng from the business
 * address, falling back to the town centre, and a fence on a town centre would
 * turn people away at the right door.
 */
export function companyLocationSite(row: CompanyLocationRow | null | undefined): ClockInSite | null {
  if (!row || row.lat == null || row.lng == null) return null
  return {
    name: (row.home_base_label ?? '').trim() || null,
    lat: row.lat,
    lng: row.lng,
    precision: row.home_base_precision === 'exact' ? 'exact' : 'approximate',
  }
}

/** A place with no pin: somewhere they could be standing, so it never refuses. */
const UNPINNED: ClockInSite = { name: null, lat: null, lng: null, precision: null }

/**
 * Where Start my day may begin, or null when it isn't checked:
 *   - the person's day is limited to the company location: only there, whether
 *     or not the company has "Clock in only at the property" on;
 *   - else the company has that switch on: `companySites`, today's cleans and
 *     the company location (lib/clockInGate daySites);
 *   - else nothing is checked.
 * Owners, admins and managers are never checked (clockInGate notCheckedRole);
 * the caller tests that first.
 */
export function dayStartSites(args: {
  atOffice: DayClockAtOffice | null
  companyRequired: boolean
  office: ClockInSite | null
  companySites: () => ClockInSite[]
}): ClockInSite[] | null {
  if (args.atOffice) return [args.office ?? UNPINNED]
  if (args.companyRequired) return args.companySites()
  return null
}

/** Is the end of this person's day judged against the company location? */
export const dayEndChecked = (atOffice: DayClockAtOffice | null | undefined): boolean => atOffice === 'start_and_end'

export type DayEndCheck = Exclude<ClockInCheck, 'override' | 'office' | 'offline'> | 'away'

export interface DayEndDecision {
  away: boolean
  check: DayEndCheck
  distanceM: number | null
  /** Where the phone was, when it had a usable fix: the shift's clock_out_lat/lng. */
  stamp: { lat: number; lng: number } | null
}

/**
 * How the end of a day is judged: lib/clockInGate's runClockInGate over the
 * company location alone, told it is online with no override, so that being
 * away needs the same proof a refused start does (an exact pin, a fresh fix
 * within 100 m, outside the 150 m fence by more than its accuracy) and is
 * judged with no signal too, since nothing waits on the office:
 *
 *   dayEndDecision(await runClockInGate({ sites: () => dayEndSites(office),
 *     permission, fix, ...DAY_END_GATE }))
 */
export const dayEndSites = (office: ClockInSite | null): ClockInSite[] => [office ?? UNPINNED]
export const DAY_END_GATE = { online: () => true, overridden: () => false } as const

/** The gate's answer for an end of day. A "refusal" is only `away`: the end is never refused. */
export function dayEndDecision(d: ClockInDecision): DayEndDecision {
  if (!d.allow) return { away: true, check: 'away', distanceM: d.distanceM, stamp: d.stamp }
  // The gate only passes 'override', 'office' or 'offline' when its deps say
  // so, and DAY_END_GATE never does; read anything else as not checked.
  const check: DayEndCheck = d.check === 'override' || d.check === 'office' || d.check === 'offline' ? 'no_fix' : d.check
  return { away: false, check, distanceM: d.distanceM, stamp: d.stamp }
}

/** The audit columns for the end of the shift, or nothing when it wasn't judged. */
export function dayEndFields(d: DayEndDecision | null | undefined): { clock_out_check?: DayEndCheck; clock_out_distance_m?: number | null } {
  if (!d) return {}
  return { clock_out_check: d.check, clock_out_distance_m: d.distanceM }
}
