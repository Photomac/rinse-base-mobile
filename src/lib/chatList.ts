// The Direct message tab of Chat: conversations first, newest on top, then
// everyone the viewer has not talked to yet.
//
// True Shine Cleaning (2026-10-29): the tab listed every teammate A–Z and hung
// each one's DM off their row, so a chat with a new message stayed wherever
// the alphabet put it and was easy to miss. Group chats were not listed at
// all: once created, a group could only be reached from the create button.
//
// iClean (2026-11-18, Maria: "how to create groups, I already did but it's
// not showing up"): a group nobody had written in yet was left off too, so
// the three groups she made on the web for her crew never showed on a phone.
// A DM with no message still has its person row below; a group has no other
// row, so it is listed from the moment it exists: after the chats with
// messages, A–Z by name.
//
// Pure (no React, no imports) so scripts/test-chat-list.mjs runs it as is.

export type DMListRow =
  | { type: 'dm'; id: string; channel: any; person: any }
  | { type: 'group'; id: string; channel: any }
  | { type: 'label'; id: string }
  | { type: 'person'; id: string; person: any }

const at = (c: any) => (c?.last_message_at ? Date.parse(c.last_message_at) : 0)

/** channels: the tenant's message_channels. crew: the viewer's active
 *  teammates, A–Z by full_name as loaded (kept in that order).
 *  A DM shows only when the other person is on that list, as before. A DM
 *  with no message yet (last_message_at null) is not a conversation: the
 *  person stays in the bottom section, and openDM finds that channel. A group
 *  the viewer is in always shows: with no message yet, after the chats that
 *  have one, A–Z by name. */
export function dmListRows(channels: any[], crew: any[], myId: string): DMListRow[] {
  const byId = new Map(crew.map(p => [p.id, p]))
  // Stable sort, so equal times keep the load order openDM searches in.
  const mine = channels
    .filter(c => (c.channel_type === 'dm' || c.channel_type === 'group') && c.participant_ids?.includes(myId))
    .sort((a, b) => at(b) - at(a))

  const top: DMListRow[] = []
  const quietGroups: any[] = []
  const talked = new Set<string>()
  for (const c of mine) {
    if (c.channel_type === 'group') {
      if (c.last_message_at) top.push({ type: 'group', id: `c-${c.id}`, channel: c })
      else quietGroups.push(c)
      continue
    }
    if (!c.last_message_at) continue
    const otherId = c.participant_ids.find((id: string) => id !== myId)
    const person = byId.get(otherId)
    // A pair can have two DMs; the newest is the one openDM opens.
    if (!person || talked.has(otherId)) continue
    talked.add(otherId)
    top.push({ type: 'dm', id: `c-${c.id}`, channel: c, person })
  }

  quietGroups
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
    .forEach(c => top.push({ type: 'group', id: `c-${c.id}`, channel: c }))

  const rest: DMListRow[] = crew.filter(p => !talked.has(p.id)).map(p => ({ type: 'person', id: `p-${p.id}`, person: p }))
  return top.length && rest.length ? [...top, { type: 'label', id: 'label' }, ...rest] : [...top, ...rest]
}
