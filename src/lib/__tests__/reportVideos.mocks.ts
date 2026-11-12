// Test doubles for videoQueue.ts with incident report clips: the video queue's
// doubles (videosRequired.mocks), plus a server that holds some reports and not
// others yet (a report still in the phone's outbox), refuses some rows (the row
// rules: past the filer's 24 hours), and can lose an answer. Swapped in by
// scripts/test-report-videos.mjs at build time.
import { supabase as videoSupabase, net } from './videosRequired.mocks'
export { AsyncStorage, net, reported, reportClientError, video, FileSystem, usableAccessToken } from './videosRequired.mocks'

export const reports = {
  /** Report ids on the server: a row naming any other is refused with 23503. */
  landed: new Set<string>(),
  /** Report ids whose rows the row rules refuse (42501). */
  refused: new Set<string>(),
  /** Row ids stored. */
  stored: new Set<string>(),
  /** The next insert lands but its answer is lost (no signal). */
  loseNext: false,
  /** Every incident_report_videos insert that reached the server, kept or refused. */
  inserts: [] as any[],
}

export const supabase = {
  ...videoSupabase,
  from: (table: string) => {
    const t: any = videoSupabase.from(table)
    if (table !== 'incident_report_videos') return t
    return {
      ...t,
      insert: (row: any) => {
        if (!net.online) return Promise.resolve({ error: { message: 'TypeError: fetch failed' }, status: 0 })
        reports.inserts.push(row)
        if (reports.stored.has(row.id)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "incident_report_videos_pkey"' }, status: 409 })
        if (!reports.landed.has(row.report_id)) return Promise.resolve({ error: { code: '23503', message: 'insert or update on table "incident_report_videos" violates foreign key constraint "incident_report_videos_report_fkey"' }, status: 409 })
        if (reports.refused.has(row.report_id)) return Promise.resolve({ error: { code: '42501', message: 'new row violates row-level security policy for table "incident_report_videos"' }, status: 403 })
        reports.stored.add(row.id)
        net.applied.push({ table, op: 'insert', values: row, filters: [] })
        if (reports.loseNext) { reports.loseNext = false; return Promise.resolve({ error: { message: 'TypeError: Network request failed' }, status: 0 }) }
        return Promise.resolve({ error: null, status: 201 })
      },
    }
  },
}
