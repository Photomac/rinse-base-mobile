// Supplies save (JobInventoryScreen) through the write outbox. Run with:
// node scripts/test-inventory-log-save.mjs
//
// The save no longer replaces the clean's rows: it upserts changed lines by
// their own id and deletes only the lines the crew emptied (the plan is
// lib/inventoryLogSave, shared with the web app, whose unit test covers the
// plan itself). This checks what the crew app adds: the writes queue offline
// in order under one group, a reopened screen shows the queued save on the
// SAME row ids, a bare insert never overwrites a row in the overlay or on the
// server, a replay sends the same ids, and saving the shown list again writes
// nothing.
import { writeThrough, flushOutbox, pendingOpCount, overlayPending, uuid4 } from '../outbox'
import { net } from './outbox.mocks'
import { planInventorySave, readLogRows } from '../inventoryLogSave'
import { inventorySaveWrites } from '../inventoryLogOutbox'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const settle = () => new Promise(r => setTimeout(r, 10))

const T = 'T1', J = 'J1'
const TP = 'inv-tp', PT = 'inv-pt', SOAP = 'inv-soap', SH = 'inv-shampoo'
const catalog = [
  { id: TP, item_name: 'Toilet paper', par_level: 4 },
  { id: PT, item_name: 'Paper towels', par_level: 2 },
  { id: SOAP, item_name: 'Dish soap', par_level: null },
  { id: SH, item_name: 'Shampoo', par_level: 2 },
]
const stamps = { restocked_at: null, client_notified_at: null }
const server = [
  { id: 'row-tp', job_id: J, inventory_id: TP, item_name: 'Toilet paper', qty_used: 0, qty_remaining: null, needs_restock: true, notes: null, incident_id: null, restocked_at: null, client_notified_at: '2026-10-12T15:00:00Z', created_at: '2026-10-12T10:00:00Z' },
  { id: 'row-pt', job_id: J, inventory_id: PT, item_name: 'Paper towels', qty_used: 1, qty_remaining: 3, needs_restock: false, notes: null, incident_id: null, ...stamps, created_at: '2026-10-12T10:00:00Z' },
  { id: 'row-soap', job_id: J, inventory_id: SOAP, item_name: 'Dish soap', qty_used: 2, qty_remaining: null, needs_restock: false, notes: null, incident_id: null, ...stamps, created_at: '2026-10-12T10:00:00Z' },
  { id: 'row-adhoc', job_id: J, inventory_id: null, item_name: 'Ad hoc thing', qty_used: 0, needs_restock: true, ...stamps, created_at: '2026-10-12T10:00:00Z' },
]

;(async () => {
  // ── The crew opens Supplies with no signal and edits ─────────────────────
  net.online = false
  const read = readLogRows(server)
  const lines = { ...read.lines }
  lines[PT] = { ...lines[PT], needs_restock: true }                                    // existing row: flag it
  lines[SH] = { qty_used: 0, qty_remaining: '1', needs_restock: false, notes: '' }     // new item, counted below par
  lines[SOAP] = { qty_used: 0, qty_remaining: '', needs_restock: false, notes: '' }    // emptied
  const plan = planInventorySave({ tenantId: T, jobId: J, lines, saved: read.saved, catalog, minted: {}, newId: uuid4, normalizeNotes: n => n.trim() || null })
  const writes = inventorySaveWrites(plan, J, uuid4())
  for (const w of writes) {
    const r = await writeThrough(w)
    if (r.error || !r.queued) ok(`offline write queued (${w.op})`, false)
  }
  ok('offline: the save queues as bare insert, one upsert, one delete', (await pendingOpCount()) === 3 &&
    writes.map(w => `${w.op}${w.ignoreDuplicates ? ':bare' : ''}`).join(',') === 'upsert:bare,upsert,delete')
  ok('…all in one group', new Set(writes.map(w => w.group)).size === 1)
  ok('…the delete names only the emptied row, scoped to the clean',
    writes[2].match?.job_id === J && JSON.stringify(writes[2].matchIn) === JSON.stringify({ id: ['row-soap'] }) && !writes[2].keep)
  ok('…Toilet paper (untouched, client notified) is not written', !writes.some(w => (Array.isArray(w.values) ? w.values : [w.values]).some((v: any) => v.id === 'row-tp')))

  // ── Reopened offline: the queued save, on the same ids ───────────────────
  const shown = await overlayPending('job_inventory_log', server.map(r => ({ ...r })), v => v.job_id === J)
  const byId = new Map(shown.map(r => [r.id, r]))
  ok('overlay: Paper towels flagged on its own id, stamps cleared', byId.get('row-pt')?.needs_restock === true && byId.get('row-pt')?.client_notified_at === null)
  ok('overlay: Toilet paper keeps its client_notified_at', byId.get('row-tp')?.client_notified_at === '2026-10-12T15:00:00Z')
  ok('overlay: Dish soap gone, ad hoc row still there', !byId.has('row-soap') && byId.has('row-adhoc'))
  const shampoo = shown.filter(r => r.inventory_id === SH)
  ok('overlay: Shampoo once, with its count (the bare insert did not win)', shampoo.length === 1 && shampoo[0].qty_remaining === 1)
  const again = readLogRows(shown)
  const replan = planInventorySave({ tenantId: T, jobId: J, lines: again.lines, saved: again.saved, catalog, minted: {}, newId: uuid4, normalizeNotes: n => n.trim() || null })
  ok('saving the reopened list again writes nothing', replan.bare.length + replan.upserts.length + replan.deleteIds.length === 0)

  // A bare insert never overwrites a row that is already there (overlay).
  await writeThrough({ table: 'job_inventory_log', op: 'upsert', onConflict: 'id', ignoreDuplicates: true, values: [{ id: 'row-pt', job_id: J, inventory_id: PT, item_name: 'Paper towels' }] })
  const shown2 = await overlayPending('job_inventory_log', server.map(r => ({ ...r })), v => v.job_id === J)
  ok('overlay: a queued bare insert leaves an existing row as it is', shown2.find(r => r.id === 'row-pt')?.qty_used === 1)

  // ── Signal returns: the same ids reach the server, in order ──────────────
  await settle()
  net.online = true
  net.applied.length = 0
  await flushOutbox()
  ok('online: everything flushed', (await pendingOpCount()) === 0)
  ok('…bare insert first, sent with ignoreDuplicates', net.applied[0]?.op === 'upsert' && net.applied[0]?.opts?.ignoreDuplicates === true && net.applied[0]?.opts?.onConflict === 'id')
  ok('…then the upsert of the raised flags, on id', net.applied[1]?.op === 'upsert' && net.applied[1]?.opts?.onConflict === 'id' && !net.applied[1]?.opts?.ignoreDuplicates &&
    net.applied[1].values.map((v: any) => v.id).sort().join(',') === ['row-pt', plan.minted[SH]].sort().join(','))
  ok('…the Shampoo row keeps the id it was minted with', net.applied[0].values[0].id === plan.minted[SH])
  ok('…then the delete, by id within the clean', net.applied[2]?.op === 'delete' &&
    net.applied[2].filters.includes(`job_id=eq.${J}`) && net.applied[2].filters.includes('id=in.(row-soap)'))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
