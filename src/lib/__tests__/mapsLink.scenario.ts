// The Maps link behind a property's address (lib/mapsLink), iClean 2026-11-12:
// "4 College Crescent Road", blank town, Eircode h91N72h, no pin, went to
// Google as the street alone and the crew were sent to London.
// Run with: node scripts/test-maps-link.mjs
import { mapsQuery, mapsUrl, eircodeOf, withPropertyLocation } from '../mapsLink'

let failures = 0
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — got ${JSON.stringify(got)}`}`)
  if (!cond) failures++
}
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), got)

eq('a usable pin wins over the Eircode',
  mapsQuery({ lat: '53.28097830', lng: '-9.03399420', geocode_precision: 'exact', street: '4 College Crescent Road', zip: 'H91 N72H' }),
  '53.2809783,-9.0339942')
eq('the reported home: no pin, blank town, lower-case Eircode → the Eircode (was "4 College Crescent Road, ")',
  mapsQuery({ lat: null, lng: null, geocode_precision: 'unmappable', street: '4 College Crescent Road', city: '', state: '', zip: 'h91N72h' }),
  'H91 N72H, Ireland')
eq('shorthand street, approximate geocode (approx_* only) → the Eircode',
  mapsQuery({ lat: null, lng: null, geocode_precision: 'approximate', street: '38CG', city: 'Galway', state: 'Co. Galway', zip: 'H91K309' }),
  'H91 K309, Ireland')
eq('an unmappable row\'s leftover lat/lng is ignored',
  mapsQuery({ lat: 53.27, lng: -9.05, geocode_precision: 'unmappable', street: 'Kirwans Lane', city: 'Galway' }),
  'Kirwans Lane, Galway')
eq('no Eircode: street, town, state and zip', mapsQuery({ street: '925 N Second St', city: 'Cottonwood', state: 'AZ', zip: '86326' }),
  '925 N Second St, Cottonwood, AZ, 86326')
eq('blank or missing parts never print "null" / "undefined" / ", ,"',
  mapsQuery({ street: '4 College Crescent Road', city: null, state: undefined, zip: '' }), '4 College Crescent Road')
eq('a 0,0 pin is not a pin', mapsQuery({ lat: 0, lng: 0, street: '1 Main St', city: 'Breck' }), '1 Main St, Breck')
eq('the internal-task shell → no link', mapsUrl({ street: 'Internal task', city: '—', state: '—', zip: '00000' }), null)
eq('nothing → no link', [mapsUrl(null), mapsUrl({})], [null, null])
eq('the URL form the app always opened', mapsUrl({ zip: 'H91N72H' }), 'https://maps.google.com/?q=H91%20N72H%2C%20Ireland')

eq('no other country\'s postcode (nor a near miss) is an Eircode',
  ['62701', '62701-1234', 'M5V 2T6', 'V2A0E2', 'M1 1AE', 'SW1A 1AA', 'W1A 0AX', '8011', '00184', '1100-048', 'B91 N72H', 'H91 N72', 'H91 N72HH'].filter(z => eircodeOf(z) !== null), [])
eq('real Eircodes read, D6W too', ['H91AX97', 'h91 tn0n', 'D6WX123'].map(eircodeOf), ['H91 AX97', 'H91 TN0N', 'D6W X123'])

// The job screen: the list that opened it (Schedule, a push tap) may carry no
// pin and never the zip; the property read lays its own over it.
const fromSchedule = { id: 'A1', street: '4 College Crescent Road', city: '', nickname: 'Helen Cawley - College Road' }
eq('Schedule row + the property read → the property\'s pin',
  mapsQuery(withPropertyLocation(fromSchedule, { bedrooms: 2, lat: 53.2809783, lng: -9.0339942, geocode_precision: 'exact', zip: 'H91 N72H', city: 'Galway' } as any)),
  '53.2809783,-9.0339942')
eq('a property read cached before it carried the location blanks nothing',
  withPropertyLocation({ street: '1 Main St', city: 'Breck', lat: 39.48, lng: -106.04 }, { bedrooms: 3, lockbox_code: '1234' } as any),
  { street: '1 Main St', city: 'Breck', lat: 39.48, lng: -106.04 })
eq('a fresher property read with no pin wins over a stale pin on the job',
  mapsQuery(withPropertyLocation({ street: '38CG', lat: 53.27, lng: -9.05 }, { lat: null, lng: null, geocode_precision: 'approximate', zip: 'H91K309' })),
  'H91 K309, Ireland')
eq('no property read yet → the job\'s own address', mapsQuery(withPropertyLocation({ street: '1 Main St', city: 'Breck' }, null)), '1 Main St, Breck')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
if (failures) process.exit(1)
