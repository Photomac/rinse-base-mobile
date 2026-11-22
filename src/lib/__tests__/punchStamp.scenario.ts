// Clock-in stamp scenario test. Run with: node scripts/test-punch-stamp.mjs
//
// Exercises the REAL src/lib/punchStamp.ts (pure): where a crew member's own
// Clock in puts its 📍, and how exact that fix was. Then checks the wiring on
// the source text: Clock in on the stop's screen stamps every own punch from a
// fix at the tap, the arrival prompt backdates the time exactly as before and
// no longer hands over a place, the background arrival handler stores no fence
// centre, and every punch the phone stamps (Clock in, Clock out, Start my day,
// End my day, the arrival auto punch) writes the fix's accuracy beside it.
//
// Found 2026-11-22 while proposing exact pins for Celebrity Clean from crew
// GPS: all 141 of their clock-ins after the "you've arrived" prompt (source
// 'prompted') sat 0 m from the property's pin, because the stamp was the
// arrival fence's centre, i.e. the pin (#294). And 20-50% of a property's real
// stamps were km off with nothing on the row to say the fix was weak: the
// accuracy columns (rinsebase-app 20261122164539) keep that now.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { punchStamp, accuracyMOf, decisionStamp, type Stamp } from '../punchStamp'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const repo = process.env.RINSEBASE_MOBILE_REPO as string
const src = (p: string) => readFileSync(join(repo, p), 'utf8')
const fnBody = (text: string, start: string, end: string) => {
  const i = text.indexOf(start)
  return i < 0 ? '' : text.slice(i, text.indexOf(end, i))
}

// A cabin up a long drive (made-up, near Asheville; 0.001° lat ≈ 111 m). The
// pin is where the arrival fence is centred.
const PIN = { lat: 35.31744, lng: -82.66550 }
const north = (m: number, accuracyM: number | null = 8): Stamp => ({ lat: PIN.lat + m / 111_195, lng: PIN.lng, accuracyM })
const AT_THE_DOOR = north(42)
const phone = (answer: Stamp | null | 'throws') => {
  let asked = 0
  return {
    fix: async () => { asked++; if (answer === 'throws') throw new Error('location unavailable'); return answer },
    asked: () => asked,
  }
}

async function main() {
  // ── where ────────────────────────────────────────────────────────────────
  {
    // The arrival prompt, company check off: the phone's fix at the tap.
    const p = phone(AT_THE_DOOR)
    const s = await punchStamp({ proxy: false, gate: null, fix: p.fix })
    ok('after the arrival prompt, check off: the phone\'s fix at the tap', same(s, AT_THE_DOOR) && p.asked() === 1)
    ok('…not the pin the fence is centred on', !!s && (s.lat !== PIN.lat || s.lng !== PIN.lng))
  }
  {
    // Company check on and it got a fix: that one, with ITS accuracy, no second wait.
    const p = phone(north(5, 3))
    const s = await punchStamp({ proxy: false, gate: { allow: true, stamp: { lat: AT_THE_DOOR.lat, lng: AT_THE_DOOR.lng }, accuracyM: 6 }, fix: p.fix })
    ok('the check\'s own fix is the stamp, with its accuracy, and the phone isn\'t asked again',
      same(s, { lat: AT_THE_DOOR.lat, lng: AT_THE_DOOR.lng, accuracyM: 6 }) && p.asked() === 0)
  }
  {
    // The check let them through without a fix (a pinless home, no fix in time).
    const p = phone(AT_THE_DOOR)
    const s = await punchStamp({ proxy: false, gate: { allow: true, stamp: null, accuracyM: null }, fix: p.fix })
    ok('the check passed with no fix: a fix at the tap', same(s, AT_THE_DOOR) && p.asked() === 1)
  }
  {
    const p = phone(null)
    const s = await punchStamp({ proxy: false, gate: null, fix: p.fix })
    ok('no fix in time: no stamp (and no pin standing in for one)', s === null)
  }
  {
    const p = phone('throws')
    let threw = false
    let s: Stamp | null = AT_THE_DOOR
    try { s = await punchStamp({ proxy: false, gate: null, fix: p.fix }) } catch { threw = true }
    ok('the phone erroring never fails the punch: no stamp', !threw && s === null)
  }
  {
    const p = phone(AT_THE_DOOR)
    const s = await punchStamp({ proxy: true, gate: { allow: true, stamp: AT_THE_DOOR, accuracyM: 5 }, fix: p.fix })
    ok('desk staff recording for someone: no stamp, phone not asked', s === null && p.asked() === 0)
  }

  // ── how exact ────────────────────────────────────────────────────────────
  ok('accuracy is kept in whole metres', accuracyMOf(12.6) === 13 && accuracyMOf(0) === 0 && accuracyMOf(4.4) === 4)
  ok('nothing usable is null, never a throw (NaN, negative, infinite, absurd, missing, text)',
    [NaN, -1, Infinity, 2_000_000, null, undefined, '12', {}].every(v => accuracyMOf(v) === null))
  {
    // A cell-tower fix 3 km off still stamps where it was, and says so.
    const s = await punchStamp({ proxy: false, gate: null, fix: phone(north(3000, 1414.2)).fix })
    ok('a weak fix keeps its place and says how weak', s?.accuracyM === 1414 && Math.abs((s?.lat ?? 0) - north(3000).lat) < 1e-9)
  }
  {
    // A reading the integer column would refuse must not reach it.
    const s = await punchStamp({ proxy: false, gate: null, fix: phone(north(10, 5e12)).fix })
    ok('an absurd accuracy is dropped, the place is kept', s?.accuracyM === null && s?.lat === north(10).lat)
    const g = await punchStamp({ proxy: false, gate: { allow: true, stamp: { lat: 1, lng: 2 }, accuracyM: NaN }, fix: phone(null).fix })
    ok('the check\'s NaN accuracy is dropped, its place kept', same(g, { lat: 1, lng: 2, accuracyM: null }))
  }
  ok('the day-end check\'s fix as the stamp, with its accuracy', same(decisionStamp({ stamp: { lat: 1, lng: 2 }, accuracyM: 7.4 }), { lat: 1, lng: 2, accuracyM: 7 }))
  ok('…none when the check had no fix (the quick fix is used instead)', decisionStamp({ stamp: null, accuracyM: 9 }) === null && decisionStamp(null) === null && decisionStamp(undefined) === null)

  // ── wiring: Clock in / Clock out on the stop's screen ────────────────────
  const job = src('src/screens/JobDetailScreen.tsx')
  const clockIn = fnBody(job, 'async function clockInAs(', 'function clockInRefused')
  ok('Clock in found', clockIn.length > 0)
  ok('the stamp is the tap\'s fix, for every own punch', /const stamp = await punchStamp\(\{ proxy, gate, fix: \(\) => quickGpsStamp\(\) \}\)/.test(clockIn))
  ok('…taken outside the arrival branch, not instead of it', (() => {
    const arrivalBranch = fnBody(clockIn, 'if (arrival) {', '\n    }\n')
    return arrivalBranch.length > 0 && !/punchStamp|quickGpsStamp|stamp\s*=/.test(arrivalBranch)
  })())
  ok('nothing on the stop\'s screen reads a place off the arrival', !/arrival\.(lat|lng)\b/.test(job))
  ok('the backdate is unchanged: the fence crossing, floored 30 min before the start, never in the future',
    clockIn.includes('const floor = new Date(new Date(job.scheduled_start).getTime() - 30 * 60000)')
    && clockIn.includes('clockedInAt = arrivedAt > floor ? arrivedAt : floor')
    && clockIn.includes('if (clockedInAt > new Date()) clockedInAt = new Date()'))
  ok('it is still marked as after the prompt, with the arrival time', clockIn.includes("source: arrival ? 'prompted' : 'manual'") && clockIn.includes('arrived_at: arrival?.at ?? null'))
  ok('the entry takes the stamp and its accuracy', clockIn.includes('clock_in_lat: stamp?.lat ?? null') && clockIn.includes('clock_in_lng: stamp?.lng ?? null')
    && clockIn.includes('clock_in_accuracy_m: stamp?.accuracyM ?? null'))
  ok('the stamp is read before the write, and the write never waits on more than it',
    clockIn.indexOf('await punchStamp(') > -1 && clockIn.indexOf('await punchStamp(') < clockIn.indexOf('await writeThrough('))
  ok('desk staff get no arrival either', clockIn.includes('const arrival = proxy ? null : await getPendingArrival(job.id)'))
  const clockOut = fnBody(job, 'async function clockOutActive(', 'await writeThrough(')
  ok('Clock out writes its fix\'s accuracy beside its place', clockOut.includes('const outStamp = await quickGpsStamp()')
    && clockOut.includes('clock_out_lat: outStamp?.lat ?? null') && clockOut.includes('clock_out_accuracy_m: outStamp?.accuracyM ?? null'))

  // ── wiring: the background arrival handler ───────────────────────────────
  const fence = src('src/lib/arrivalGeofence.ts')
  const shape = fnBody(fence, 'export interface PendingArrival {', '}')
  ok('a saved arrival is a time only', /at: string/.test(shape) && !/\blat\b|\blng\b/.test(shape))
  ok('the handler saves no fence centre with it', fence.includes('const arrival: PendingArrival = { at: new Date().toISOString() }')
    && !/lat: \(region as any\)\.latitude/.test(fence))
  ok('the auto punch stamps its own fresh fix, with its accuracy',
    /clock_in_lat: fix\.coords\.latitude, clock_in_lng: fix\.coords\.longitude,\s+clock_in_accuracy_m: accuracyMOf\(fix\.coords\.accuracy\)/.test(fence))
  ok('the quick fix still gives up after 2.5 s and never throws',
    /export async function quickGpsStamp\(timeoutMs = 2500\)/.test(fence) && /catch \{ \/\* no stamp/.test(fence))
  ok('…and hands back the fix\'s accuracy', fence.includes('return { lat: latitude, lng: longitude, accuracyM: accuracyMOf(accuracy) }'))

  // ── wiring: Start my day / End my day ────────────────────────────────────
  const home = src('src/screens/DashboardScreen.tsx')
  const startDay = fnBody(home, 'async function handleStartDay()', 'async function handleEndDay()')
  ok('Start my day stamps the check\'s fix or the tap\'s, with its accuracy',
    startDay.includes('const stamp = await punchStamp({ proxy: false, gate, fix: () => quickGpsStamp() })')
    && startDay.includes('clock_in_accuracy_m: stamp?.accuracyM ?? null'))
  const endDay = home.slice(home.indexOf('async function handleEndDay()'))
  ok('End my day stamps the day-end check\'s fix or the quick one, with its accuracy',
    endDay.includes('const stamp = decisionStamp(end) ?? await stampP')
    && endDay.includes('clock_out_accuracy_m: stamp?.accuracyM ?? null'))

  // ── the day-end decision carries the fix's accuracy (dayClock.ts = the web's) ─
  const day = src('src/lib/dayClock.ts')
  ok('dayEndDecision passes the check\'s accuracy along', (day.match(/accuracyM: d\.accuracyM \}/g) ?? []).length === 2 && /accuracyM\?: number \| null/.test(day))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  if (failures) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
