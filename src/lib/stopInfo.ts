// What a stop's screen (JobDetailScreen) shows beside its details: the
// office's note and this person's "Got it"s (lib/crewNote), who arrives next
// (lib/nextArrival), "Stop k of M" on the crew's route, and the company's
// video-walkthrough switch.
//
// Who arrives next is read off the property's calendar: the job row carries a
// check-in only for a same-day turnover, so crews had no idea a guest was due
// in two days, and a block was easy to mistake for a guest. "Stop k of M"
// ranks this clean among the crew member's own route-ordered cleans that day,
// as Home does.
//
// CKS Perfections, 2026-10-15, one bar and no data: each was one cachedRead(),
// which on a link that swallows requests waits out the 15 s read deadline
// before falling back to the saved copy. So now every read starts at once,
// waits at most STOP_INFO_WAIT.ms for the live answer (not at all when the
// phone's last request already failed), and then shows the saved copy
// (dataCache readSoon). The live answer, when it comes, replaces it. These are
// read once, when the screen opens; nothing on them is the crew's to change.
//
// The note gates Clock in: a note the office asks to be read at clock-in
// holds the punch until "Got it". A saved note may show first because it can
// only add that step, never take a button away. A note the office added since
// the copy was saved shows when the live answer comes, and the screen asks for
// "Got it" then, as it already did for a clean started before the note loaded.
// The note goes on screen with the "Got it"s, never before them: on its own it
// would ask again for a wording already confirmed. "Got it"s are only ever
// added (a late answer can't drop one given while it was on its way): the
// server's, this device's (lib/crewNote localAcks), and this screen's
// (acknowledged()).
//
// Each read fails soft: no answer shows nothing (the video switch stays off).
// The reads are the shared builders in lib/jobReads, the ones the day pack
// saves (scripts/test-offline-day-pack.mjs checks this file too).
import { readSoon, type SoonRead } from './dataCache'
import { crewNoteRead, crewNoteAckRead, nextArrivalReads, routeStopRead, tenantVideoRead, isTaskJob } from './jobReads'
import { flushAcks, localAcks, type CrewNoteJob } from './crewNote'
import { pickNextArrival, type ArrivalRow, type NextArrival } from './nextArrival'
import { dayKey } from './timezone'
import { lastTripFailed } from './netFetch'

/** How long a read with a saved copy waits for the live answer. */
export const STOP_INFO_WAIT = { ms: 3_000 }

export interface StopInfoUi {
  /** The office's note for this clean. */
  note: (n: CrewNoteJob) => void
  /** Every wording this person has confirmed ("Got it"). */
  acks: (notes: string[]) => void
  /** Who arrives after this clean (null: nothing on file). */
  nextArrival: (n: NextArrival | null) => void
  /** "Stop k of M" (null: not on a route). */
  routeStop: (s: { k: number; m: number } | null) => void
  /** The company's video walkthroughs switch. */
  video: (on: boolean) => void
}

const list = (x: any): any[] => (Array.isArray(x) ? x : [])

/** A read's live answer, when it came after the saved copy showed. */
async function liveLater(r: SoonRead): Promise<SoonRead | null> {
  const late = await r.late
  return late && !late.fromCache ? { ...late, late: null } : null
}

/** The screen's loads of these. */
export function stopInfo(ui: StopInfoUi) {
  const acked = new Set<string>()
  const addAcks = (notes: string[]) => { notes.forEach(n => acked.add(n)); ui.acks([...acked]) }
  return {
    /** "Got it" on this screen. */
    acknowledged(note: string) { addAcks([note]) },
    /** Every read at once. Resolves once each has its final answer. */
    async load(job: any, user: any): Promise<void> {
      const wait = lastTripFailed() ? 0 : STOP_INFO_WAIT.ms
      const shown = async (p: Promise<SoonRead>, show: (data: any) => void) => {
        const r = await p
        show(r.data)
        const live = await liveLater(r)
        if (live) show(live.data)
      }
      const putNote = (jn: any) => {
        if (jn) ui.note({ crew_note: jn.crew_note ?? null, crew_note_at_clock_in: !!jn.crew_note_at_clock_in })
      }
      const ackNotes = (rows: any) => list(rows).map((r: any) => r.note)
      flushAcks().catch(() => {})
      await Promise.all([
        (async () => {
          const [n, a, mine] = await Promise.all([
            readSoon(crewNoteRead(job.id), wait),
            readSoon(crewNoteAckRead(job.id, user.id), wait),
            localAcks(job.id, user.id),
          ])
          addAcks([...mine, ...ackNotes(a.data)])
          putNote(n.data)
          await Promise.all([
            liveLater(a).then(live => { if (live) addAcks(ackNotes(live.data)) }),
            liveLater(n).then(live => { if (live) putNote(live.data) }),
          ])
        })().catch(() => {}),
        (async () => {
          const addr = job.client_addresses
          if (isTaskJob(job) || !addr?.id || !job.scheduled_start) return
          const cleanYmd = dayKey(job.scheduled_start)
          const reads = nextArrivalReads(job, addr.id, user.tenant_id)
          const put = ([stays, a, ten]: { data: any }[]) => {
            const rows = list(stays.data)
            ui.nextArrival(rows.length ? pickNextArrival(cleanYmd, rows as ArrivalRow[],
              { property: a.data?.default_checkin_time, company: ten.data?.default_checkin_time }) : null)
          }
          const rs = await Promise.all([readSoon(reads.stays, wait), readSoon(reads.property, wait), readSoon(reads.company, wait)])
          put(rs)
          if (!rs.some(r => r.late)) return
          const settled = await Promise.all(rs.map(r => r.late ?? r))
          if (rs.some((r, i) => r.late && !settled[i].fromCache)) put(settled)
        })().catch(() => {}),
        shown(readSoon(routeStopRead(job, user), wait), data => {
          const ordered = list(data).sort((a: any, b: any) => a.route_order - b.route_order)
          const idx = ordered.findIndex((j: any) => j.id === job.id)
          ui.routeStop(idx === -1 ? null : { k: idx + 1, m: ordered.length })
        }).catch(() => {}),
        shown(readSoon(tenantVideoRead(user.tenant_id), wait),
          data => ui.video(!!data?.video_walkthroughs_enabled)).catch(() => {}),
      ])
    },
  }
}
