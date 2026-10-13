// JobInventoryScreen's save as outbox writes, in the order they must land:
// the bare inserts, then one upsert per group of rows, then the delete of the
// lines the crew emptied. One `group`, so a write parked after repeated
// rejections takes the rest of its save with it. The plan is
// lib/inventoryLogSave (the same file as the web app's).
import type { OutboxWrite } from './outbox'
import type { InventorySavePlan } from './inventoryLogSave'

export function inventorySaveWrites(plan: InventorySavePlan, jobId: string, group: string): OutboxWrite[] {
  const table = 'job_inventory_log'
  return [
    ...(plan.bare.length ? [{ table, op: 'upsert' as const, onConflict: 'id', ignoreDuplicates: true, values: plan.bare, group }] : []),
    ...plan.upserts.map(values => ({ table, op: 'upsert' as const, onConflict: 'id', values, group })),
    ...(plan.deleteIds.length ? [{ table, op: 'delete' as const, match: { job_id: jobId }, matchIn: { id: plan.deleteIds }, values: {}, group }] : []),
  ]
}
