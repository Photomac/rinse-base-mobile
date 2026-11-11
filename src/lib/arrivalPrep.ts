// The arrival prep a turnover hangs off, as its crew see it on the clean's
// screen (components/ArrivalPrepCard). Reads: lib/arrivalPrepCard.ts.
//
// CKS Perfections, 2026-11-11: one person goes in first on an arrival prep,
// films and photographs how the guest left the home, preps it and starts the
// laundry. By the time the turnover crew arrive that state is gone, so the
// record of how the guest left the home belongs with the clean. The office
// links the two (rinse-base-app job_arrivals, migration
// 20261111123505_arrival_hangs_off_its_turnover: job_id = the arrival,
// parent_job_id = the turnover, one each way); the web shows the arrival's
// photos and videos on the turnover's Photos tab (web #1959,
// src/components/ArrivalMedia.tsx). This is the crew app's half.
//
// Read-only. Photos show as thumbnails in four groups; videos are only
// counted, because playing one in the app needs a native module (a store
// build) and this ships over the air.
//
// Pure: no React Native, no Supabase (scripts/test-arrival-prep.mjs runs it).
import { shortName } from './crewNames'

export type ArrivalGroup = 'before' | 'damage' | 'other' | 'after'

/** How the card orders the groups: how the guest left it first, the prep's
 *  result last (the web's order: before, damage, other, after). */
export const ARRIVAL_GROUPS: ArrivalGroup[] = ['before', 'damage', 'other', 'after']

/** job_photos.photo_type → the card's group. A checklist or general photo on
 *  the arrival goes under Other. */
export function arrivalGroupOf(photoType: unknown): ArrivalGroup {
  if (photoType === 'before') return 'before'
  if (photoType === 'issue' || photoType === 'damage') return 'damage'
  if (photoType === 'after') return 'after'
  return 'other'
}

export interface ArrivalPhoto {
  id: string
  url: string
  group: ArrivalGroup
  caption: string | null
  /** When it was taken (taken_at), else when it was saved. */
  at: string | null
  /** Who took it, short ("Dana R."). */
  by: string | null
}

/** Where the arrival is: not started, under way, or done (or no longer
 *  running). Says what an empty card means. */
export type ArrivalStage = 'waiting' | 'under_way' | 'done'

export interface ArrivalPrepView {
  arrivalId: string
  status: string
  stage: ArrivalStage
  /** When the prep happened: its start, else its booked start. */
  at: string | null
  /** Who was on it, lead first ("Dana R."); with nobody assigned, whoever
   *  took its photos. Empty when neither is known. */
  who: string[]
  /** In ARRIVAL_GROUPS order, then oldest first. */
  photos: ArrivalPhoto[]
  videos: number
}

const WAITING = ['draft', 'pending_approval', 'scheduled', 'en_route']

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const time = (v: string | null): number => {
  const t = v ? Date.parse(v) : NaN
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
}
const one = (v: unknown): any => (Array.isArray(v) ? v[0] : v)

function nameOf(user: unknown): string | null {
  const full = str(one(user)?.full_name)
  return full ? shortName(full) : null
}

export function arrivalStage(status: string, startedAt: string | null): ArrivalStage {
  if (WAITING.includes(status) && !startedAt) return 'waiting'
  if (status === 'in_progress') return 'under_way'
  return 'done'
}

/**
 * The read's answer (arrivalPrepRead: job_arrivals rows for this clean, the
 * arrival embedded with its crew, photos and video ids) → what the card shows.
 * Null when the clean has no arrival prep linked, when its row can't be read
 * (an embed RLS hides comes back null), or when the arrival was called off
 * with nothing recorded.
 */
export function arrivalFromRows(data: unknown): ArrivalPrepView | null {
  const row = one(data)
  const a = one(row?.arrival)
  const arrivalId = str(a?.id)
  if (!arrivalId) return null
  const status = str(a.status) ?? 'scheduled'
  const startedAt = str(a.started_at)

  const photos: ArrivalPhoto[] = (Array.isArray(a.job_photos) ? a.job_photos : [])
    .filter((p: any) => p && str(p.photo_url))
    .map((p: any): ArrivalPhoto => ({
      id: str(p.id) ?? str(p.photo_url)!,
      url: str(p.photo_url)!,
      group: arrivalGroupOf(p.photo_type),
      caption: str(p.caption),
      at: str(p.taken_at) ?? str(p.created_at),
      by: nameOf(p.users),
    }))
    .sort((x: ArrivalPhoto, y: ArrivalPhoto) =>
      ARRIVAL_GROUPS.indexOf(x.group) - ARRIVAL_GROUPS.indexOf(y.group) || time(x.at) - time(y.at))
  const videos = Array.isArray(a.job_videos) ? a.job_videos.filter(Boolean).length : 0

  if (status === 'cancelled' && photos.length === 0 && videos === 0) return null

  const crew: string[] = (Array.isArray(a.crew) ? a.crew : [])
    .filter(Boolean)
    .slice()
    .sort((x: any, y: any) => Number(!!y.is_lead) - Number(!!x.is_lead))
    .map((c: any) => nameOf(c.users))
    .filter((n: string | null): n is string => !!n)
  const named: string[] = crew.length ? crew : photos.map(p => p.by).filter((n): n is string => !!n)
  const who = named.filter((n, i) => named.indexOf(n) === i)

  return {
    arrivalId,
    status,
    stage: arrivalStage(status, startedAt),
    at: startedAt ?? str(a.scheduled_start),
    who,
    photos,
    videos,
  }
}

/** The groups that have photos, in the card's order. */
export function arrivalPhotoGroups(photos: ArrivalPhoto[]): { group: ArrivalGroup; photos: ArrivalPhoto[] }[] {
  return ARRIVAL_GROUPS
    .map(group => ({ group, photos: photos.filter(p => p.group === group) }))
    .filter(g => g.photos.length > 0)
}

/** What the card says when the arrival recorded nothing yet, by stage. Null
 *  when there is something to show. */
export function arrivalEmptyLine(v: ArrivalPrepView): 'arrival_not_started' | 'arrival_under_way' | 'arrival_nothing' | null {
  if (v.photos.length || v.videos) return null
  return v.stage === 'waiting' ? 'arrival_not_started' : v.stage === 'under_way' ? 'arrival_under_way' : 'arrival_nothing'
}
