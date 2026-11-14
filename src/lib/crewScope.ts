// What a crew member's phone asks the server for: their own cleans, not the
// company's (crew read scope, stage 1; rinse-base-app docs/crew-read-scope-plan.md
// section 5.4).
//
// Home's day, Home's "Needs closing" and Schedule used to read the WHOLE
// company's cleans and keep the viewer's own on the phone. That put every
// property's lockbox code and every client's phone on every crew phone, and
// in its saved copy (AsyncStorage), on every refresh. Crew now send the same
// select with the plain `job_assignments(user_id)` embed made `!inner` and
// filtered to themselves, so the server hands back only the cleans they are
// on. The aliased `crew:` embed is left whole: it is the names on the card.
// The office (owner, admin, manager, dispatcher) keeps the company-wide read
// and Mine / Everyone.
//
// Crew selects also drop the `clients(...)` embed. The client's type, and
// their name and phone only when the company lets crew contact clients
// (tenants.crew_can_contact_client, decision D2), come from the
// crew_job_context(job_ids) RPC instead, attached to each row as `clients` so
// the screens read it where they always have.
//
// Once a company's crew read scope is switched on (stage 3), a clean outside
// yesterday → +30 days comes back with no property. placeLabel() then says
// "Address shows from the day before" for crew (D6).
//
// No imports, so scripts/test-crew-read-scope.mjs runs it as is.

const CLIENT_EMBED = /,\s*clients!jobs_client_id_fkey\([^)]*\)/
const MY_ROW_EMBED = /(^|,\s*)job_assignments\(user_id\)/

/** A jobs select as crew send it: no clients embed, and the plain
 *  job_assignments(user_id) embed made !inner, so onlyMine()'s filter on it
 *  narrows the rows (on a plain embed it would only narrow the embed). */
export function crewJobSelect(select: string): string {
  if (!MY_ROW_EMBED.test(select)) throw new Error('crewJobSelect: no job_assignments(user_id) embed to filter on')
  return select.replace(CLIENT_EMBED, '').replace(MY_ROW_EMBED, (_m, lead: string) => `${lead}job_assignments!inner(user_id)`)
}

/** The office's select as is; crew's through crewJobSelect(). */
export function jobSelectFor(office: boolean, select: string): string {
  return office ? select : crewJobSelect(select)
}

/** The office: the query as is. Crew: only the cleans they are on (needs the
 *  !inner embed crewJobSelect() writes). */
export function onlyMine<Q>(q: Q, office: boolean, userId: string): Q {
  return office ? q : (q as any).eq('job_assignments.user_id', userId)
}

/** One row of crew_job_context(uuid[]) (rinse-base-app 20261113171611). */
export interface JobContextRow {
  job_id: string
  client_type: string | null
  display_name: string | null
  client_name: string | null
  client_phone: string | null
}

type Res = { data: any; error: any; status?: number }
export type ContextRpc = (ids: string[]) => PromiseLike<{ data: JobContextRow[] | null; error: any; status?: number }>

/** Ids per crew_job_context call: well under PostgREST's 1,000-row answer cap. */
export const CONTEXT_CHUNK = 400

/** A context row in the shape the screens read a client embed. */
export function contextClient(c: JobContextRow | undefined): { full_name: string | null; phone: string | null; client_type: string | null } | null {
  return c ? { full_name: c.client_name, phone: c.client_phone, client_type: c.client_type } : null
}

/**
 * Attach crew_job_context's answer to a jobs read as each row's `clients`.
 * `res.data` is a list of rows with `id`, or one row; for one row without an
 * `id` column pass its id as `oneId`.
 *
 * If the context read fails with no network (status 0), the whole read fails
 * that way, so the caller's cache serves its last good copy instead of saving
 * rows with no client type. Any other failure keeps the rows, with no client:
 * Home must not go blank over the client's type.
 */
export async function withJobContext<R extends Res>(res: R, rpc: ContextRpc, oneId?: string): Promise<R> {
  if (!res || res.error || res.data == null) return res
  const rows: any[] = Array.isArray(res.data) ? res.data : [res.data]
  const idOf = (r: any) => (Array.isArray(res.data) ? r?.id : (oneId ?? r?.id))
  const ids = [...new Set(rows.map(idOf).filter(Boolean) as string[])]
  if (!ids.length) return res
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CONTEXT_CHUNK) chunks.push(ids.slice(i, i + CONTEXT_CHUNK))
  const answers = await Promise.all(chunks.map(c => rpc(c)))
  const offline = answers.find(a => a.error && a.status === 0)
  if (offline) return { ...res, data: null, error: offline.error, status: 0 }
  const byId = new Map<string, JobContextRow>()
  for (const a of answers) if (!a.error) for (const c of a.data ?? []) byId.set(c.job_id, c)
  for (const r of rows) if (r && typeof r === 'object') r.clients = contextClient(byId.get(idOf(r)))
  return res
}

/**
 * The name a card shows for a clean's place: the property's nickname, then
 * the client's name for the office or the street for crew. A crew clean the
 * server hands over with no property (crew read scope on, the clean more than
 * 30 days out) shows `dayBefore` ("Address shows from the day before"); the
 * office's never does.
 */
export function placeLabel(job: any, office: boolean, dayBefore: string): string {
  const a = job?.client_addresses
  const name = a?.nickname || (office ? job?.clients?.full_name : a?.street)
  if (name) return name
  return office || a ? '' : dayBefore
}
