// Test doubles for sosTracker.ts's platform imports (expo-location,
// expo-task-manager, ./permissions, ./i18n), swapped in by scripts/test-sos.mjs.
// The SOS queue, supabase-js and the fake network under it are the same
// real/fake pair the queue scenario uses.

export const loc = {
  fg: 'granted' as 'granted' | 'denied',
  bg: 'granted' as 'granted' | 'denied',
  fix: { latitude: 34.861, longitude: -111.791 },
  fixDelayMs: 0,          // hold a GPS fix back, to open the "I'm OK mid-ping" window
  permissionDelayMs: 0,   // hold a permission read back, to open the "I'm OK mid-start" window
  started: [] as { task: string; options: any }[],
  registered: new Set<string>(),
}

const wait = (ms: number) => (ms ? new Promise(res => setTimeout(res, ms)) : Promise.resolve())

// ── expo-location ──
export const Accuracy = { High: 4 }
export async function getCurrentPositionAsync(_options?: any) {
  await wait(loc.fixDelayMs)
  return { coords: { ...loc.fix } }
}
export async function startLocationUpdatesAsync(task: string, options: any) {
  loc.started.push({ task, options })
  loc.registered.add(task)
}
export async function stopLocationUpdatesAsync(task: string) { loc.registered.delete(task) }

// ── expo-task-manager ──
export const tasks = new Map<string, (body: any) => Promise<void>>()
export function defineTask(name: string, fn: (body: any) => Promise<void>) { tasks.set(name, fn) }
export async function isTaskRegisteredAsync(name: string) { return loc.registered.has(name) }

// ── ./permissions ──
export async function getForegroundLocationStatus() { await wait(loc.permissionDelayMs); return loc.fg }
export async function getBackgroundLocationStatus() { return loc.bg }

// ── ./i18n ──
export function tStatic(key: string) { return `t:${key}` }
