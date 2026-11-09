#!/usr/bin/env node
// The linen driver's stops on Home (components/DriverStopsCard.tsx, web
// migration 20261103214000_driver_on_clean).
//
// Runs the REAL src/lib/driverStops.ts under Node's type stripping (it is
// pure) and checks:
//   • linen to bring = the property's Linens par + this clean's extra, floored
//     at 0, in the property's order, zero lines dropped, another property's
//     and another clean's rows ignored (the Pull Sheet's math);
//   • stops grouped by day in time order; when a stop is finished (folds to one line);
//   • crew first names;
//   • the morning pickup (CKS, 2026-11-09): checkout less the property's
//     pickup minutes, the company's checkout for a property with none, the
//     day in pickup order with untimed stops after, and the time as the app
//     writes a wall-clock time;
// and, in the source, that the card reads only through jobReads' builders,
// filters on driver_user_id, ticks only through driver_mark_linen, opens no
// job (a driver isn't on the clean's crew), and that Home mounts it.
//
// Usage: node scripts/test-driver-stops.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const { linenFor, stopsByDay, stopFinished, primaryTick, crewFirstNames, clockMinutes, pickupMinutes, minutesToClock, pickupsByPlace, orderByPickup, returnTick, nextReturn } = await import(join(repo, 'src/lib/driverStops.ts'))
const { fmtWallTime } = await import(join(repo, 'src/lib/nextArrival.ts'))
const { bagLine } = await import(join(repo, 'src/lib/laundryBags.ts'))

console.log('1. Linen to bring')
const linen = [
  { id: 'towel', address_id: 'A', item_name: 'Bath towel', par_level: 6, sort_order: 2 },
  { id: 'king', address_id: 'A', item_name: 'King sheet set', par_level: 2, sort_order: 1 },
  { id: 'mat', address_id: 'A', item_name: 'Bath mat', par_level: 1, sort_order: 3 },
  { id: 'other', address_id: 'B', item_name: 'Queen sheet set', par_level: 3, sort_order: 1 },
]
const extras = [
  { job_id: 'j1', inventory_id: 'towel', extra_qty: 4 },
  { job_id: 'j1', inventory_id: 'mat', extra_qty: -2 },
  { job_id: 'j2', inventory_id: 'king', extra_qty: 5 },
]
check('par + extra, in the property\'s order, floored at 0 and dropped',
  linenFor({ id: 'j1', client_addresses: { id: 'A' } }, linen, extras),
  [{ name: 'King sheet set', qty: 2 }, { name: 'Bath towel', qty: 10 }])
check('another clean\'s extra is not this one\'s',
  linenFor({ id: 'j3', client_addresses: { id: 'A' } }, linen, extras).map(l => l.qty), [2, 6, 1])
check('a property with no list: nothing', linenFor({ id: 'j1', client_addresses: { id: 'C' } }, linen, extras), [])
check('no property: nothing', linenFor({ id: 'j1', client_addresses: null }, linen, extras), [])

console.log('2. Days and steps')
const day = at => at.slice(0, 10)
const grouped = stopsByDay([
  { id: 'b', scheduled_start: '2026-11-05T14:00:00Z' },
  { id: 'a', scheduled_start: '2026-11-04T11:00:00Z' },
  { id: 'c', scheduled_start: '2026-11-05T11:00:00Z' },
], day)
check('grouped by day, in time order', grouped.map(d => [d.day, d.stops.map(s => s.id)]),
  [['2026-11-04', ['a']], ['2026-11-05', ['c', 'b']]])
check('nothing ticked: open', stopFinished({ status: 'scheduled', linen_dropped_at: null, linen_collected_at: null }), false)
check('dropped only: open (the pickup is left)', stopFinished({ status: 'completed', linen_dropped_at: 'x', linen_collected_at: null }), false)
check('both ticked: finished', stopFinished({ status: 'in_progress', linen_dropped_at: 'x', linen_collected_at: 'y' }), true)
// CKS 2026-11-04 09:31: Picked up tapped at the office for houses not yet reached.
check('picked up only, clean not done: open (the drop is ahead)', stopFinished({ status: 'scheduled', linen_dropped_at: null, linen_collected_at: 'y' }), false)
check('picked up only, clean done (the office stop): finished', stopFinished({ status: 'completed', linen_dropped_at: null, linen_collected_at: 'y' }), true)
// CKS 2026-11-04: Picked up shows first; nothing is highlighted until a tick.
check('nothing ticked: no highlight', primaryTick({ linen_dropped_at: null, linen_collected_at: null }), null)
check('dropped: highlight the pickup', primaryTick({ linen_dropped_at: 'x', linen_collected_at: null }), 'pickup')
check('picked up (the office stop): nothing left to highlight', primaryTick({ linen_dropped_at: null, linen_collected_at: 'y' }), null)
check('both: nothing', primaryTick({ linen_dropped_at: 'x', linen_collected_at: 'y' }), null)
const word = n => n === 1 ? '1 bag' : `${n} bags`
check('bags: count and which', bagLine(2, '(2) green', word), '2 bags · (2) green')
check('bags: one', bagLine(1, ' tan ', word), '1 bag · tan')
check('bags: which only (no count yet)', bagLine(null, 'YELLOW / BROWN (2)', word), 'YELLOW / BROWN (2)')
check('bags: count only', bagLine(3, '', word), '3 bags')
check('bags: neither', bagLine(null, null, word), '')
check('bags: a bad count is ignored', bagLine(0, 'Red', word), 'Red')
check('crew first names', crewFirstNames({ crew: [{ users: { full_name: 'Ana Souza' } }, { users: { full_name: ' Bia ' } }, { users: null }] }), ['Ana', 'Bia'])

console.log('3. The morning pickup (CKS, 2026-11-09)')
check('clock minutes: HH:MM:SS, HH:MM, H:MM', [clockMinutes('10:00:00'), clockMinutes('11:00'), clockMinutes('9:05')], [600, 660, 545])
check('clock minutes: nothing readable is null', [clockMinutes(null), clockMinutes(''), clockMinutes('25:00'), clockMinutes('10:75'), clockMinutes('ten')], [null, null, null, null, null])
// Catherine's rhythm: Sedona 45 minutes before checkout, Cottonwood 15.
check('Sedona, 10 AM checkout: 9:15', minutesToClock(pickupMinutes('10:00:00', 45)), '09:15')
check('Sedona, 11 AM checkout: 10:15', minutesToClock(pickupMinutes('11:00:00', 45)), '10:15')
check('Cottonwood, 10 AM checkout: 9:45', minutesToClock(pickupMinutes('10:00:00', 15)), '09:45')
check('Cottonwood, 11 AM checkout: 10:45', minutesToClock(pickupMinutes('11:00:00', 15)), '10:45')
check('0 minutes: at checkout', pickupMinutes('10:00', 0), 600)
check('no pickup minutes, no checkout, or a bad number: no pickup time',
  [pickupMinutes('10:00', null), pickupMinutes(null, 45), pickupMinutes('10:00', -5), pickupMinutes('10:00', 'x')], [null, null, null, null])
check('never before midnight', pickupMinutes('00:30', 45), 0)
check('written as the app writes a wall-clock time', [fmtWallTime(minutesToClock(555), 'en-US'), fmtWallTime(minutesToClock(645), 'en-US')], ['9:15 AM', '10:45 AM'])
const places = [
  { id: 'gh', default_checkout_time: '10:00:00', linen_pickup_minutes: 45 },   // Sedona
  { id: 'cw', default_checkout_time: null, linen_pickup_minutes: 15 },         // Cottonwood, the company's checkout
  { id: 'jr', default_checkout_time: '10:00:00', linen_pickup_minutes: null }, // Jerome: not set yet
  { id: 'lt', default_checkout_time: '11:00:00', linen_pickup_minutes: 45 },   // Sedona, 11 AM
]
const at = pickupsByPlace(places, '10:00:00')
check('by property: its own checkout, else the company\'s; none without minutes', [...at.entries()], [['gh', 555], ['cw', 585], ['lt', 615]])
check('no company checkout: a property without its own has no pickup', [...pickupsByPlace(places, null).keys()], ['gh', 'lt'])
check('no places (the read failed): nothing', pickupsByPlace(null, '10:00').size, 0)
const dayStops = [
  { id: 'jerome', scheduled_start: '2026-11-09T16:00:00Z', client_addresses: { id: 'jr' } },
  { id: 'gh', scheduled_start: '2026-11-09T20:30:00Z', client_addresses: { id: 'gh' } },
  { id: 'lt', scheduled_start: '2026-11-09T18:00:00Z', client_addresses: { id: 'lt' } },
  { id: 'cw', scheduled_start: '2026-11-09T17:00:00Z', client_addresses: { id: 'cw' } },
  { id: 'nowhere', scheduled_start: '2026-11-09T17:30:00Z', client_addresses: null },
]
const pickupOf = s => at.get(s.client_addresses?.id) ?? null
check('the day in pickup order; stops with no pickup after, in the order they came',
  orderByPickup(dayStops, pickupOf).map(s => s.id), ['gh', 'cw', 'lt', 'jerome', 'nowhere'])
check('same pickup: start time, then id', orderByPickup([
  { id: 'b', scheduled_start: '2026-11-09T18:00:00Z', client_addresses: { id: 'gh' } },
  { id: 'a', scheduled_start: '2026-11-09T18:00:00Z', client_addresses: { id: 'gh' } },
  { id: 'c', scheduled_start: '2026-11-09T17:00:00Z', client_addresses: { id: 'gh' } },
], pickupOf).map(s => s.id), ['c', 'a', 'b'])
check('a company with no pickup minutes: the order is unchanged', orderByPickup(dayStops, () => null).map(s => s.id), dayStops.map(s => s.id))

console.log('4. The source')
const card = readFileSync(join(repo, 'src/components/DriverStopsCard.tsx'), 'utf8')
const reads = readFileSync(join(repo, 'src/lib/jobReads.ts'), 'utf8')
const home = readFileSync(join(repo, 'src/screens/DashboardScreen.tsx'), 'utf8')
check('the card reads only through jobReads\' builders', [/cachedQuery\(/.test(card), /supabase\.from\(/.test(card)], [false, false])
check('the stops read filters on the driver', /\.eq\('driver_user_id', user\.id\)/.test(reads), true)
check('ticks go through driver_mark_linen only', [/rpc\('driver_mark_linen'/.test(card), /\.update\(/.test(card)], [true, false])
check('the card opens no job (a driver is not crew)', /onJobPress/.test(card), false)
check('Home mounts it', /<DriverStopsCard user=\{user\}/.test(home), true)
check('Picked up comes first on the card', card.indexOf("t('driver_picked_up')") < card.indexOf("t('driver_dropped')"), true)
check('the bags line comes before the item list, which folds', [card.indexOf('styles.bags') < card.indexOf('driver_whats_in'), /openItems\[s\.id\] && \(/.test(card)], [true, true])
check('a finished stop folds to one line and a tap opens it', [/finished && !openDone\[s\.id\]/.test(card), /stopFinished\(\{ status: s\.status, \.\.\.tk \}\)/.test(card), /setOpenDone\(p => \(\{ \.\.\.p, \[s\.id\]: true \}\)\)/.test(card)], [true, true, true])
check('the stops read carries the clean\'s status (the office stop finishes on it)', /\.select\('id, tenant_id, status,/.test(reads), true)
check('the stops read and the property read carry the bag count', [/laundry_bag_color, laundry_bag_count\)/.test(reads), /laundry_bag_color, laundry_bag_count, staging_photos/.test(reads)], [true, true])

check('the pickup read is its own builder, and the stops read never names the new column', [
  /driverPickupReads\(user, rows\)/.test(card),
  /select\('id, default_checkout_time, linen_pickup_minutes'\)/.test(reads),
  /driverStopsRead[\s\S]*?\n\}\n/.exec(reads)?.[0].includes('linen_pickup_minutes'),
], [true, true, false])
check('a failed pickup read shows no pickup times, and the rest of the card stays', [/pp\.error \? \[\]/.test(card), /pc\.error \? null/.test(card)], [true, true])
check('each stop shows its pickup time, above the bags line', card.indexOf("t('driver_pickup_at')") > 0 && card.indexOf("t('driver_pickup_at')") < card.indexOf('styles.bags}>'), true)
check('the days run in pickup order', /orderByPickup\(d\.stops/.test(card), true)

console.log('4. The day\'s end: where the bags went (CKS, 2026-11-07)')
const atOffice = { returned_to: 'office', returned_at: '2026-11-09T23:12:00Z' }
check('no return: neither place shows a time', [returnTick(null, 'office'), returnTick(null, 'owner_home')], [null, null])
check('the office return shows its time on Office only', [returnTick(atOffice, 'office'), returnTick(atOffice, 'owner_home')], ['2026-11-09T23:12:00Z', null])
check('a first tap sends the place', nextReturn(null, 'office'), 'office')
check('a tap on the other place moves it', nextReturn(atOffice, 'owner_home'), 'owner_home')
check('a tap on the ticked place takes it back (null)', nextReturn(atOffice, 'office'), null)
const rcard = readFileSync(join(repo, 'src/components/DriverStopsCard.tsx'), 'utf8')
const rreads = readFileSync(join(repo, 'src/lib/jobReads.ts'), 'utf8')
check('the return is written only by driver_return_linen, for today', /rpc\('driver_return_linen', \{ p_day: today, p_to: to \}\)/.test(rcard), true)
check('the return is read through jobReads, by driver and day', [/cachedRead\(driverReturnRead\(user, today\)\)/.test(rcard), /from\('linen_returns'\)[\s\S]{0,120}\.eq\('driver_user_id', user\.id\)[\s\S]{0,60}\.eq\('return_day', day\)/.test(rreads)], [true, true])
check('the row sits under today\'s stops only', rcard.indexOf('{todays.stops.map(renderStop)}') < rcard.indexOf("t('driver_return_title')") && rcard.indexOf("t('driver_return_title')") < rcard.indexOf('{later.map('), true)
check('Office comes before the owner\'s home', rcard.indexOf("t('driver_return_office')") < rcard.indexOf("t('driver_return_home')"), true)
check('the places are the database\'s', [/markReturn\('office'\)/.test(rcard), /markReturn\('owner_home'\)/.test(rcard)], [true, true])
check('a failed save says so', /if \(error\) \{\s*Alert\.alert\(t\('driver_tick_failed_title'\)/.test(rcard.slice(rcard.indexOf('async function markReturn'))), true)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
