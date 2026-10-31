// Test doubles for videoQueue.ts beside the real outbox.ts: the outbox's fake
// network, plus what only videoQueue needs. Swapped in by
// scripts/test-videos-required.mjs at build time.
import { supabase as base, net } from './outbox.mocks'
export { AsyncStorage, net, reported, reportClientError } from './outbox.mocks'

export const video = {
  /** job_videos_on_the_way isn't on this server (the app updated before the migration). */
  noTable: false,
  /** Records for these cleans are refused by the row rules (42501: not on the clean). */
  notOnClean: new Set<string>(),
  /** Records for these cleans are refused for any other reason. */
  broken: new Set<string>(),
  /** Every record request, in order: the ids it carried. */
  requests: [] as string[][],
  /** File uploads started. */
  uploads: [] as string[],
  /** An upload waits here until released. */
  hold: null as null | Promise<void>,
  /** Clip ids whose upload fails the way a dead upload or bad path does. */
  failUploads: new Set<string>(),
  /** Clip ids whose file isn't on the phone. */
  missingFiles: new Set<string>(),
  /** The sign-in token is still good when the signal drops, so the upload itself gets tried. */
  tokenOffline: false,
}

export const FileSystem = {
  documentDirectory: 'file:///doc/',
  async getInfoAsync(uri?: string) { return { exists: ![...video.missingFiles].some(id => String(uri).includes(id)), size: 1_000_000 } },
  async makeDirectoryAsync() {},
  async moveAsync() {},
  async copyAsync() {},
  async deleteAsync() {},
}

export const usableAccessToken = async () => (net.online || video.tokenOffline ? 'token' : null)

export const supabase = {
  from: (table: string) => {
    const t: any = base.from(table)
    return {
      ...t,
      insert: (values: any) => t.upsert(values),
      upsert: (values: any, opts?: any) => {
        if (table !== 'job_videos_on_the_way') return t.upsert(values, opts)
        const rows = Array.isArray(values) ? values : [values]
        if (net.online) {
          video.requests.push(rows.map(r => r.id))
          if (video.noTable) return Promise.resolve({ error: { code: 'PGRST205', message: 'no such table' }, status: 404 })
          if (rows.some(r => video.notOnClean.has(r.job_id))) return Promise.resolve({ error: { code: '42501', message: 'row-level security' }, status: 403 })
          if (rows.some(r => video.broken.has(r.job_id))) return Promise.resolve({ error: { code: '23514', message: 'check violated' }, status: 400 })
        }
        return t.upsert(values, opts)
      },
    }
  },
  storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://x/${p}` } }) }) },
}
