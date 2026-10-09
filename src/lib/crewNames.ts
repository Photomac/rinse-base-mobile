// Who is scheduled on a job, as one short line under it on a list (Today,
// Schedule). The job screen already lists "Crew on this job"; the lists showed
// nobody, so an owner scanning the day could not see who was on what, and a
// cleaner could not see who they were paired with without opening each clean
// (Celebrity Clean and CKS Perfections, 2026-10-09).
//
// The rows come from a separately aliased embed on the list query —
// crew:job_assignments!job_assignments_job_id_fkey(user_id, is_lead,
//   users!job_assignments_user_id_fkey(full_name))
// — so a "my jobs only" filter on the plain job_assignments embed never trims
// the crew down to the viewer. The users hint is required: job_assignments has
// two FKs to users (user_id, override_by_user_id), and an unhinted embed fails
// with PGRST201.

export interface CrewAssignment {
  user_id: string
  is_lead?: boolean | null
  users?: { full_name?: string | null } | null
}

export interface CrewName {
  id: string
  label: string
  isLead: boolean
  isMe: boolean
}

/** "Abigail Stewart" → "Abigail S." — short enough for a card, and two crew
 *  who share a first name (or, at Celebrity, a last name) still read apart. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

/** The crew on one job: the lead first, then the viewer (as "You"), then by name.
 *  A teammate whose name can't be read is left out rather than shown blank. */
export function crewNames(rows: CrewAssignment[] | null | undefined, viewerId: string, youLabel: string): CrewName[] {
  const seen = new Set<string>()
  const out: CrewName[] = []
  for (const r of rows ?? []) {
    if (!r?.user_id || seen.has(r.user_id)) continue
    seen.add(r.user_id)
    const isMe = r.user_id === viewerId
    const name = String(r.users?.full_name ?? '').trim()
    if (!isMe && !name) continue
    out.push({ id: r.user_id, label: isMe ? youLabel : shortName(name), isLead: !!r.is_lead, isMe })
  }
  return out.sort((a, b) =>
    (Number(b.isLead) - Number(a.isLead)) || (Number(b.isMe) - Number(a.isMe)) || a.label.localeCompare(b.label))
}

/** "Tasia C. (lead) · You · Marin L." — past `max` names, the rest collapse to "+N". */
export function crewLineText(names: CrewName[], leadTag: string, max = 4): string {
  const shown = names.length > max ? names.slice(0, max - 1) : names
  const parts = shown.map(n => (n.isLead ? `${n.label} (${leadTag})` : n.label))
  const rest = names.length - shown.length
  if (rest > 0) parts.push(`+${rest}`)
  return parts.join(' · ')
}
