// The office's "Mine / Everyone" choice (see lib/jobScope), kept on the phone
// and shared by Home and Schedule: both tabs stay mounted, so flipping it on
// one must flip the other, not leave them disagreeing until a relaunch.
//
// Saved per signed-in user on this phone, so a shared phone doesn't hand one
// person's choice to the next. A save that fails just isn't remembered; the
// screen still switches.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { parseJobScope, type JobScope } from './jobScope'

const storeKey = (userId: string) => `jobScope:${userId}`

const scopes = new Map<string, JobScope>()
const reading = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
function emit() { listeners.forEach(fn => fn()) }

/** The saved choice, for code outside React (the offline day pack builds the
 *  prep card Home will show, so it needs the scope Home will show it in). */
export async function savedJobScope(userId: string): Promise<JobScope> {
  const known = scopes.get(userId)
  if (known) return known
  try { return parseJobScope(await AsyncStorage.getItem(storeKey(userId))) } catch { return 'everyone' }
}

export function useJobScope(userId: string): [JobScope, (scope: JobScope) => void] {
  const scope = useSyncExternalStore(subscribe, () => scopes.get(userId) ?? 'everyone')

  useEffect(() => {
    if (!userId || scopes.has(userId) || reading.has(userId)) return
    reading.add(userId)
    AsyncStorage.getItem(storeKey(userId))
      .then(raw => {
        // A tap that landed while this read was in flight wins over the saved value.
        if (scopes.has(userId)) return
        scopes.set(userId, parseJobScope(raw))
        emit()
      })
      .catch(() => {})
      .finally(() => { reading.delete(userId) })
  }, [userId])

  const setScope = useCallback((next: JobScope) => {
    scopes.set(userId, next)
    emit()
    AsyncStorage.setItem(storeKey(userId), next).catch(() => {})
  }, [userId])

  return [scope, setScope]
}
