// The Google Maps link behind a property's address (job screen, driver stops).
//
// The stored pin first: it is what the arrival geofence uses and it was
// checked when the address was geocoded. 'unmappable' rows can still carry a
// leftover lat/lng from a street-name-only match, and approximate geocodes
// keep their guess in approx_lat/approx_lng (never lat/lng), so neither counts.
//
// With no pin, an Irish Eircode beats the street text. An Eircode names one
// building and Google Maps knows every one; our geocoder (Photon/OSM) knows
// none, so most Irish homes have no exact pin. iClean (Galway, 2026-11-12):
// "4 College Crescent Road" with a blank town went to Google as the street
// alone, and the crew were sent to College Crescent in London. Its Eircode,
// H91 N72H, is the house on College Road, Galway. Shorthand street names
// ("38CG", "6KH") find nothing, while the Eircode beside them is exact.
// Otherwise the text carries every part we have, postcode included (it used to
// be street + town only, and "null" when the town was blank).
//
// Same rule as the web app's src/lib/directions.ts.

export type MapsAddress = {
  lat?: number | string | null
  lng?: number | string | null
  geocode_precision?: string | null
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

// A routing key (a letter and two digits, or D6W) and a four-character unique
// identifier from a restricted alphabet, with or without the space. No US,
// Canadian, UK, NZ, Italian or Portuguese postcode has this shape.
const EIRCODE = /^([ACDEFHKNPRTVWXY]\d{2}|D6W)\s*([0-9ACDEFHKNPRTVWXY]{4})$/i

/** The zip as a formatted Eircode ("H91 N72H"), or null when it is not one. */
export function eircodeOf(zip: string | null | undefined): string | null {
  const m = EIRCODE.exec((zip ?? '').trim())
  return m ? `${m[1]} ${m[2]}`.toUpperCase() : null
}

function num(v: number | string | null | undefined): number {
  return v == null || v === '' ? NaN : Number(v)
}

/** What Google Maps should search for: "lat,lng", "H91 N72H, Ireland", or the address text. */
export function mapsQuery(addr: MapsAddress | null | undefined): string | null {
  if (!addr) return null
  const lat = num(addr.lat), lng = num(addr.lng)
  if (addr.geocode_precision !== 'unmappable' && Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
    return `${lat},${lng}`
  }
  // The internal-task shell ("Internal task", "—", "00000") is nowhere.
  if ((addr.street ?? '').trim() === 'Internal task') return null
  const eircode = eircodeOf(addr.zip)
  if (eircode) return `${eircode}, Ireland`
  const text = [addr.street, addr.city, addr.state, addr.zip]
    .map(s => (s ?? '').trim())
    .filter(s => s && s !== '—')
    .join(', ')
  return text || null
}

export function mapsUrl(addr: MapsAddress | null | undefined): string | null {
  const q = mapsQuery(addr)
  return q ? `https://maps.google.com/?q=${encodeURIComponent(q)}` : null
}

const LOCATION_KEYS = ['lat', 'lng', 'geocode_precision', 'street', 'city', 'state', 'zip'] as const

/**
 * The job's address with the property's own fresher read laid over it, key by
 * key, only where that read has the key. The job came from whichever list
 * opened it (Schedule and a push tap read no pin at all); the property read
 * (propMetaRead) carries the pin and the zip, but a copy cached before it did
 * has neither key and must not blank what the job has.
 */
export function withPropertyLocation<T extends MapsAddress>(addr: T | null | undefined, prop: Partial<MapsAddress> | null | undefined): MapsAddress | null {
  if (!addr && !prop) return null
  const out: MapsAddress = { ...(addr ?? {}) }
  if (prop) for (const k of LOCATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(prop, k)) (out as any)[k] = (prop as any)[k]
  }
  return out
}
