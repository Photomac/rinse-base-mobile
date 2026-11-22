// src/lib/punchStamp.ts
// Where a crew member's own Clock in puts its 📍 (job_time_entries
// clock_in_lat / clock_in_lng): the office's Team page and the clean's Time tab
// show it as where the person clocked in.
//
// Always a fix the phone took at the tap: the clock-in check's own fix when it
// got one (lib/clockInGate, so no second wait), else a quick best-effort fix
// (lib/arrivalGeofence quickGpsStamp). That holds for a clock-in after the
// "you've arrived" prompt too. Until 2026-11-22 those (source 'prompted')
// stored the arrival fence's centre, which IS the property's pin: all 141 of
// Celebrity Clean's sat 0 m from it, so the office saw the pin presented as GPS
// proof, and a pin can't be checked against crew fixes that are the pin. The
// arrival still sets the TIME (clocked_in_at backdates to the fence crossing);
// it never sets the place.
//
// Desk staff recording a cleaner's punch: no stamp (the phone in hand is
// theirs, not the cleaner's). Never throws, and waits no longer than `fix`
// does: no fix = no stamp, and the punch goes ahead (the entry IS the crew
// member's pay).
//
// Pure, with the phone's answer passed in, so every case can be tested
// (scripts/test-punch-stamp.mjs).

export type Stamp = { lat: number; lng: number }

export async function punchStamp(o: {
  proxy: boolean
  gate: { allow: boolean; stamp?: Stamp | null } | null | undefined
  fix: () => Promise<Stamp | null>
}): Promise<Stamp | null> {
  if (o.proxy) return null
  if (o.gate?.allow && o.gate.stamp) return o.gate.stamp
  try { return (await o.fix()) ?? null } catch { return null }
}
