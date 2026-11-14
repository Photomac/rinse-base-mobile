// The stay rating's save and the "asked at Complete" memory (rules in
// lib/stayAsk.ts). One save for the card on the clean's screen and the ask at
// Complete, through the outbox: on one bar or none it queues on the phone and
// goes ahead of the Complete that follows it. (The card used to write live
// only, and showed "Saved" when no signal had taken it.)
import AsyncStorage from '@react-native-async-storage/async-storage'
import { writeThrough } from './outbox'
import { stayWrite, withAsked, wasAsked, type StayValue } from './stayAsk'

const ASKED_KEY = 'stayAskedAtComplete'

// Read-change-write passes over the list take turns.
let turn: Promise<unknown> = Promise.resolve()

async function readAsked(): Promise<unknown> {
  try {
    const raw = await AsyncStorage.getItem(ASKED_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

/** The ask about this clean was answered on this phone (Skip), or a rating
 *  for it saved here. Storage that can't be read answers no. */
export async function stayAskedBefore(jobId: string): Promise<boolean> {
  return wasAsked(await readAsked(), jobId)
}

/** Remember the clean as answered: Complete won't ask about it again on this
 *  phone (unless a 1-4 star pick is left unsaved, lib/stayAsk). Called on an
 *  answer only, never just because the ask showed. */
export function rememberStayAsked(jobId: string): Promise<void> {
  const next = turn.then(async () => {
    try { await AsyncStorage.setItem(ASKED_KEY, JSON.stringify(withAsked(await readAsked(), jobId))) } catch { /* asked again, at worst */ }
  })
  turn = next
  return next
}

/** Save the rating on the clean. `queued` = kept on the phone until there is
 *  signal (shown as saved); `error` = the server's refusal. */
export async function saveStayRating(jobId: string, userId: string | null | undefined, v: StayValue): Promise<{ error: any; queued: boolean }> {
  const res = await writeThrough({ table: 'jobs', op: 'update', match: { id: jobId }, values: stayWrite(v, userId, new Date()) })
  if (!res.error) rememberStayAsked(jobId).catch(() => {})
  return res
}
