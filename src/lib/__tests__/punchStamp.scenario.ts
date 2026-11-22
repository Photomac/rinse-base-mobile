// Clock-in stamp scenario test. Run with: node scripts/test-punch-stamp.mjs
//
// Exercises the REAL src/lib/punchStamp.ts (pure): where a crew member's own
// Clock in puts its 📍. Then checks the wiring on the source text: Clock in on
// the stop's screen stamps every own punch from a fix at the tap, the arrival
// prompt backdates the time exactly as before and no longer hands over a
// place, and the background arrival handler stores no fence centre.
//
// Found 2026-11-22 while proposing exact pins for Celebrity Clean from crew
// GPS: all 141 of their clock-ins after the "you've arrived" prompt (source
// 'prompted') sat 0 m from the property's pin, because the stamp was the
// arrival fence's centre, i.e. the pin. The office's Team page and the clean's
// Time tab showed it as where the person clocked in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { punchStamp, type Stamp } from '../punchStamp'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const same = (a: Stamp | null, b: Stamp | null) => JSON.stringify(a) === JSON.stringify(b)
const repo = process.env.RINSEBASE_MOBILE_REPO as string
const src = (p: string) => readFileSync(join(repo, p), 'utf8')
const fnBody = (text: string, start: string, end: string) => {
  const i = text.indexOf(start)
  return i < 0 ? '' : text.slice(i, text.indexOf(end, i))
}

// A cabin up a long drive (made-up, near Asheville; 0.001° lat ≈ 111 m). The
// pin is where the arrival fence is centred.
const PIN: Stamp = { lat: 35.31744, lng: -82.66550 }
const north = (m: number): Stamp => ({ lat: PIN.lat + m / 111_195, lng: PIN.lng })
const AT_THE_DOOR = north(42)
const phone = (answer: Stamp | null | 'throws') => {
  let asked = 0
  return {
    fix: async () => { asked++; if (answer === 'throws') throw new Error('location unavailable'); return answer },
    asked: () => asked,
  }
}

async function main() {
  // ── the rule ─────────────────────────────────────────────────────────────
  {
    // The arrival prompt, company check off: the phone's fix at the tap.
    const p = phone(AT_THE_DOOR)
    const s = await punchStamp({ proxy: false, gate: null, fix: p.fix })
    ok('after the arrival prompt, check off: the phone\'s fix at the tap', same(s, AT_THE_DOOR) && p.asked() === 1)
    ok('…not the pin the fence is centred on', !same(s, PIN))
  }
  {
    // Company check on and it got a fix: that one, no second wait.
    const p = phone(north(5))
    const s = await punchStamp({ proxy: false, gate: { allow: true, stamp: AT_THE_DOOR }, fix: p.fix })
    ok('the check\'s own fix is the stamp, and the phone isn\'t asked again', same(s, AT_THE_DOOR) && p.asked() === 0)
  }
  {
    // The check let them through without a fix (a pinless home, no fix in time).
    const p = phone(AT_THE_DOOR)
    const s = await punchStamp({ proxy: false, gate: { allow: true, stamp: null }, fix: p.fix })
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
    let s: Stamp | null = PIN
    try { s = await punchStamp({ proxy: false, gate: null, fix: p.fix }) } catch { threw = true }
    ok('the phone erroring never fails the punch: no stamp', !threw && s === null)
  }
  {
    const p = phone(AT_THE_DOOR)
    const s = await punchStamp({ proxy: true, gate: { allow: true, stamp: AT_THE_DOOR }, fix: p.fix })
    ok('desk staff recording for someone: no stamp, phone not asked', s === null && p.asked() === 0)
  }

  // ── wiring: Clock in on the stop's screen ────────────────────────────────
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
  ok('the entry takes the stamp', clockIn.includes('clock_in_lat: stamp?.lat ?? null') && clockIn.includes('clock_in_lng: stamp?.lng ?? null'))
  ok('the stamp is read before the write, and the write never waits on more than it',
    clockIn.indexOf('await punchStamp(') > -1 && clockIn.indexOf('await punchStamp(') < clockIn.indexOf('await writeThrough('))
  ok('desk staff get no arrival either', clockIn.includes('const arrival = proxy ? null : await getPendingArrival(job.id)'))

  // ── wiring: the background arrival handler ───────────────────────────────
  const fence = src('src/lib/arrivalGeofence.ts')
  const shape = fnBody(fence, 'export interface PendingArrival {', '}')
  ok('a saved arrival is a time only', /at: string/.test(shape) && !/\blat\b|\blng\b/.test(shape))
  ok('the handler saves no fence centre with it', fence.includes('const arrival: PendingArrival = { at: new Date().toISOString() }')
    && !/lat: \(region as any\)\.latitude/.test(fence))
  ok('the auto punch still stamps its own fresh fix', /clock_in_lat: fix\.coords\.latitude, clock_in_lng: fix\.coords\.longitude/.test(fence))
  ok('the quick fix still gives up after 2.5 s and never throws',
    /export async function quickGpsStamp\(timeoutMs = 2500\)/.test(fence) && /catch \{ \/\* no stamp/.test(fence))

  // ── wiring: Start my day keeps its own tap-time fix ──────────────────────
  const home = src('src/screens/DashboardScreen.tsx')
  ok('Start my day after an arrival still stamps the tap\'s fix', /const stamp = \(gate\?\.allow \? gate\.stamp : null\) \?\? await quickGpsStamp\(\)/.test(home))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  if (failures) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
