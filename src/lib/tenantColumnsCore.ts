// The company settings a clean's screen reads, from one request.
//
// A clean's screen (and the offline day pack) reads a dozen company switches,
// each through its own cached read in lib/jobReads: the checklist mode, the
// photo rule, Check first, the clock-in rule, the supplies switches, the stay
// rating rules, the walkthrough videos, the check-in time... Each one used to
// be its own tenants request, all at once, every time a clean opened: about
// 10 per open, ~12,000 a day (API logs 2026-11-19/20, 5-13 ms each).
//
// Now every read asks tenantColumns(tenantId, its columns) instead. Reads
// that start while one request for the company is still on its way share it:
// it asks for every column below, and each read takes back only its own, in
// the shape its old request answered (one row, or a list of one). Nothing is
// kept once it answers, so the next screen load asks again, as before: a
// switch the office just changed shows on the next open.
//
// Each read still has its own key in the offline cache (lib/dataCache), so
// with no signal each falls back to its own saved copy, as before. And each
// read used to be its own request so that a database without one column (the
// app ahead of a migration) failed that read alone: when the shared request is
// refused for an unknown column (42703), each read asks for its own columns
// on their own, as before, and only the one naming the missing column fails.

/** Every column the shared request asks for: the union of the reads that use
 *  it. A read may only ask for columns listed here. */
export const TENANT_SETTING_COLUMNS = [
  'video_walkthroughs_enabled',
  'default_checkin_time',
  'default_checklist_seed',
  'checklist_execution_mode',
  'enforce_photo_requirements',
  'check_first_required',
  'clock_in_location_required',
  'lat',
  'lng',
  'home_base_precision',
  'home_base_label',
  'crew_supply_counts',
  'restock_two_choice',
  'stay_rating_photos_required',
  'stay_rating_at_arrival',
  'crew_prep_linens',
] as const

export type TenantColumn = (typeof TENANT_SETTING_COLUMNS)[number]
export type ReadAnswer = { data: any; error: any; status?: number }
/** How a read is sent: the columns, the company, and whether it answers one
 *  row (maybeSingle) or a list. */
export type FetchTenantRow = (columns: string, tenantId: string, single: boolean) => PromiseLike<ReadAnswer>

/** PostgREST's answer to a select naming a column the table doesn't have. */
export function unknownColumn(error: any): boolean {
  return !!error && (error.code === '42703' || /column .* does not exist/i.test(String(error.message ?? '')))
}

function pick(row: any, columns: readonly string[]) {
  const out: Record<string, unknown> = {}
  for (const c of columns) out[c] = row?.[c] ?? null
  return out
}

/** tenantColumns(tenantId, columns, shape): the answer the read's own request
 *  gave, from the company's shared request while one is on its way. */
export function createTenantColumns(fetchRow: FetchTenantRow) {
  const onTheWay = new Map<string, Promise<ReadAnswer>>()

  function shared(tenantId: string): Promise<ReadAnswer> {
    const going = onTheWay.get(tenantId)
    if (going) return going
    const p: Promise<ReadAnswer> = Promise.resolve()
      .then(() => fetchRow(TENANT_SETTING_COLUMNS.join(', '), tenantId, true))
      .then(
        res => res as ReadAnswer,
        // A thrown fetch is no signal, as dataCache reads it (status 0).
        (e: any) => ({ data: null, error: e ?? { message: 'tenant settings read failed' }, status: 0 }),
      )
    onTheWay.set(tenantId, p)
    // Kept only while on its way: the next load asks again.
    p.then(() => { if (onTheWay.get(tenantId) === p) onTheWay.delete(tenantId) })
    return p
  }

  return function tenantColumns(tenantId: string, columns: readonly TenantColumn[], shape: 'one' | 'list' = 'one'): Promise<ReadAnswer> {
    const unlisted = columns.filter(c => !(TENANT_SETTING_COLUMNS as readonly string[]).includes(c))
    if (unlisted.length > 0) {
      return Promise.reject(new Error(`tenantColumns: ${unlisted.join(', ')} not in TENANT_SETTING_COLUMNS`))
    }
    return shared(tenantId).then(res => {
      if (res.error && unknownColumn(res.error)) {
        // A database without one of the columns: this read asks for its own,
        // as it always did, and fails alone if it names the missing one.
        return Promise.resolve(fetchRow(columns.join(', '), tenantId, shape === 'one'))
          .then(r => r as ReadAnswer, (e: any) => ({ data: null, error: e ?? { message: 'tenant settings read failed' }, status: 0 }))
      }
      if (res.error) return { data: null, error: res.error, status: res.status }
      const row = res.data ?? null
      return shape === 'one'
        ? { data: row ? pick(row, columns) : null, error: null, status: res.status }
        : { data: row ? [pick(row, columns)] : [], error: null, status: res.status }
    })
  }
}
