// src/lib/incidentNotify.ts
// Deferred "incident reported" email to the cleaning company.
//
// An incident report can now be saved with no signal: the report waits in the
// write outbox and its photos in the photo queue (both 2026-09-23). The owner's
// heads-up (notify-damage-report, recipients:'owner') must go out only once the
// report exists on the server AND its photos are attached — the email carries
// the first photo, and a heads-up for a report the owner can't open yet is
// worse than a late one. Pending sends live here, on-device, and are retried by
// the same drain that flushes the photo queue and the outbox.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { pendingIncidentPhotos } from './photoQueue'

const KEY = 'incidentNotifyPending.v1'
// A report that never lands (rejected out of the outbox) must not keep a send
// pending forever.
const MAX_AGE_MS = 7 * 86_400_000

export interface PendingIncidentNotify {
  report_id: string
  job_id: string
  tenant_id: string
  report_type: string
  severity: string
  title: string
  room: string | null
  created_at: number
}

async function read(): Promise<PendingIncidentNotify[]> {
  try { const raw = await AsyncStorage.getItem(KEY); return raw ? JSON.parse(raw) : [] } catch { return [] }
}
async function write(list: PendingIncidentNotify[]): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(list)) } catch { /* best effort */ }
}

export async function queueIncidentNotify(n: Omit<PendingIncidentNotify, 'created_at'>): Promise<void> {
  const list = await read()
  if (!list.some(x => x.report_id === n.report_id)) list.push({ ...n, created_at: Date.now() })
  await write(list)
}

let running = false

/** Send every pending heads-up whose report has landed with all its photos. */
export async function flushIncidentNotifies(): Promise<void> {
  if (running) return
  running = true
  try {
    const list = await read()
    if (!list.length) return
    const keep: PendingIncidentNotify[] = []
    for (const n of list) {
      if (Date.now() - n.created_at > MAX_AGE_MS) continue
      if (await pendingIncidentPhotos(n.report_id) > 0) { keep.push(n); continue }
      const { data: report, error } = await supabase.from('job_damage_reports')
        .select('id, photo_urls').eq('id', n.report_id).maybeSingle()
      if (error || !report) { keep.push(n); continue }   // offline, or still in the outbox
      try {
        const { error: fnError } = await supabase.functions.invoke('notify-damage-report', {
          body: {
            job_id: n.job_id, tenant_id: n.tenant_id, report_type: n.report_type, severity: n.severity,
            title: n.title, room: n.room, photo_url: (report as any).photo_urls?.[0] || null, recipients: 'owner',
          },
        })
        // Best-effort, as it always was: a function error is not retried (it
        // could double-send); only an unreachable server is.
        if (fnError && /fetch|network/i.test(String((fnError as any)?.message))) keep.push(n)
      } catch {
        keep.push(n)
      }
    }
    // A report saved while this pass ran was appended to storage after the
    // read above; keep it rather than overwrite it away.
    const seen = new Set(list.map(x => x.report_id))
    const added = (await read()).filter(x => !seen.has(x.report_id))
    await write([...keep, ...added])
  } finally {
    running = false
  }
}
