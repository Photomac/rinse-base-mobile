// The company settings a clean's screen reads, from one request
// (lib/tenantColumnsCore: why, and how each read still answers as before).
import { supabase } from './supabase'
import { createTenantColumns } from './tenantColumnsCore'

export const tenantColumns = createTenantColumns((columns, tenantId, single) => {
  const q = supabase.from('tenants').select(columns).eq('id', tenantId)
  return single ? q.maybeSingle() : q
})
