// The required-shot counter on a stop's screen (JobDetailScreen): how many of
// the property's named shots this clean owes, and how many are taken. It is
// on the Photos button the whole clean, and announced at clock-in.
//
// Only where the company enforces them (tenants.enforce_photo_requirements):
// ~18 required rows are seeded into every STR property, so counting them where
// nobody enforces would put a scary "0/19" on cleans that are free to
// complete. The server's completion gate joins the same flag.
//
// It read uncached, in two rounds: the company's switch
// (tenants.enforce_photo_requirements), then the property's required shots,
// this clean's shots and the owed list (job_required_photo_ids). Offline the
// counter was hidden; on a link that swallows requests (CKS Perfections,
// 2026-10-15, one bar) nothing showed until both rounds had waited out their
// deadlines.
//
// So now:
// - The switch, the requirements and the shots are cached reads: the shared
//   builders in lib/jobReads, which the day pack saves. The requirements and
//   the shots are the checklist card's own reads.
// - Where the phone's saved switch says on, the requirements, shots and owed
//   list go out with the switch, in one round. Elsewhere they go out only once
//   the switch says on: most companies don't enforce, and on a weak link every
//   extra request slows the rest.
// - The screen-opening load (`soon`) waits at most PHOTO_COUNT_WAIT.ms for the
//   live answers, and not at all when the phone's last request already failed;
//   then it shows the saved copies (dataCache readSoon). The live answers, when
//   they come, refresh the counter. Every other load (a shot taken or landed,
//   back from Photos) waits for the live answers, and keeps what is on screen
//   when they fail: the saved copy predates shots that went through live.
// - The owed list is never saved on the phone. It is frozen at clock-in and
//   leaves out rooms the owner archived, so an old copy could only leave out
//   shots this clean owes. Until the server answers it, every required shot
//   counts (owed null: fail-open, as on an older database or a failed call);
//   when it answers, the counter narrows to it.
// - A shot still uploading counts as taken, as it does in its room (lib/
//   roomShots): the phone's queue is read before the reads go out and again
//   every time the counter is shown.
import { readSoon, readCacheEntry, type SoonRead } from './dataCache'
import { photoEnforceRead, photoRequirementsRead, requirementShotsRead, jobAddressId } from './jobReads'
import { supabase } from './supabase'
import { lastTripFailed } from './netFetch'
import { queuedNow, shotsTaken, type Queued } from './roomShots'

/** How long the screen-opening load waits for the live answers. */
export const PHOTO_COUNT_WAIT = { ms: 3_000 }

export interface PhotoCount {
  total: number
  done: number
  /** The requirements this clean owes, from the server. null = not known:
   *  every required shot counts. */
  owed: Set<string> | null
}

const list = (x: any): any[] => (Array.isArray(x) ? x : [])
const isOn = (t: any) => t?.enforce_photo_requirements === true
const LIVE = Infinity

/** What the cached reads say: the switch, and (when on) the requirements and shots. */
type Reads = { on: boolean; reqs?: any; shots?: any }

function countOf(r: Reads, owed: Set<string> | null, before: Queued, after: Queued): PhotoCount {
  if (!r.on) return { total: 0, done: 0, owed: null }
  const owedIds = owed ?? new Set(list(r.reqs).filter((q: any) => q.required === true).map((q: any) => q.id as string))
  // Distinct requirements satisfied (two shots of one area are one), counted
  // only within what is owed: a shot of an area no longer owed must not push
  // "done" past "total".
  const done = [...shotsTaken(list(r.shots), before, after)].filter(id => owedIds.has(id)).length
  return { total: owedIds.size, done, owed }
}

/** The owed list from the server: the ids; null when the server can't give it
 *  (an older database, a refusal: fail-open); undefined when no answer came. */
async function owedList(jobId: string): Promise<Set<string> | null | undefined> {
  try {
    const res: any = await supabase.rpc('job_required_photo_ids', { p_job_id: jobId })
    if (!res.error && Array.isArray(res.data)) return new Set(res.data.map((r: any) => r.requirement_id as string))
    return res.status === 0 ? undefined : null
  } catch { return undefined }
}

/** `p`'s answer if it comes within `ms`, else undefined. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(undefined) })
  })
}

/**
 * Read the counter's cached reads for `job`. `first` within the wait when the
 * phone has saved copies (`saved`: at least one answer is one); `fresh`
 * resolves once late live answers are in, or to null when nothing newer came.
 * `owed` is the owed list's call, sent with the requirements and shots (null:
 * never sent, the switch is off).
 */
async function readCount(job: any, user: any, addrId: string, soon: boolean) {
  const waitNow = () => (soon ? (lastTripFailed() ? 0 : PHOTO_COUNT_WAIT.ms) : LIVE)
  const wait = waitNow()
  let owed: Promise<Set<string> | null | undefined> | null = null
  const parts = (w: number) => {
    owed ??= owedList(job.id)
    return Promise.all([readSoon(photoRequirementsRead(addrId), w), readSoon(requirementShotsRead(job.id), w)])
  }
  const savedOn = isOn(await readCacheEntry(photoEnforceRead(user.tenant_id).key))
  const flagP = readSoon(photoEnforceRead(user.tenant_id), wait)
  let partsP: Promise<SoonRead[]> | null = savedOn ? parts(wait) : null
  const flag = await flagP
  // Asked again: by now the switch's round may have failed.
  if (isOn(flag.data)) partsP ??= parts(waitNow())
  const partsR = isOn(flag.data) ? await partsP! : []
  const reads = [flag, ...partsR]
  const first: Reads = { on: isOn(flag.data), reqs: partsR[0]?.data, shots: partsR[1]?.data }
  const fresh: Promise<Reads | null> = reads.some(r => r.late)
    ? (async () => {
        try {
          const settled = await Promise.all(reads.map(r => r.late ?? r))
          if (!reads.some((r, i) => r.late && !settled[i].fromCache)) return null
          const [F, ...P] = settled
          if (!isOn(F.data)) return { on: false }
          // The switch came on late, and the rest were never sent: send them now.
          const p = P.length ? P : await parts(LIVE)
          return { on: true, reqs: p[0].data, shots: p[1].data }
        } catch { return null }
      })()
    : Promise.resolve(null)
  // A late switch sends the owed call from `fresh`; read it from there.
  return { first, saved: reads.some(r => r.fromCache), fresh, owed: () => owed, wait }
}

/** The counter's loads. The newest load wins. */
export function requiredPhotoCount(ui: { show: (c: PhotoCount) => void }) {
  let loads = 0
  // The reads behind what is on screen (null: nothing yet).
  let onScreen: Reads | null = null
  // The owed list as the server last gave it on this screen (null: not yet,
  // or it can't: every required shot counts).
  let owedKnown: Set<string> | null = null
  return {
    /** `soon`: the screen opening. Resolves once the final answers are in. */
    async load(job: any, user: any, opts: { soon?: boolean } = {}): Promise<void> {
      const seq = ++loads
      const current = () => seq === loads
      const addrId = jobAddressId(job)
      if (!addrId) return
      const startedAt = Date.now()
      const queuedBefore = await queuedNow(job.id)
      const { first, saved, fresh, owed, wait } = await readCount(job, user, addrId, !!opts.soon)
      // A reload that fell back to the saved copy keeps what is on screen.
      let reads: Reads | null = onScreen && saved && !opts.soon ? null : first
      const put = async () => {
        const r = reads ?? onScreen
        if (!r || !current()) return
        const queuedAfter = await queuedNow(job.id)
        if (!current()) return
        onScreen = r
        ui.show(countOf(r, owedKnown, queuedBefore, queuedAfter))
      }
      const takeOwed = (o: Set<string> | null | undefined) => { if (o !== undefined && current()) owedKnown = o }
      // On opening, the owed list too if it answers within the same wait: one
      // count on a good link, not every required shot and then the owed ones.
      const sent = owed()
      let owedDone = false
      if (sent && wait !== LIVE) {
        const o = await within(sent, Math.max(0, startedAt + wait - Date.now()))
        if (o !== undefined) { takeOwed(o); owedDone = true }
      }
      // Shown even when it keeps what is on screen: a shot taken since counts.
      await put()
      await Promise.all([
        fresh.then(async later => { if (later) { reads = later; await put() } }),
        (async () => {
          if (owedDone) return
          let p = owed()
          if (!p) { await fresh; p = owed() }  // a late switch sends the call from there
          if (!p) return
          const o = await p
          if (o === undefined) return
          takeOwed(o)
          await put()
        })(),
      ])
    },
  }
}
