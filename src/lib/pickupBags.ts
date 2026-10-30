// A laundry pickup's bag list. See components/PickupBagsCard.
import { supabase } from './supabase'

export interface PickupBag {
  clean_job_id: string
  job_number: number | null
  property: string
  scheduled_start: string
  bag_label: string | null
  pack_ready: boolean | null
}

/**
 * A laundry run, or a job whose service or property is named for a pickup
 * ("LAUNDRY PICKUP", "OFFICE LAUNDRY P/UP"). The same pattern as pickup_bag_list
 * on the server, which has the last word; this only saves a call on every job
 * that plainly isn't one. The web app's lib/linenPack carries it too.
 */
const PICKUP_NAME = /laundry[\s-]*(pick[\s-]*up|p\/?up?\b)/i
export const isLaundryPickup = (jobType?: string | null, serviceName?: string | null, propertyName?: string | null) =>
  jobType === 'laundry_run' || PICKUP_NAME.test(serviceName ?? '') || PICKUP_NAME.test(propertyName ?? '')

/** The day's bags, or [] (not a pickup, no signal, or not applied yet). */
export async function loadPickupBags(jobId: string): Promise<PickupBag[]> {
  try {
    const { data, error } = await supabase.rpc('pickup_bag_list', { p_job_id: jobId })
    if (error) { console.warn('pickup_bag_list:', error.message); return [] }
    return (data ?? []) as PickupBag[]
  } catch {
    return []
  }
}
