// Saving a clean's supply list (job_inventory_log) without replacing it.
//
// Both supply-list screens (the web Inventory tab, the crew app's Supplies
// screen) used to delete every row for the clean and insert the list again.
// Each save gave every row a new id, so it also dropped what other
// screens had stamped on those rows: restocked_at / restocked_by_role (Mark
// restocked, from the Supplies page or a portal), client_notified_at (Notify
// client, Supplies page) and the billable_charges.inventory_log_id link
// (ON DELETE SET NULL). A restocked line with no counts was deleted outright.
//
// This plans an id-stable save instead. Each row keeps its id:
//   - an unchanged line is not written at all;
//   - a changed line is updated in place (an upsert on id, sending only the
//     columns this screen edits, so the stamps above survive);
//   - a newly counted line is inserted under an id minted here, reused if the
//     save is retried, so a retry can't add a second row for the same item;
//   - a line the user emptied is deleted, unless its row carries a record a
//     delete would lose (restocked, client notified, or an incident link). That
//     row is emptied in place instead.
// Rows the screen never showed (no inventory_id, an older duplicate of an
// item, a row another screen added after this list loaded) are left alone.
//
// Restock emails. notify_restock_digest is two statement-level triggers: AFTER
// INSERT mails every flagged row in the statement, AFTER UPDATE only rows whose
// needs_restock went from not-true to true. An upsert fires BOTH: its new rows
// reach the INSERT trigger and its existing rows the UPDATE trigger. So one
// upsert that flags a new item and re-flags an existing row sends two emails.
// Every row this save turns flagged goes in ONE statement, and when that
// statement would mix the two kinds, the new rows are first inserted bare
// (unflagged, uncounted, nothing to mail), so every flag arrives as an UPDATE
// and the save sends one email per audience, as the replace-all save did.
//
// Stamps on a row the save leaves flagged. Every restock writer clears
// needs_restock when it stamps restocked_at, and the Supplies page treats a
// flag with restocked_at as closed (Notify client skips it; the loss report
// calls it resolved). So a row the save leaves flagged gets restocked_at and
// restocked_by_role cleared. A row the save turns flagged is a new flag, so
// client_notified_at (which recorded an email about an earlier flag) is
// cleared with them. A row that stays flagged keeps client_notified_at.
//
// Import-free on purpose. The same file is src/lib/inventoryLogSave.ts in both
// rinsebase-app (InventoryTab in JobPanel; unit test
// scripts/inventory-log-save.test.ts) and rinsebase-mobile (JobInventoryScreen).
// Keep the two identical.

/** One line on the screen, keyed by inventory_id. qty_remaining '' = not counted. */
export interface InventoryLine {
  qty_used: number
  qty_remaining: string
  needs_restock: boolean
  notes: string
  incident_id?: string | null
}

/** What the database holds for a line, as last read or written by this screen. */
export interface SavedLogRow {
  id: string
  item_name: string
  qty_used: number
  qty_remaining: number | null
  needs_restock: boolean
  notes: string | null
  incident_id: string | null
  /** needs_restock as the database has it, including the cycle-count trigger's auto-flag. */
  flagged: boolean
  /** Restocked, client notified or linked to an incident: emptying it must not delete it. */
  history: boolean
}

/** The job_inventory_log columns this needs from a row it reads. */
export interface LogRowRead {
  id: string
  inventory_id: string | null
  item_name?: string | null
  qty_used?: number | null
  qty_remaining?: number | null
  needs_restock?: boolean | null
  notes?: string | null
  incident_id?: string | null
  restocked_at?: string | null
  client_notified_at?: string | null
  created_at?: string | null
}

export interface CatalogItem {
  id: string
  item_name?: string | null
  par_level?: number | null
}

export interface LogRowWrite {
  id: string
  tenant_id: string
  job_id: string
  inventory_id: string
  item_name: string
  qty_used?: number
  qty_remaining?: number | null
  needs_restock?: boolean
  notes?: string | null
  incident_id?: string | null
  restocked_at?: null
  restocked_by_role?: null
  client_notified_at?: null
}

export interface InventorySavePlan {
  /** Insert-if-absent (upsert, ignoreDuplicates) before anything else. Empty unless needed. */
  bare: LogRowWrite[]
  /** One upsert on id per array, in order; every row in an array has the same keys. */
  upserts: LogRowWrite[][]
  /** Delete these ids (scoped to the clean) after the upserts. */
  deleteIds: string[]
  /** Ids minted for lines with no row yet. Keep them until the save lands. */
  minted: Record<string, string>
  /** inventory_ids this save turns flagged: the only rows notify_restock_digest mails. */
  raised: string[]
  /** The baseline once every write above has landed. */
  saved: Record<string, SavedLogRow>
}

export interface PlanInput {
  tenantId: string
  jobId: string
  lines: Record<string, InventoryLine>
  saved: Record<string, SavedLogRow>
  catalog: CatalogItem[]
  /** Ids an earlier, unfinished save minted for lines with no row yet. */
  minted: Record<string, string>
  newId: () => string
  /** How this screen stores notes ('' → null). */
  normalizeNotes?: (notes: string) => string | null
}

/** The screen's line for a row it read. */
export function lineFromRow(r: LogRowRead): InventoryLine {
  return {
    qty_used: r.qty_used ?? 0,
    qty_remaining: r.qty_remaining != null ? String(r.qty_remaining) : '',
    needs_restock: !!r.needs_restock,
    notes: r.notes ?? '',
    incident_id: r.incident_id ?? null,
  }
}

export function savedFromRow(r: LogRowRead): SavedLogRow {
  return {
    id: r.id,
    item_name: r.item_name ?? '',
    qty_used: r.qty_used ?? 0,
    qty_remaining: r.qty_remaining ?? null,
    needs_restock: !!r.needs_restock,
    notes: r.notes ?? null,
    incident_id: r.incident_id ?? null,
    flagged: !!r.needs_restock,
    // A row read without the stamp columns (the crew app's offline copy from
    // before they were selected) can't show it has none: keep it if emptied.
    history: !!(r.restocked_at || r.client_notified_at || r.incident_id)
      || !('restocked_at' in r && 'client_notified_at' in r),
  }
}

/**
 * Lines and baseline for a clean's rows, keyed by inventory_id. A row with no
 * inventory_id is not a catalog line, so it is skipped and never written. When
 * an item has more than one row, the newest is the line and the rest are left
 * as they are.
 */
export function readLogRows(rows: LogRowRead[]): { lines: Record<string, InventoryLine>; saved: Record<string, SavedLogRow> } {
  const lines: Record<string, InventoryLine> = {}
  const saved: Record<string, SavedLogRow> = {}
  const newestFirst = [...rows].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
  for (const r of newestFirst) {
    if (!r.inventory_id || saved[r.inventory_id]) continue
    lines[r.inventory_id] = lineFromRow(r)
    saved[r.inventory_id] = savedFromRow(r)
  }
  return { lines, saved }
}

/** sync_inventory_from_cycle_count's auto-flag: a count below the catalog par. */
export function belowPar(qtyRemaining: number | null, par: number | null | undefined): boolean {
  return qtyRemaining != null && par != null && qtyRemaining < par
}

type Kind = 'raised' | 'open' | 'kept'

export function planInventorySave(input: PlanInput): InventorySavePlan {
  const { tenantId, jobId, lines, saved, catalog, newId } = input
  const normalizeNotes = input.normalizeNotes ?? ((n: string) => n || null)
  const catalogById = new Map(catalog.map(c => [c.id, c]))
  const groups: Record<Kind, LogRowWrite[]> = { raised: [], open: [], kept: [] }
  const raisedNew = new Set<string>()
  const deleteIds: string[] = []
  const minted: Record<string, string> = {}
  const next: Record<string, SavedLogRow> = {}

  for (const inv of new Set([...Object.keys(saved), ...Object.keys(lines)])) {
    const line = lines[inv]
    const prev = saved[inv]
    const values = {
      qty_used: line?.qty_used || 0,
      qty_remaining: !line || line.qty_remaining === '' ? null : Number(line.qty_remaining),
      needs_restock: !!line?.needs_restock,
      notes: line ? normalizeNotes(line.notes ?? '') : null,
      incident_id: line?.incident_id ?? prev?.incident_id ?? null,
    }
    const empty = !(values.qty_used > 0 || values.needs_restock || values.qty_remaining !== null)

    if (!prev) {
      // Nothing to write; but an unfinished save may have landed this id.
      if (empty) { if (input.minted[inv]) deleteIds.push(input.minted[inv]); continue }
    } else {
      const unchanged = values.qty_used === prev.qty_used
        && values.qty_remaining === prev.qty_remaining
        && values.needs_restock === prev.needs_restock
        && values.notes === prev.notes
        && values.incident_id === prev.incident_id
      if (unchanged) { next[inv] = prev; continue }
      if (empty && !prev.history) { deleteIds.push(prev.id); continue }
    }

    const id = prev?.id ?? input.minted[inv] ?? newId()
    if (!prev) minted[inv] = id
    const item = catalogById.get(inv)
    const item_name = item?.item_name || prev?.item_name || ''
    const flagged = values.needs_restock || belowPar(values.qty_remaining, item?.par_level)
    const kind: Kind = !flagged ? 'kept' : prev?.flagged ? 'open' : 'raised'
    const row: LogRowWrite = { id, tenant_id: tenantId, job_id: jobId, inventory_id: inv, item_name, ...values }
    if (kind !== 'kept') { row.restocked_at = null; row.restocked_by_role = null }
    if (kind === 'raised') { row.client_notified_at = null; if (!prev) raisedNew.add(id) }
    groups[kind].push(row)
    next[inv] = {
      id, item_name, ...values, flagged,
      history: (prev?.history ?? false) || !!values.incident_id,
    }
  }

  // One statement for every flag this save raises. If it mixes new rows with
  // existing ones, insert the new ones bare first, so the whole statement is
  // UPDATEs and notify_restock_digest mails once (see the header).
  const mixed = raisedNew.size > 0 && raisedNew.size < groups.raised.length
  const bare: LogRowWrite[] = mixed
    ? groups.raised.filter(r => raisedNew.has(r.id)).map(r => ({
        id: r.id, tenant_id: r.tenant_id, job_id: r.job_id, inventory_id: r.inventory_id, item_name: r.item_name,
      }))
    : []

  return {
    bare,
    upserts: [groups.raised, groups.open, groups.kept].filter(g => g.length > 0),
    deleteIds,
    minted,
    raised: groups.raised.map(r => r.inventory_id),
    saved: next,
  }
}
