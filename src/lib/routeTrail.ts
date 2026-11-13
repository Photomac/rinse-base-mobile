// src/lib/routeTrail.ts
// The company's "Record crew routes" switch (tenants.route_trail; rinsebase-app
// 20261113170000_crew_route_trail). While it is on, and once this person has
// acknowledged the notice, the points locationTracker already gets while they
// are working are thinned (lib/routeTrailRules), queued on the phone and sent
// in batches with the 5-minute ping. The office sees the day on Dispatch →
// Live crew map → Day trail, with stops.
//
// Nothing here starts or extends tracking: it only keeps what the existing
// task receives, and the task runs only while someone is clocked in, on a day
// shift, or on the way to a clean (checkWork). Off the clock = nothing kept.
//
// The notice is shown at a work moment (clock in, On my way, Start my day:
// startLocationTracking with requestBackground), never on app launch, at most
// once a day after "Not now". Nothing is kept for someone who hasn't tapped
// "I understand", and the server drops their points too (keep_crew_location_point).
//
// Its own small queue rather than the outbox: a point must never wait in line
// ahead of a clock-in, and a batch the server refuses is dropped, never shown
// to the crew as unsent work.

import { Alert } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { cachedQuery } from './dataCache'
import { tStatic, langStatic } from './i18n'
import {
  thinFixes, pruneQueue, flushDue, toRows, refusedForGood, BATCH,
  type QueuedFix, type RawFix, type TrailBasis,
} from './routeTrailRules'

// Bump when the notice's wording changes in substance: everyone sees it again.
export const NOTICE_VERSION = 1

const queueKey = (userId: string) => `route_trail:queue:${userId}`
const lastKey = (userId: string) => `route_trail:last:${userId}`
const flushKey = (userId: string) => `route_trail:flushed:${userId}`
const ackKey = (userId: string) => `route_trail:ack:${userId}:v${NOTICE_VERSION}`
const declinedKey = (userId: string) => `route_trail:declined:${userId}`

/** The company's switch. The saved copy answers offline (a headless wake in a
 *  dead zone); any error, including the column not existing yet, is "off". */
export async function routeTrailOn(tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return false
  try {
    const { data } = await cachedQuery(`route:flag:${tenantId}`,
      supabase.from('tenants').select('route_trail').eq('id', tenantId).maybeSingle())
    return (data as any)?.route_trail === true
  } catch { return false }
}

/** Has this person acknowledged the notice? The phone's own note first; else
 *  the server (another phone, a reinstall), remembered once found. */
export async function routeNoticeAcked(user: { id: string; tenant_id: string }): Promise<boolean> {
  try {
    if ((await AsyncStorage.getItem(ackKey(user.id))) === '1') return true
    const { data } = await cachedQuery(`route:ack:${user.id}:${NOTICE_VERSION}`,
      supabase.from('route_trail_acks').select('notice_version')
        .eq('user_id', user.id).eq('tenant_id', user.tenant_id).gte('notice_version', NOTICE_VERSION).limit(1))
    const acked = Array.isArray(data) && data.length > 0
    if (acked) AsyncStorage.setItem(ackKey(user.id), '1').catch(() => {})
    return acked
  } catch { return false }
}

async function recordAck(user: { id: string; tenant_id: string }): Promise<boolean> {
  const lang = langStatic()
  const { error } = await supabase.from('route_trail_acks').upsert(
    { user_id: user.id, notice_version: NOTICE_VERSION, tenant_id: user.tenant_id, lang },
    { onConflict: 'user_id,notice_version', ignoreDuplicates: true })
  if (error) return false
  await AsyncStorage.setItem(ackKey(user.id), '1').catch(() => {})
  return true
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** At a work moment: show the notice when the switch is on and this person
 *  hasn't acknowledged it (and didn't say "Not now" today). Never throws. */
export async function maybeShowRouteNotice(user: { id: string; tenant_id: string }): Promise<void> {
  try {
    if (!user?.id || !user?.tenant_id) return
    if (!(await routeTrailOn(user.tenant_id))) return
    if (await routeNoticeAcked(user)) return
    if ((await AsyncStorage.getItem(declinedKey(user.id))) === today()) return
    Alert.alert(tStatic('route_notice_title'), tStatic('route_notice_body'), [
      { text: tStatic('route_notice_later'), style: 'cancel',
        onPress: () => { AsyncStorage.setItem(declinedKey(user.id), today()).catch(() => {}) } },
      { text: tStatic('route_notice_ok'),
        onPress: () => {
          recordAck(user).then(ok => {
            // No signal: ask again at the next work moment rather than record
            // points the server would drop.
            if (!ok) AsyncStorage.removeItem(declinedKey(user.id)).catch(() => {})
          }).catch(() => {})
        } },
    ])
  } catch { /* the notice is best-effort; nothing is kept without it */ }
}

// One queue per person; every read-modify-write goes through this chain, so
// the OS task and the foreground ping can't lose each other's points.
let chain: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

async function readQueue(userId: string): Promise<QueuedFix[]> {
  try { return JSON.parse((await AsyncStorage.getItem(queueKey(userId))) || '[]') } catch { return [] }
}

/**
 * Keep the batch's points for the route, when the switch is on and the notice
 * acknowledged, then send if a batch is due. Called by locationTracker only
 * after it decided the person is working. Never throws.
 */
export async function noteRoute(
  user: { id: string; tenant_id: string } | null | undefined,
  locations: RawFix[],
  basis: TrailBasis | null,
  jobId: string | null,
): Promise<void> {
  try {
    if (!user?.id || !user?.tenant_id || !basis || !locations?.length) return
    if (!(await routeTrailOn(user.tenant_id))) return
    if (!(await routeNoticeAcked(user))) return
    await locked(async () => {
      let last: QueuedFix | null = null
      try { last = JSON.parse((await AsyncStorage.getItem(lastKey(user.id))) || 'null') } catch { last = null }
      const kept = thinFixes(last, locations, basis, jobId)
      if (!kept.length) return
      const queue = pruneQueue([...(await readQueue(user.id)), ...kept], Date.now())
      await AsyncStorage.multiSet([
        [queueKey(user.id), JSON.stringify(queue)],
        [lastKey(user.id), JSON.stringify(kept[kept.length - 1])],
      ])
    })
    await flushRoute(user)
  } catch { /* never in the way of the map or the geofence */ }
}

/** Send what's waiting, a batch at a time, when due (or now, with force). */
export async function flushRoute(user: { id: string; tenant_id: string } | null | undefined, force = false): Promise<void> {
  if (!user?.id || !user?.tenant_id) return
  try {
    await locked(async () => {
      const lastFlush = Number((await AsyncStorage.getItem(flushKey(user.id))) || 0)
      let queue = pruneQueue(await readQueue(user.id), Date.now())
      if (!flushDue(queue.length, lastFlush, Date.now(), force)) return
      while (queue.length) {
        const batch = queue.slice(0, BATCH)
        // Replayed safely: the same point twice is one row (ON CONFLICT DO NOTHING).
        const { error } = await supabase.from('crew_location_points')
          .upsert(toRows(batch, user.id, user.tenant_id), { onConflict: 'user_id,at', ignoreDuplicates: true })
        if (error && !refusedForGood(error)) break // no signal: keep it for the next ping
        queue = queue.slice(batch.length)
        await AsyncStorage.setItem(queueKey(user.id), JSON.stringify(queue))
      }
      await AsyncStorage.setItem(flushKey(user.id), String(Date.now()))
    })
  } catch { /* the next ping tries again */ }
}
