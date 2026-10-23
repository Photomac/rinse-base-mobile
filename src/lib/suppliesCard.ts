// A clean's Supplies screen (JobInventoryScreen): what it reads, and how soon
// the saved copy shows.
//
// It reads in one round (the property's catalog and rooms, this clean's log,
// the office's extra linen), but on a link that swallows requests (CKS
// Perfections, 2026-10-15, one bar) that round waited out the 15 s read
// deadline behind a spinner before the saved copy showed, and nothing cleared
// the spinner if the load threw.
//
// So now:
// - Every read waits at most SUPPLIES_WAIT.ms for the live answer, and not at
//   all when the phone's last request already failed; then the saved copy
//   shows (dataCache readSoon). Saves still waiting in the outbox overlay it,
//   as before. The spinner goes in a finally, and a throw is reported.
// - The live answer, when it comes, replaces the catalog, rooms and extra
//   linen. The save writes only the lines that differ from what the database
//   holds (lib/inventoryLogSave, the screen's savedRef), so the live rows
//   become that baseline, and the lines show the live rows except the ones
//   the crew has changed since the list loaded (rebaseLines). A row a teammate
//   logged meanwhile is then neither deleted nor written again by her save,
//   and a line she changed is written over the row it now has.
// - Once she has saved (queued or not), a live answer that comes after is not
//   shown: it may predate the save.
//
// The reads are the shared builders in lib/jobReads, the ones the day pack
// saves (scripts/test-offline-day-pack.mjs checks this file too).
import { readSoon, type SoonRead } from './dataCache'
import { inventoryItemsRead, inventoryLogRead, inventoryRoomsRead, linenExtrasRead, openRestockRead, supplyCountsTenantRead } from './jobReads'
import { openFlagsByItem, crewCountsFrom, type ItemFlag } from './restockView'
import { overlayPending } from './outbox'
import { readLogRows, type InventoryLine, type LogRowRead, type SavedLogRow } from './inventoryLogSave'
import { lastTripFailed } from './netFetch'
import { reportClientError } from './errorReporter'

/** How long a read with a saved copy waits for the live answer. */
export const SUPPLIES_WAIT = { ms: 3_000 }

export interface SuppliesView {
  items: any[]
  rooms: any[]
  /** inventory_id → extra linen the office added for this booking. */
  extras: Record<string, number>
  /** The lines, keyed by inventory_id. */
  lines: Record<string, InventoryLine>
  /** What the database holds per line: the baseline the save diffs against. */
  saved: Record<string, SavedLogRow>
  /** inventory_id → flagged low here on an earlier visit, not restocked yet. */
  open: Record<string, ItemFlag>
  /** The company lets the crew add counts (tenants.crew_supply_counts). */
  crewCounts: boolean
  /** Showing the phone's saved copy, not live data. */
  offline: boolean
}

const list = (x: any): any[] => (Array.isArray(x) ? x : [])

async function viewOf(job: any, [inv, log, rooms, extras, open, counts]: { data: any; error?: any; fromCache: boolean }[]): Promise<SuppliesView> {
  // A save still waiting in the outbox shows as saved, not as the old rows.
  const logRows = await overlayPending('job_inventory_log', list(log.data), v => v.job_id === job.id)
  const { lines, saved } = readLogRows(logRows as LogRowRead[])
  return {
    items: list(inv.data),
    rooms: list(rooms.data),
    extras: Object.fromEntries(list(extras.data).map((x: any) => [x.inventory_id, x.extra_qty])),
    lines, saved,
    open: openFlagsByItem(open.data, job.id),
    crewCounts: crewCountsFrom(counts.data, counts.error),
    offline: inv.fromCache || log.fromCache,
  }
}

/** The live lines, except the ones the crew changed since the list loaded. */
export function rebaseLines(live: Record<string, InventoryLine>, current: Record<string, InventoryLine>,
  edited: Set<string>): Record<string, InventoryLine> {
  const out = { ...live }
  for (const inv of edited) if (current[inv]) out[inv] = current[inv]
  return out
}

/** Read the screen. `fresh` resolves to the view once late live answers are
 *  in, or to null when nothing newer came. */
export async function readSupplies(job: any, addrId: string, wait: number, tenantId: string = job?.tenant_id):
  Promise<{ first: SuppliesView; fresh: Promise<SuppliesView | null> }> {
  const reads: SoonRead[] = await Promise.all([
    readSoon(inventoryItemsRead(addrId), wait),
    readSoon(inventoryLogRead(job.id), wait),
    readSoon(inventoryRoomsRead(addrId), wait),
    // Extra linen the office added for THIS booking on the Linen Pull Sheet —
    // e.g. a 14-guest group in a house whose par is 10 bath towels. Without
    // this the phone would say "6/6 packed" on a turnover the office says
    // needs four more, and the crew would leave short.
    readSoon(linenExtrasRead(job.id), wait),
    // What's already flagged low at the home on earlier visits, and whether
    // the crew may add counts (lib/restockView).
    readSoon(openRestockRead(addrId), wait),
    // The company: the signed-in person's (a job row may not carry it), the key the day pack saves.
    readSoon(supplyCountsTenantRead(tenantId), wait),
  ])
  const first = await viewOf(job, reads)
  const fresh = reads.some(r => r.late)
    ? (async () => {
        try {
          const settled = await Promise.all(reads.map(r => r.late ?? r))
          if (!reads.some((r, i) => r.late && !settled[i].fromCache)) return null
          return await viewOf(job, settled)
        } catch { return null }
      })()
    : Promise.resolve(null)
  return { first, fresh }
}

/**
 * The screen's load. `show` puts a view on screen (`late`: the live answer
 * after the saved copy, see above); `setLoading` is the spinner.
 */
export function suppliesCard(ui: { show: (v: SuppliesView, late: boolean) => void; setLoading: (on: boolean) => void }) {
  let loads = 0
  let saves = 0
  return {
    /** The crew is saving the list. */
    saving() { saves++ },
    async load(job: any, addrId: string, tenantId: string = job?.tenant_id): Promise<void> {
      const seq = ++loads
      const savesAtStart = saves
      ui.setLoading(true)
      try {
        const { first, fresh } = await readSupplies(job, addrId, lastTripFailed() ? 0 : SUPPLIES_WAIT.ms, tenantId)
        if (seq !== loads) return
        ui.show(first, false)
        ui.setLoading(false)
        const later = await fresh
        if (later && seq === loads && saves === savesAtStart) ui.show(later, true)
      } catch (e: any) {
        reportClientError(`supplies: ${e?.message || e}`, e?.stack, 'supplies')
      } finally {
        if (seq === loads) ui.setLoading(false)
      }
    },
  }
}
