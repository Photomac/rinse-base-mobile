// src/lib/locationSettingRules.ts
// What this phone's location setting is, in the words the office's Team page
// uses (rinsebase-app 20261023210300_client_versions_location_setting): whose
// map dot and arrive/leave record can be relied on. CKS (2026-10-23): "there's
// no way for me to tell today whose location isn't coming through." A missing
// dot doesn't say (an iPhone sitting still sends nothing until it moves); the
// setting does. lib/clientVersion reports it. Pure, tested under Node.

export type LocationSetting = 'always' | 'while_using' | 'off' | 'not_asked'

/** servicesOn: location services for the whole phone; fg / bg: the app's
 *  foreground ("while using") and background ("always") permission status. */
export function locationSettingFrom(p: { servicesOn: boolean; fg: string | null | undefined; bg: string | null | undefined }): LocationSetting {
  if (!p.servicesOn) return 'off'
  if (p.fg === 'granted') return p.bg === 'granted' ? 'always' : 'while_using'
  if (p.fg === 'denied') return 'off'
  return 'not_asked'
}

/** Precise location (iOS "Precise Location", Android fine vs approximate):
 *  without it a phone knows only roughly where it is and fences don't work.
 *  null = the OS didn't say. */
export function preciseFrom(os: string, fg: { ios?: { accuracy?: string } | null; android?: { accuracy?: string } | null } | null | undefined): boolean | null {
  const a = os === 'ios' ? fg?.ios?.accuracy : fg?.android?.accuracy
  if (a === 'full' || a === 'fine') return true
  if (a === 'reduced' || a === 'coarse') return false
  return null
}

/** Report again only when it changed, or at most twice a day otherwise. */
export const LOCATION_REPORT_EVERY_MS = 12 * 60 * 60 * 1000
export function shouldReportLocation(last: { key: string; at: number } | null, key: string, nowMs: number): boolean {
  return !last || last.key !== key || nowMs - last.at >= LOCATION_REPORT_EVERY_MS
}
