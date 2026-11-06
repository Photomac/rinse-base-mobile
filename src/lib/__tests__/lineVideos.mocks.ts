// Test doubles for videoQueue.ts with line clips (lib/lineVideos): the video
// queue's doubles (videosRequired.mocks), plus a server that no longer has
// some checklist lines. Swapped in by scripts/test-line-videos.mjs at build time.
import { supabase as videoSupabase, net } from './videosRequired.mocks'
export { AsyncStorage, net, reported, reportClientError, video, FileSystem, usableAccessToken } from './videosRequired.mocks'

export const lines = {
  /** Line ids the server no longer has (deleted while a clip waited): a row naming one is refused with 23503. */
  gone: new Set<string>(),
  /** Every refusal sent back, in order: [table, line id]. */
  refused: [] as [string, string][],
}

const goneLine = (values: any): string | null => {
  for (const r of Array.isArray(values) ? values : [values]) if (r?.checklist_item_id && lines.gone.has(r.checklist_item_id)) return r.checklist_item_id
  return null
}

export const supabase = {
  ...videoSupabase,
  from: (table: string) => {
    const t: any = videoSupabase.from(table)
    if (table === 'job_videos') {
      return {
        ...t,
        insert: (values: any) => {
          const id = net.online ? goneLine(values) : null
          if (!id) return t.insert(values)
          lines.refused.push([table, id])
          return Promise.resolve({ error: { code: '23503', message: 'A clip for a checklist line must name a line of its own clean' }, status: 409 })
        },
      }
    }
    if (table === 'job_videos_on_the_way') {
      return {
        ...t,
        upsert: (values: any, opts?: any) => {
          const id = net.online ? goneLine(values) : null
          if (!id) return t.upsert(values, opts)
          lines.refused.push([table, id])
          return Promise.resolve({ error: { code: '23503', message: 'insert or update on table "job_videos_on_the_way" violates foreign key constraint' }, status: 409 })
        },
      }
    }
    return t
  },
}
