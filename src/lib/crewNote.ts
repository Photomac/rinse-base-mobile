// The office's note to the crew for one clean (jobs.crew_note), shown at
// clock-in when the office turns on jobs.crew_note_at_clock_in, and the crew's
// "Got it" (job_crew_note_acks). Server half: rinse-base-app migration
// 20261008114826; the web app applies the same rules in src/lib/crewNote.ts.
//
// Unlike internal_notes ("Job notes"), no calendar sync writes crew_note.
// An acknowledgment carries the wording it was given for: when the office
// edits the note, the crew are asked again.
//
// "Got it" must hold offline (a dead zone at the door is exactly when people
// clock in). This device remembers it at once, so the window doesn't come back,
// and the row is sent straight away or, with no signal, parked in its OWN retry
// list and sent on the next screen load. Deliberately NOT the write outbox:
// that queue is strict FIFO and carries pay (clock-in/out), so a refused
// acknowledgment at its head would hold back time entries for five flushes.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'

export interface CrewNoteJob {
  crew_note?: string | null
  crew_note_at_clock_in?: boolean | null
}

/** The note as the crew see it (trimmed), or null when there is none. */
export function crewNoteText(job: CrewNoteJob | null | undefined): string | null {
  const t = String(job?.crew_note ?? '').trim()
  return t ? t : null
}

/** The note a person must dismiss when they clock in, or null when the clean asks for none. */
export function clockInNote(job: CrewNoteJob | null | undefined): string | null {
  return job?.crew_note_at_clock_in ? crewNoteText(job) : null
}

/** The "Got it" row. Sent as INSERT … ON CONFLICT (ACK_CONFLICT) DO NOTHING:
 *  insert-only table, and a resend of the same wording is a no-op. */
export function ackRow(o: { tenantId: string; jobId: string; userId: string; note: string; at?: Date }) {
  return {
    tenant_id: o.tenantId,
    job_id: o.jobId,
    user_id: o.userId,
    note: o.note,
    acknowledged_at: (o.at ?? new Date()).toISOString(),
  }
}

export const ACK_CONFLICT = 'job_id,user_id,note_md5'

// Under dataCache's prefix so sign-out clears it with the other cached reads
// (a note can carry a door code).
const LOCAL = 'dataCache:crewNoteAck:'

/** Wordings this person confirmed on this device (whether or not the row has synced yet). */
export async function localAcks(jobId: string, userId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(`${LOCAL}${jobId}:${userId}`)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x: unknown) => typeof x === 'string') : []
  } catch { return [] }
}

export async function rememberAck(jobId: string, userId: string, note: string): Promise<void> {
  try {
    const list = await localAcks(jobId, userId)
    if (!list.includes(note)) list.push(note)
    await AsyncStorage.setItem(`${LOCAL}${jobId}:${userId}`, JSON.stringify(list.slice(-10)))
  } catch { /* best effort: the server row still records it */ }
}

type AckRow = ReturnType<typeof ackRow>
const PENDING = 'dataCache:crewNoteAckPending'

async function readPending(): Promise<AckRow[]> {
  try { const raw = await AsyncStorage.getItem(PENDING); const l = raw ? JSON.parse(raw) : []; return Array.isArray(l) ? l : [] }
  catch { return [] }
}

async function sendAck(row: AckRow): Promise<'sent' | 'offline' | 'refused'> {
  const res: any = await supabase.from('job_crew_note_acks').upsert(row, { onConflict: ACK_CONFLICT, ignoreDuplicates: true })
  if (!res.error) return 'sent'
  // postgrest-js reports a fetch that never reached the server as status 0.
  if (res.status === 0) return 'offline'
  console.warn('crew note acknowledgment refused:', res.error?.message)
  return 'refused'
}

/** "Got it": remembered on this device now; sent now, or parked until there is signal. */
export async function recordAck(row: AckRow): Promise<void> {
  await rememberAck(row.job_id, row.user_id, row.note)
  if (await sendAck(row) !== 'offline') return
  try {
    const list = await readPending()
    list.push(row)
    await AsyncStorage.setItem(PENDING, JSON.stringify(list.slice(-50)))
  } catch { /* best effort */ }
}

/** Send acknowledgments parked offline. Refused ones are dropped (logged), not retried forever. */
export async function flushAcks(): Promise<void> {
  const list = await readPending()
  if (list.length === 0) return
  const keep: AckRow[] = []
  for (const row of list) if (await sendAck(row) === 'offline') keep.push(row)
  try { await AsyncStorage.setItem(PENDING, JSON.stringify(keep)) } catch { /* best effort */ }
}
