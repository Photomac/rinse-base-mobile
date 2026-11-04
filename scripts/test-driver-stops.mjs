#!/usr/bin/env node
// The linen driver's stops on Home (components/DriverStopsCard.tsx, web
// migration 20261103214000_driver_on_clean).
//
// Runs the REAL src/lib/driverStops.ts under Node's type stripping (it is
// pure) and checks:
//   • linen to bring = the property's Linens par + this clean's extra, floored
//     at 0, in the property's order, zero lines dropped, another property's
//     and another clean's rows ignored (the Pull Sheet's math);
//   • stops grouped by day in time order; the next step after each tick;
//   • crew first names;
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

const { linenFor, stopsByDay, nextStep, primaryTick, crewFirstNames } = await import(join(repo, 'src/lib/driverStops.ts'))
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
check('nothing ticked: drop', nextStep({ linen_dropped_at: null, linen_collected_at: null }), 'drop')
check('dropped: pick up', nextStep({ linen_dropped_at: 'x', linen_collected_at: null }), 'pickup')
check('picked up: done', nextStep({ linen_dropped_at: 'x', linen_collected_at: 'y' }), 'done')
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

console.log('3. The source')
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
check('the stops read and the property read carry the bag count', [/laundry_bag_color, laundry_bag_count\)/.test(reads), /laundry_bag_color, laundry_bag_count, staging_photos/.test(reads)], [true, true])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
