// Stand-ins for the native modules the offline-auth harness can't load in
// Node. scripts/test-offline-auth.mjs points every one of these packages at
// this file (esbuild --alias), so the REAL src/lib modules and the REAL
// supabase-js 2.99.2 run on top of it:
//   @react-native-async-storage/async-storage → the default export below
//   react-native, expo-location, expo-task-manager, expo-notifications,
//   expo-image-picker → the named exports below (only what module load and
//   the code under test touch).
// Storage lives on globalThis.__harness so a scenario can seed it before it
// loads the client — the auth client reads storage the moment it is created.
const h: any = (globalThis as any).__harness ?? ((globalThis as any).__harness = {})
const store: Map<string, string> = h.store ?? (h.store = new Map())

const AsyncStorage = {
  async getItem(k: string) { return store.has(k) ? store.get(k)! : null },
  async setItem(k: string, v: string) { store.set(k, v) },
  async removeItem(k: string) { store.delete(k) },
  async getAllKeys() { return Array.from(store.keys()) },
  async multiRemove(keys: string[]) { keys.forEach(k => store.delete(k)) },
}
export default AsyncStorage

// react-native
export const Platform = { OS: 'ios', select: (o: any) => o.ios ?? o.default }
export const Alert = { alert: () => {} }
export const Linking = { openSettings: async () => {}, openURL: async () => {} }
export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) }

// expo-task-manager
export function defineTask() {}
export async function isTaskRegisteredAsync() { return false }

// expo-location
export const Accuracy = { Balanced: 3, High: 4 }
export const GeofencingEventType = { Enter: 1, Exit: 2 }
export async function startLocationUpdatesAsync() {}
export async function stopLocationUpdatesAsync() {}
// A scenario can stand the phone somewhere (__harness.position).
export async function getCurrentPositionAsync() { return { coords: h.position ?? { latitude: 0, longitude: 0, accuracy: 10 } } }
export async function getForegroundPermissionsAsync() { return { status: 'granted' } }
export async function getBackgroundPermissionsAsync() { return { status: 'denied' } }
export async function requestForegroundPermissionsAsync() { return { status: 'granted' } }
export async function requestBackgroundPermissionsAsync() { return { status: 'denied' } }

// expo-notifications. Every local push lands in __harness.pushes.
export async function scheduleNotificationAsync(req: any) {
  (h.pushes = h.pushes ?? []).push(req?.content)
  return 'n'
}
export async function getPermissionsAsync() { return { status: 'granted' } }
export async function requestPermissionsAsync() { return { status: 'granted' } }

// expo-image-picker
export async function getCameraPermissionsAsync() { return { status: 'granted' } }
export async function requestCameraPermissionsAsync() { return { status: 'granted' } }
export async function getMediaLibraryPermissionsAsync() { return { status: 'granted' } }
export async function requestMediaLibraryPermissionsAsync() { return { status: 'granted' } }
