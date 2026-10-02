// Open jobs — the crew job board.
//
// Cleans the company opened to every crew member; the first person to claim
// one is on it, up to the clean's crew size (jobs.max_crew). Companies staffed
// with 1099 contractors asked for exactly this: cleaners pick their own work
// instead of being assigned.
//
// READS: crew already download every job in the company for Schedule and
// Home and filter to their own client-side, so this is the same read with a
// different filter (open_for_claims_at set, still pending/scheduled, in the
// future, not yet full).
//
// WRITES: only through the claim_open_job RPC. Crew have no INSERT on
// job_assignments and never will; the RPC row-locks the job so two people
// tapping at the same second cannot both win. It answers with a short code
// ('claimed', 'full', 'double_booked', …) rather than an error, translated in
// RESULT_KEY below. Refusals mirror the auto-assigner's rules: approved time
// off, weekly availability, overlapping job.
//
// NEVER offline: a claim needs a live yes from the server, so the button is
// disabled while the list is rendering from cache, and nothing is queued in
// the outbox. Showing the cached list is still useful (what was open when I
// last had signal), just not actionable.
import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor } from '../lib/i18n'
import { SLATE_DARK, GOLD, SLATE } from '../lib/theme'
import { cachedQuery } from '../lib/dataCache'
import { fmtTime, fmtDate } from '../lib/timezone'

const HORIZON_DAYS = 60

const RESULT_KEY: Record<string, string> = {
  full: 'open_jobs_r_full',
  not_open: 'open_jobs_r_not_open',
  status_not_eligible: 'open_jobs_r_not_open',
  job_not_found: 'open_jobs_r_not_open',
  already_on_job: 'open_jobs_r_already',
  time_off: 'open_jobs_r_time_off',
  off_that_day: 'open_jobs_r_off_day',
  double_booked: 'open_jobs_r_double',
}

export function isOpenJob(j: any, now = Date.now()): boolean {
  return !!j.open_for_claims_at
    && ['pending_approval', 'scheduled'].includes(j.status)
    && new Date(j.scheduled_start).getTime() > now
    && (j.job_assignments?.length ?? 0) < Math.max(Number(j.max_crew ?? 1), 1)
}

export function OpenJobsScreen({ user, onJobPress }: { user: any; onJobPress: (job: any) => void }) {
  const { t, lang } = useLang()
  const [jobs, setJobs] = useState<any[]>([])
  const [mine, setMine] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  // Crew see the property, not the homeowner — client names are for admins.
  const canSeeClientNames = ['owner', 'manager', 'dispatcher'].includes(user.role)

  const load = useCallback(async () => {
    const now = new Date()
    const res = await cachedQuery(`openjobs:${user.tenant_id}`, supabase
      .from('jobs')
      .select('id, job_number, tenant_id, status, scheduled_start, scheduled_end, is_turnover, route_order, window_minutes, job_type, internal_notes, max_crew, open_for_claims_at, clients!jobs_client_id_fkey(full_name, phone, client_type), client_addresses!jobs_address_id_fkey(id, street, city, nickname, lockbox_code, lat, lng, photo_url), service_types(name), job_assignments(user_id, claimed_at)')
      .eq('tenant_id', user.tenant_id)
      .not('open_for_claims_at', 'is', null)
      .in('status', ['pending_approval', 'scheduled'])
      .gt('scheduled_start', now.toISOString())
      .lte('scheduled_start', new Date(now.getTime() + HORIZON_DAYS * 86_400_000).toISOString())
      .order('scheduled_start')
      .limit(200))
    setOffline(res.fromCache)
    const rows = res.data ?? []
    setJobs(rows.filter((j: any) => isOpenJob(j, now.getTime())))
    // Board cleans this person claimed. A full one drops out of the open list,
    // so it needs its own row here — that is where "give back" lives.
    setMine(rows.filter((j: any) => (j.job_assignments ?? []).some((a: any) => a.user_id === user.id && a.claimed_at)))
    setLoading(false)
    setRefreshing(false)
  }, [user.tenant_id, user.id])

  useEffect(() => { load() }, [load])

  function claim(job: any) {
    if (offline || busy) return
    Alert.alert(t('open_jobs_claim'), t('open_jobs_confirm'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('open_jobs_claim'), onPress: async () => {
        setBusy(job.id)
        const { data, error } = await supabase.rpc('claim_open_job', { p_job_id: job.id })
        setBusy(null)
        const code = error ? 'error' : String(data)
        if (code === 'claimed') {
          await load()
          Alert.alert('✅ ' + t('open_jobs_claimed_title'), t('open_jobs_claimed'), [
            { text: t('open_jobs_view'), onPress: () => onJobPress(job) },
            { text: t('done') },
          ])
          return
        }
        await load()
        Alert.alert(t('open_jobs_not_claimed'), t((RESULT_KEY[code] ?? 'open_jobs_r_other') as any))
      } },
    ])
  }

  // Give a claimed clean back. The server decides whether it is still allowed
  // (tenants.unclaim_notice_hours before the start) and tells the rest of the
  // crew it is open again. Owner-placed assignments cannot be released here.
  function release(job: any) {
    if (offline || busy) return
    Alert.alert(t('open_jobs_release'), t('open_jobs_release_confirm'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('open_jobs_release'), style: 'destructive', onPress: async () => {
        setBusy(job.id)
        const { data, error } = await supabase.rpc('release_claimed_job', { p_job_id: job.id })
        setBusy(null)
        const code = error ? 'error' : String(data)
        await load()
        if (code === 'released') {
          Alert.alert(t('open_jobs_released_title'), t('open_jobs_released'))
          return
        }
        Alert.alert(t('open_jobs_not_released'), t((code === 'too_late' ? 'open_jobs_r_too_late' : code === 'not_claimed' ? 'open_jobs_r_not_claimed' : 'open_jobs_r_other') as any))
      } },
    ])
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>🙋 {t('open_jobs_title')}</Text>
        <Text style={styles.subtitle}>{t('open_jobs_sub')}</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={GOLD} />}
      >
        {offline && (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineBannerText}>📡 {t('open_jobs_offline')}</Text>
          </View>
        )}

        {!loading && mine.length > 0 && (
          <View style={{ marginBottom: 14 }}>
            <Text style={styles.sectionTitle}>✅ {t('open_jobs_yours_title')}</Text>
            {mine.map((job: any) => {
              const addr = job.client_addresses
              return (
                <View key={job.id} style={styles.mineRow}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => onJobPress(job)}>
                    <Text style={styles.mineTitle} numberOfLines={1}>
                      {addr?.nickname || (canSeeClientNames ? (job.clients as any)?.full_name : addr?.street)}
                      {job.job_number ? <Text style={{ fontWeight: '400', opacity: 0.55 }}>  #{job.job_number}</Text> : null}
                    </Text>
                    <Text style={styles.jobMeta}>{fmtDate(job.scheduled_start, localeFor(lang), { weekday: 'short', month: 'short', day: 'numeric' })} · {fmtTime(job.scheduled_start)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.releaseBtn, (offline || busy === job.id) && { opacity: 0.5 }]}
                    disabled={offline || busy === job.id}
                    onPress={() => release(job)}
                  >
                    <Text style={styles.releaseBtnText}>{t('open_jobs_release')}</Text>
                  </TouchableOpacity>
                </View>
              )
            })}
          </View>
        )}

        {!loading && (jobs.length > 0 || mine.length > 0) && (
          <Text style={styles.sectionTitle}>🙋 {t('open_jobs_title')} · {jobs.length}</Text>
        )}

        {loading ? (
          <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
        ) : jobs.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>{t('open_jobs_none_title')}</Text>
            <Text style={styles.emptyText}>{t('open_jobs_none')}</Text>
          </View>
        ) : jobs.map((job: any) => {
          const addr = job.client_addresses
          const taken = job.job_assignments?.length ?? 0
          const cap = Math.max(Number(job.max_crew ?? 1), 1)
          const mine = (job.job_assignments ?? []).some((a: any) => a.user_id === user.id)
          const hrs = Math.round((new Date(job.scheduled_end).getTime() - new Date(job.scheduled_start).getTime()) / 360000) / 10
          const label = job.job_type === 'laundry_run' ? `🧺 ${t('laundry_run')}`
            : job.job_type === 'task' ? `📌 ${(job.internal_notes || t('task')).split('\n')[0]}`
            : (addr?.nickname || (canSeeClientNames ? (job.clients as any)?.full_name : addr?.street))
          return (
            <View key={job.id} style={styles.card}>
              <View style={styles.cardTop}>
                <View style={styles.dateBox}>
                  <Text style={styles.dateDow}>{fmtDate(job.scheduled_start, localeFor(lang), { weekday: 'short' })}</Text>
                  <Text style={styles.dateDay}>{fmtDate(job.scheduled_start, localeFor(lang), { day: 'numeric' })}</Text>
                  <Text style={styles.dateMon}>{fmtDate(job.scheduled_start, localeFor(lang), { month: 'short' })}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.jobTitle} numberOfLines={2}>
                    {label}
                    {job.job_number ? <Text style={{ fontWeight: '400', opacity: 0.55 }}>  #{job.job_number}</Text> : null}
                  </Text>
                  <Text style={styles.jobMeta}>
                    {fmtTime(job.scheduled_start)} · {ti(t('open_jobs_hours'), { h: String(hrs) })}
                    {addr?.city ? ` · ${addr.city}` : ''}
                  </Text>
                  <View style={styles.badges}>
                    {job.is_turnover ? <Text style={[styles.badge, styles.badgeTurnover]}>🏠 {t('turnover')}</Text> : null}
                    {(job.service_types as any)?.name ? <Text style={[styles.badge, styles.badgeService]}>{(job.service_types as any).name}</Text> : null}
                    <Text style={[styles.badge, styles.badgeSpots]}>{ti(t('open_jobs_spots'), { taken: String(taken), cap: String(cap) })}</Text>
                  </View>
                </View>
              </View>
              {mine ? (
                <TouchableOpacity style={styles.mineBtn} onPress={() => onJobPress(job)}>
                  <Text style={styles.mineBtnText}>✅ {t('open_jobs_yours')}</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.claimBtn, (offline || busy === job.id) && { opacity: 0.5 }]}
                  disabled={offline || busy === job.id}
                  onPress={() => claim(job)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.claimBtnText}>{busy === job.id ? t('open_jobs_claiming') : t('open_jobs_claim')}</Text>
                </TouchableOpacity>
              )}
            </View>
          )
        })}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: SLATE_DARK, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 18 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  subtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 2 },
  scroll: { padding: 16, paddingBottom: 40 },
  offlineBanner: { backgroundColor: '#FEF3C7', borderColor: '#FCD34D', borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 12 },
  offlineBannerText: { color: '#92400E', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  emptyCard: { backgroundColor: '#fff', borderRadius: 12, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 6 },
  emptyText: { fontSize: 13, color: '#64748B', textAlign: 'center', lineHeight: 18 },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: '#FCD34D' },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  dateBox: { width: 52, alignItems: 'center', backgroundColor: '#FFFBEB', borderRadius: 10, paddingVertical: 8 },
  dateDow: { fontSize: 10, fontWeight: '700', color: '#92400E', textTransform: 'uppercase' },
  dateDay: { fontSize: 22, fontWeight: '800', color: '#0F172A', lineHeight: 26 },
  dateMon: { fontSize: 10, fontWeight: '600', color: '#92400E', textTransform: 'uppercase' },
  jobTitle: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  jobMeta: { fontSize: 12, color: '#64748B', marginTop: 3 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  badge: { fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  badgeTurnover: { backgroundColor: '#FEE2E2', color: '#991B1B' },
  badgeService: { backgroundColor: '#F1F5F9', color: '#475569' },
  badgeSpots: { backgroundColor: '#DBEAFE', color: '#1E40AF' },
  claimBtn: { marginTop: 12, backgroundColor: GOLD, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  sectionTitle: { fontSize: 12, fontWeight: '800', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
  mineRow: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: '#A7F3D0' },
  mineTitle: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  releaseBtn: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10 },
  releaseBtnText: { color: '#64748B', fontSize: 12, fontWeight: '700' },
  claimBtnText: { color: SLATE, fontSize: 15, fontWeight: '800' },
  mineBtn: { marginTop: 12, backgroundColor: '#ECFDF5', borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#A7F3D0' },
  mineBtnText: { color: '#065F46', fontSize: 14, fontWeight: '700' },
})
