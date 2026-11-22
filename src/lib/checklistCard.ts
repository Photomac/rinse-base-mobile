// The checklist card on a stop's screen (JobDetailScreen): what it reads, and
// when its spinner gives way.
//
// CKS Perfections, 2026-10-15, job #1612: a crew member at a stop with one bar
// and no data opened the clean. The card said "Cleaning checklist 0/20" over a
// spinner that would not go away, with the whole list saved on the phone by
// the offline day pack. The card read in three rounds, one after another
// (template + rows, then six room/photo reads, then item photos), and on a
// link that swallows requests every round waited out the 15 s read deadline
// before falling back to the saved copy: 45 s and more on every open. Prod's
// edge logs show the second open's round two reaching the server ~38 s after
// the screen opened, and round three never arriving.
//
// So now:
// - Every read starts at once: one round, not three.
// - A read with a saved copy waits at most CHECKLIST_WAIT.ms for the live
//   answer, and not at all when the phone's last request already failed; then
//   the card shows the saved copy (dataCache readSoon). Queued offline ticks
//   overlay it, as before.
// - The live answer, when it comes, refreshes the card, unless the crew has
//   ticked something since the load began: the answer may predate the tick.
// - A reload (a teammate's tick, back from Photos) never steps back to the
//   saved copy once the card shows something: what's on screen is at least as
//   new, and holds ticks that went through live since the copy was saved. It
//   stays until the live answer comes.
// - The spinner is cleared in a finally, so nothing that throws can leave it
//   up. A throw is reported (admin System Health); a card that never loaded
//   then shows no list rather than an invented one.
//
// The reads are the shared builders in lib/jobReads, the ones the day pack
// saves (scripts/test-offline-day-pack.mjs checks this file too).
//
// A quiet reload keeps what describes the PROPERTY (2026-11-22): a teammate's
// tick, a photo landing or a sign-off can't change the home's template, rooms,
// photo requirements or checklist mode, but every such reload read all ten
// parts again. Production logs: the checklist group read ~600-730 times an
// hour against ~420 opens of the stop. So a quiet load reuses those five from
// the card's last load that read them all live, for STATIC_KEEP_MS, and reads
// only the clean's own five (rows, sign-offs, shots, item photos, line
// answers). Opening the stop and coming back from Photos read everything, as
// before, so an office edit shows the next time the crew opens it.
import { cachedRead, readSoon, type SoonRead } from './dataCache'
import {
  checklistTemplateRead, checklistRowsRead, tenantSeedRead, roomsRead, roomSignoffsRead,
  addressModeRead, tenantModeRead, photoRequirementsRead, requirementShotsRead, itemPhotosRead, lineVideosRead,
} from './jobReads'
import { lineAskRows, type LineClipState } from './lineVideos'
import { overlayPending } from './outbox'
import { newestPerShot, queuedListNow, roomShotLists, roomShots, type QueuedList } from './roomShots'
import { isWalkthroughJob } from './walkthrough'
import { lastTripFailed } from './netFetch'
import { reportClientError } from './errorReporter'

/** How long a read with a saved copy waits for the live answer. */
export const CHECKLIST_WAIT = { ms: 3_000 }

/** How long a quiet reload reuses the property's parts from the last full live load. */
export const STATIC_KEEP_MS = 10 * 60_000

/** The parts that describe the property, not the clean: what a quiet reload may keep. */
export type StaticParts = { tmpl: any; rooms: any; addrMode: any; tenMode: any; reqs: any }

export interface ChecklistView {
  items: any[]
  /** item id → ticked */
  checked: Record<string, boolean>
  /** The job's rows are an inspection walkthrough (WalkthroughChecklist shows them). */
  walkthrough: boolean
  /** Rooms, sign-offs, the property's mode and its photo shots. Absent for a
   *  job with no property, or when they couldn't be worked out. */
  rooms?: { meta: any[]; signoffs: Record<string, string>; mode: string; evidence: any[] }
  /** Photos per item. Absent when the read returned nothing. */
  itemPhotos?: Record<string, number>
  /** Line clips the server has, by job_checklist_items id (lib/lineVideos). The
   *  screen lays this phone's queued clips over them. */
  lineClips: Record<string, LineClipState>
}

const list = (x: any): any[] => (Array.isArray(x) ? x : [])
const NONE: SoonRead = { data: null, error: null, fromCache: false, late: null }

type Parts = { tmpl: any; rows: any; rooms: any; signoffs: any; addrMode: any; tenMode: any; reqs: any; shots: any; photos: any; lineVids: any }

// The job's own checklist rows (seeded at job creation) are the shared source
// of truth with the owner dashboard: both sides must read the same rows and
// the same `completed` flags, or the crew and the owner see different
// checklists. A row EXISTING does not mean it's done; only `completed = true`
// does. Templates are a fallback for jobs that were never seeded. The built-in
// default list covers properties with no template, EXCEPT when the company
// runs with checklists off (tenants.default_checklist_seed = 'none'): an owner
// who deliberately cleared every checklist must not have crews working an
// invented list they can't see or edit.
async function viewOf(p: Parts, job: any, hasProperty: boolean, defaults: any[],
  seed: () => Promise<{ data: any }>, queuedBefore: QueuedList): Promise<ChecklistView> {
  const tmpl = list(p.tmpl)
  // Queued offline ticks overlay the saved/live rows (rows are already scoped
  // to this job, matching the ops' job_id filter).
  const rows = await overlayPending('job_checklist_items', list(p.rows), v => v.job_id === job.id)
  let items: any[]
  const checked: Record<string, boolean> = {}
  // Lines that ask for a clip or a question: their own read, so a server
  // without the columns (or a failed read) leaves the list exactly as it was.
  // Answers given with no signal overlay it, as ticks overlay the rows.
  const asked = lineAskRows(await overlayPending('job_checklist_items', list(p.lineVids), () => false))
  if (rows.length > 0) {
    // The job has its own rows: render them as-is, template or not.
    items = rows.map(r => {
      const a = asked.asks.get(r.id)
      return { id: r.id, jobItemId: r.id, label: `${r.room} — ${r.task}`, room: r.room, title: r.task, requires_photo: r.photo_required || false, video_mode: a?.video_mode ?? 'off', answer_type: a?.answer_type ?? 'tick', answer: a?.answer ?? null, room_uid: r.room_id, item_kind: r.item_kind || 'task', level: r.level || 'guidance', result: r.result ?? null, issue_note: r.issue_note ?? null }
    })
    rows.forEach(r => { if (r.completed) checked[r.id] = true })
  } else if (tmpl.length > 0) {
    // Template exists but this job was never seeded: ticks upsert rows.
    items = tmpl.map((item: any) => ({ id: item.id, label: `${item.room} — ${item.title}`, room: item.room, title: item.title, requires_photo: item.requires_photo || false }))
  } else {
    // No rows, no template. Companies that deliberately run without
    // checklists get an empty list; everyone else keeps the default.
    // Fail-open to the default: offline or a fetch error must not strip a
    // crew of the list they had yesterday.
    let seedMode = 'generated'
    try {
      const { data: t } = await seed()
      if (t?.default_checklist_seed) seedMode = t.default_checklist_seed
    } catch { /* the default */ }
    items = seedMode === 'none' ? [] : defaults.map(d => ({ ...d }))
  }
  const view: ChecklistView = { items, checked, walkthrough: isWalkthroughJob(rows), lineClips: asked.server }

  // Rooms, sign-offs, mode and the property's photo shots: best effort; without
  // them the card groups everything under "Other".
  if (hasProperty) {
    try {
      const signRows = await overlayPending('job_room_signoffs', list(p.signoffs), v => v.job_id === job.id)
      const signoffs: Record<string, string> = {}
      for (const r of signRows) if (r.room_id) signoffs[r.room_id] = r.completed_at
      const addrMode = list(p.addrMode)[0]?.checklist_execution_mode
      const tenMode = list(p.tenMode)[0]?.checklist_execution_mode
      // The latest shot per requirement, the ones still on the phone over the
      // server's (lib/roomShots): a reload never puts "Take photo" back on a
      // shot that is uploading. `shots` on each row: every photo it holds.
      const queuedAfter = await queuedListNow(job.id)
      const shots = roomShots(list(p.shots), newestPerShot(queuedBefore), newestPerShot(queuedAfter))
      const all = roomShotLists(list(p.shots), queuedBefore, queuedAfter)
      view.rooms = {
        meta: list(p.rooms),
        signoffs,
        mode: addrMode || tenMode || 'detailed',
        evidence: list(p.reqs).map(rq => ({
          ...rq,
          photo_url: shots[rq.id]?.uri ?? null,
          photo_fallback: shots[rq.id]?.fallback ?? null,
          photo_state: shots[rq.id]?.state ?? null,
          shots: all[rq.id] ?? [],
        })),
      }
    } catch { /* the flat grouping */ }
  }

  // A photo counts for an item via the canonical checklist_item_id link, or by
  // the legacy caption == task-title match (photos from older bundles / web
  // uploads before the link existed).
  if (Array.isArray(p.photos)) {
    const counts: Record<string, number> = {}
    items.forEach(item => {
      counts[item.id] = p.photos.filter((ph: any) =>
        (item.jobItemId && ph.checklist_item_id === item.jobItemId) ||
        (!ph.checklist_item_id && ph.caption === item.title)
      ).length
    })
    view.itemPhotos = counts
  }
  return view
}

/**
 * Read the card for `job` at `addressId` (null: a job with no property).
 * `first` comes within CHECKLIST_WAIT.ms whenever the phone has saved copies;
 * `saved` says it holds at least one.
 * `fresh` resolves to a newer view once the live answers that were too slow
 * for `first` come in, or to null when there is nothing newer (none were
 * late, or the late ones failed too and fell back to the same saved copy).
 */
export async function readChecklist(job: any, user: any, addressId: string | null, defaults: any[], kept: StaticParts | null = null):
  Promise<{ first: ChecklistView; saved: boolean; fresh: Promise<ChecklistView | null>; staticLive: StaticParts | null }> {
  // Asked again before the seed read: by then the round may have failed.
  const waitNow = () => (lastTripFailed() ? 0 : CHECKLIST_WAIT.ms)
  const wait = waitNow()
  const a = addressId
  // The shots on the phone as the reads go out (lib/roomShots).
  const queuedBefore: QueuedList = a ? await queuedListNow(job.id) : []
  // A kept part stands in for its read: a live answer, already in hand.
  const k = (data: any): SoonRead => ({ data, error: null, fromCache: false, late: null })
  const keep = a ? kept : null
  const reads = await Promise.all([
    a ? (keep ? k(keep.tmpl) : readSoon(checklistTemplateRead(a), wait)) : NONE,
    readSoon(checklistRowsRead(job.id), wait),
    a ? (keep ? k(keep.rooms) : readSoon(roomsRead(a), wait)) : NONE,
    a ? readSoon(roomSignoffsRead(job.id), wait) : NONE,
    a ? (keep ? k(keep.addrMode) : readSoon(addressModeRead(a), wait)) : NONE,
    a ? (keep ? k(keep.tenMode) : readSoon(tenantModeRead(user.tenant_id), wait)) : NONE,
    a ? (keep ? k(keep.reqs) : readSoon(photoRequirementsRead(a), wait)) : NONE,
    a ? readSoon(requirementShotsRead(job.id), wait) : NONE,
    readSoon(itemPhotosRead(job.id), wait),
    readSoon(lineVideosRead(job.id), wait),
  ])
  const parts = (r: { data: any }[]): Parts => ({
    tmpl: r[0].data, rows: r[1].data, rooms: r[2].data, signoffs: r[3].data, addrMode: r[4].data,
    tenMode: r[5].data, reqs: r[6].data, shots: r[7].data, photos: r[8].data, lineVids: r[9].data,
  })
  // The seed is read only for a job with no rows and no template.
  const first = await viewOf(parts(reads), job, !!a, defaults, () => readSoon(tenantSeedRead(user.tenant_id), waitNow()), queuedBefore)
  const fresh = reads.some(r => r.late)
    ? (async () => {
        try {
          const settled = await Promise.all(reads.map(r => r.late ?? r))
          if (!reads.some((r, i) => r.late && !settled[i].fromCache)) return null
          return await viewOf(parts(settled), job, !!a, defaults, () => cachedRead(tenantSeedRead(user.tenant_id)), queuedBefore)
        } catch { return null }
      })()
    : Promise.resolve(null)
  // The property's parts, when this load read all five live in time (not a
  // saved copy, not late, no error): what a quiet reload may reuse.
  const STATIC = [0, 2, 4, 5, 6]
  const staticLive = a && !keep && STATIC.every(i => !reads[i].fromCache && !reads[i].late && !reads[i].error)
    ? { tmpl: reads[0].data, rooms: reads[2].data, addrMode: reads[4].data, tenMode: reads[5].data, reqs: reads[6].data }
    : null
  return { first, saved: reads.some(r => r.fromCache), fresh, staticLive }
}

/**
 * The card's loads. `show` puts a view on screen; `setLoading` is the spinner.
 * The newest load wins; a load that started before the crew's last change on
 * the card (edited()) doesn't overwrite what they see.
 */
export function checklistCard(ui: { show: (v: ChecklistView) => void; setLoading: (on: boolean) => void }) {
  let loads = 0
  let edits = 0
  let shown = false
  // The property's parts from the last load that read them all live (STATIC_KEEP_MS).
  let kept: { key: string; at: number; parts: StaticParts } | null = null
  const show = (v: ChecklistView) => { shown = true; ui.show(v) }
  return {
    /** The crew ticked, answered or signed off something on the card. */
    edited() { edits++ },
    /** quiet = refresh in place (a teammate's tick, a photo landing): no spinner. */
    async load(job: any, user: any, addressId: string | null, defaults: any[], quiet = false): Promise<void> {
      const seq = ++loads
      const editsAtStart = edits
      const current = () => seq === loads && edits === editsAtStart
      if (!quiet) ui.setLoading(true)
      // Only a quiet load reuses them, only for this clean at this property, and
      // only while they're fresh: opening and Photos read everything again.
      const key = `${job?.id ?? ''}|${addressId ?? ''}`
      const reuse = quiet && kept && kept.key === key && Date.now() - kept.at < STATIC_KEEP_MS ? kept.parts : null
      if (!quiet) kept = null
      try {
        const { first, saved, fresh, staticLive } = await readChecklist(job, user, addressId, defaults, reuse)
        if (staticLive) kept = { key, at: Date.now(), parts: staticLive }
        if (!current()) return
        if (!(shown && saved)) show(first)
        ui.setLoading(false)
        const later = await fresh
        if (later && current()) show(later)
      } catch (e: any) {
        reportClientError(`checklist card: ${e?.message || e}`, e?.stack, 'checklist')
        // Never loaded: no card rather than the screen's built-in list, whose
        // ticks would write rows to a clean that has its own.
        if (!shown && seq === loads) show({ items: [], checked: {}, walkthrough: false, lineClips: {} })
      } finally {
        // A newer load clears it in its own finally.
        if (seq === loads) ui.setLoading(false)
      }
    },
  }
}
