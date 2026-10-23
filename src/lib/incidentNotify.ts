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
//
// The same goes for an answer to a send-back (the office sent a report back
// with a note, 2026-10-23): "Send it back" queues the new photos and the
// answer, and the answer (answer_incident_send_back, which emails the office)
// waits until every one of that report's photos has attached. Sent first, it
// would close the send-back and the photos would then be refused.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from './supabase'
import { pendingIncidentPhotos, photosAheadOfAnswer } from './photoQueue'

const KEY = 'incidentNotifyPending.v1'
const ANSWERS_KEY = 'incidentSendBackAnswers.v1'
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

export interface PendingSendBackAnswer {
  report_id: string
  note: string | null
  created_at: number
}

async function readAnswers(): Promise<PendingSendBackAnswer[]> {
  try { const raw = await AsyncStorage.getItem(ANSWERS_KEY); return raw ? JSON.parse(raw) : [] } catch { return [] }
}
async function writeAnswers(list: PendingSendBackAnswer[]): Promise<void> {
  try { await AsyncStorage.setItem(ANSWERS_KEY, JSON.stringify(list)) } catch { /* best effort */ }
}

/** Queue the answer to a send-back; sent once the report's photos are on it. */
export async function queueSendBackAnswer(a: Omit<PendingSendBackAnswer, 'created_at'>): Promise<void> {
  const list = (await readAnswers()).filter(x => x.report_id !== a.report_id)
  list.push({ ...a, created_at: Date.now() })
  await writeAnswers(list)
}

/** Reports whose answer is still waiting on this phone (the card hides them). */
export async function pendingSendBackAnswerIds(): Promise<Set<string>> {
  return new Set((await readAnswers()).map(a => a.report_id))
}

async function flushSendBackAnswers(): Promise<void> {
  const list = await readAnswers()
  if (!list.length) return
  const keep: PendingSendBackAnswer[] = []
  for (const a of list) {
    if (Date.now() - a.created_at > MAX_AGE_MS) continue
    // Its photos first; one the server keeps refusing gives way (photosAheadOfAnswer).
    if (await photosAheadOfAnswer(a.report_id) > 0) { keep.push(a); continue }
    try {
      const { error } = await supabase.rpc('answer_incident_send_back', { p_report_id: a.report_id, p_note: a.note })
      // Answered, or nothing waiting any more (a replay): done. Refused as
      // someone else's (42501): done, there is nothing this phone can do. Any
      // other error, or no signal: try again on the next drain.
      if (error && (error as any).code !== '42501') keep.push(a)
    } catch {
      keep.push(a)
    }
  }
  const seen = new Set(list.map(x => `${x.report_id}@${x.created_at}`))
  const added = (await readAnswers()).filter(x => !seen.has(`${x.report_id}@${x.created_at}`))
  await writeAnswers([...keep.filter(k => !added.some(x => x.report_id === k.report_id)), ...added])
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
        // could double-send); only an unreachable server is. functions-js
        // reports "unreachable" as FunctionsFetchError, whose message ("Failed
        // to send a request to the Edge Function") never matched the old
        // /fetch|network/ test — so a dropped connection dropped the heads-up.
        // A request that timed out may have been delivered: not retried.
        const cause = String((fnError as any)?.context?.message ?? '')
        const unreachable = (fnError as any)?.name === 'FunctionsFetchError' && !/timed out/i.test(cause)
        if (fnError && (unreachable || /fetch|network/i.test(String((fnError as any)?.message)))) keep.push(n)
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
    // Answers to send-backs, after the heads-ups (each waits for its photos).
    try { await flushSendBackAnswers() } catch { /* next drain */ }
    running = false
  }
}
