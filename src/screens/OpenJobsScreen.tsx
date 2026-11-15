// Open jobs — the crew job board.
//
// Cleans the company opened to every crew member; the first person to claim
// one is on it, up to the clean's crew size (jobs.max_crew). Companies staffed
// with 1099 contractors asked for exactly this: cleaners pick their own work
// instead of being assigned.
//
// READS: the open_board_jobs() RPC (crew read scope stage 1), shared with the
// tab's badge through lib/openJobs.ts, so the badge never counts a clean this
// list leaves out. It hands each card what it shows and nothing else: the
// place's nickname or street, its city and clock, the time, the service and
// the spots. No client, no door code, no notes, for cleans nobody has
// claimed. A clean this person opens is read in full by its id once it is
// theirs (scheduleJobById), the way a push tap opens one.
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
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { scheduleJobById } from '../lib/jobReads'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor } from '../lib/i18n'
import { SLATE_DARK, GOLD, SLATE } from '../lib/theme'
import { cachedQuery, pruneDataCache } from '../lib/dataCache'
import { fmtTimeAt, fmtDate, fmtDatePart, dayClocksOf } from '../lib/timezone'
import { boardRows, boardJobsFor, claimedByMe, offeredFirstTo, type BoardRow } from '../lib/openJobs'
import { isCalendarMade } from '../lib/calendarMade'

const RESULT_KEY: Record<string, string> = {
  full: 'open_jobs_r_full',
  not_open: 'open_jobs_r_not_open',
  status_not_eligible: 'open_jobs_r_not_open',
  job_not_found: 'open_jobs_r_not_open',
  already_on_job: 'open_jobs_r_already',
  time_off: 'open_jobs_r_time_off',
  off_that_day: 'open_jobs_r_off_day',
  double_booked: 'open_jobs_r_double',
  first_tier_only: 'open_jobs_r_first_tier',
  inspects_this_clean: 'open_jobs_r_inspects',
}

export function OpenJobsScreen({ user, onJobPress }: { user: any; onJobPress: (job: any) => void }) {
  const { t, lang } = useLang()
  const [jobs, setJobs] = useState<BoardRow[]>([])
  const [mine, setMine] = useState<BoardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  // A day on this board that crosses a zone line names every clean's zone.
  const boardDays = useMemo(() => dayClocksOf([...jobs, ...mine]), [jobs, mine])

  const load = useCallback(async () => {
    const now = new Date()
    // Saved per person: the RPC's answer is this person's (their first picks,
    // their claims). GET: the function is STABLE, so it is a read.
    const res = await cachedQuery(`openjobs2:${user.id}`, supabase.rpc('open_board_jobs', {}, { get: true }))
    setOffline(res.fromCache)
    const rows = boardRows(res.data)
    setJobs(boardJobsFor(rows, now.getTime()))
    // Board cleans this person claimed. A full one drops out of the open list,
    // so it needs its own row here — that is where "give back" lives.
    setMine(claimedByMe(rows))
    setLoading(false)
    setRefreshing(false)
  }, [user.id])

  useEffect(() => { load() }, [load])

  // The copy older versions saved (openjobs:<company>) held each open
  // clean's lockbox code and client phone: dropped once, unread.
  useEffect(() => { pruneDataCache(k => k.startsWith('openjobs:')).catch(() => {}) }, [])

  // A board card holds what the card shows, not what the job's screen needs:
  // the screen opens the clean as Schedule would hand it (lib/jobReads), now
  // that it is this person's.
  const [opening, setOpening] = useState<string | null>(null)
  async function openClean(job: BoardRow) {
    if (opening) return
    setOpening(job.id)
    const { data, error } = await scheduleJobById(user, job.id)
    setOpening(null)
    if (error || !data) { Alert.alert(t('open_jobs_open_failed')); return }
    onJobPress(data)
  }

  function claim(job: BoardRow) {
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
            { text: t('open_jobs_view'), onPress: () => openClean(job) },
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
  function release(job: BoardRow) {
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
            {mine.map((job) => {
              const addr = job.client_addresses
              return (
                <View key={job.id} style={styles.mineRow}>
                  <TouchableOpacity style={{ flex: 1 }} disabled={opening === job.id} onPress={() => openClean(job)}>
                    <Text style={styles.mineTitle} numberOfLines={1}>
                      {addr?.nickname || addr?.street}
                      {job.job_number ? <Text style={{ fontWeight: '400', opacity: 0.55 }}>  #{job.job_number}</Text> : null}{isCalendarMade(job) ? <Text>  📅</Text> : null}
                    </Text>
                    <Text style={styles.jobMeta}>{fmtDate(job.scheduled_start, localeFor(lang), { weekday: 'short', month: 'short', day: 'numeric' })} · {fmtTimeAt(job.scheduled_start, job.client_addresses, localeFor(lang), boardDays)}</Text>
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
        ) : jobs.map((job) => {
          const addr = job.client_addresses
          const taken = job.spots_taken
          const cap = Math.max(Number(job.max_crew ?? 1), 1)
          const mine = !!job.claimed_by_me_at
          const hrs = Math.round((new Date(job.scheduled_end ?? job.scheduled_start).getTime() - new Date(job.scheduled_start).getTime()) / 360000) / 10
          // A task's card names its service, never its notes: they can hold a code.
          const label = job.job_type === 'laundry_run' ? `🧺 ${t('laundry_run')}`
            : job.job_type === 'task' ? `📌 ${job.service_types?.name || t('task')}`
            : (addr?.nickname || addr?.street)
          return (
            <View key={job.id} style={styles.card}>
              <View style={styles.cardTop}>
                <View style={styles.dateBox}>
                  <Text style={styles.dateDow}>{fmtDatePart(job.scheduled_start, 'weekday', localeFor(lang))}</Text>
                  <Text style={styles.dateDay}>{fmtDatePart(job.scheduled_start, 'day', localeFor(lang))}</Text>
                  <Text style={styles.dateMon}>{fmtDatePart(job.scheduled_start, 'month', localeFor(lang))}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.jobTitle} numberOfLines={2}>
                    {label}
                    {job.job_number ? <Text style={{ fontWeight: '400', opacity: 0.55 }}>  #{job.job_number}</Text> : null}{isCalendarMade(job) ? <Text>  📅</Text> : null}
                  </Text>
                  <Text style={styles.jobMeta}>
                    {fmtTimeAt(job.scheduled_start, job.client_addresses, localeFor(lang), boardDays)} · {ti(t('open_jobs_hours'), { h: String(hrs) })}
                    {addr?.city ? ` · ${addr.city}` : ''}
                  </Text>
                  <View style={styles.badges}>
                    {job.is_turnover ? <Text style={[styles.badge, styles.badgeTurnover]}>🏠 {t('turnover')}</Text> : null}
                    {job.service_types?.name ? <Text style={[styles.badge, styles.badgeService]}>{job.service_types.name}</Text> : null}
                    <Text style={[styles.badge, styles.badgeSpots]}>{ti(t('open_jobs_spots'), { taken: String(taken), cap: String(cap) })}</Text>
                    {offeredFirstTo(job) === 'me' ? <Text style={[styles.badge, styles.badgeFirst]}>⭐ {t('open_jobs_first_tag')}</Text> : null}
                  </View>
                </View>
              </View>
              {mine ? (
                <TouchableOpacity style={styles.mineBtn} disabled={opening === job.id} onPress={() => openClean(job)}>
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
  badgeFirst: { backgroundColor: '#DCFCE7', color: '#15803D' },
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
