import React, { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { SLATE, SLATE_DARK, GOLD } from '../lib/theme'
import { startLocationTracking, stopLocationTracking } from '../lib/locationTracker'

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function DashboardScreen({ user, onJobPress, onNavigate, onSOS }: { user: any; onJobPress: (job: any) => void; onNavigate: (screen: string) => void; onSOS: () => void }) {
  const { t, lang } = useLang()
  const [todayJobs, setTodayJobs] = useState<any[]>([])
  const [activeJob, setActiveJob] = useState<any>(null)
  const [nextJob, setNextJob] = useState<any>(null)
  const [monthStats, setMonthStats] = useState({ completed: 0, hours: 0, earnings: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const sosTimer = useRef<any>(null)
  const sosInterval = useRef<any>(null)
  // Day-long shift clock-in (only when tenant uses 'daily' time tracking)
  const dailyMode = user._timeMode === 'daily'
  const [activeShift, setActiveShift] = useState<any>(null)
  const [shiftElapsed, setShiftElapsed] = useState('')
  const [shiftBusy, setShiftBusy] = useState(false)

  const load = useCallback(async () => {
    const now = new Date()
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0)
    const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const isOwner = ['owner', 'manager', 'dispatcher'].includes(user.role)

    const [todayRes, monthRes] = await Promise.all([
      supabase.from('jobs')
        .select('id, tenant_id, status, scheduled_start, scheduled_end, is_turnover, clients!jobs_client_id_fkey(full_name, phone), client_addresses!jobs_address_id_fkey(id, street, city, nickname, lockbox_code, lat, lng, photo_url), job_assignments(user_id)')
        .eq('tenant_id', user.tenant_id)
        .gte('scheduled_start', todayStart.toISOString())
        .lte('scheduled_start', todayEnd.toISOString())
        .neq('status', 'cancelled')
        .order('scheduled_start'),
      supabase.from('jobs')
        .select('id, status, scheduled_start, scheduled_end, job_assignments(user_id)')
        .eq('tenant_id', user.tenant_id)
        .eq('status', 'completed')
        .gte('scheduled_start', monthStart.toISOString()),
    ])

    const myToday = isOwner
      ? (todayRes.data ?? [])
      : (todayRes.data ?? []).filter((j: any) => j.job_assignments?.some((a: any) => a.user_id === user.id))

    const myMonth = isOwner
      ? (monthRes.data ?? [])
      : (monthRes.data ?? []).filter((j: any) => j.job_assignments?.some((a: any) => a.user_id === user.id))

    setTodayJobs(myToday)
    setActiveJob(myToday.find((j: any) => j.status === 'in_progress') || null)
    setNextJob(myToday.find((j: any) => j.status === 'scheduled' || j.status === 'en_route') || null)

    const hours = myMonth.reduce((s: number, j: any) => {
      if (!j.scheduled_end) return s
      return s + (new Date(j.scheduled_end).getTime() - new Date(j.scheduled_start).getTime()) / 3600000
    }, 0)
    let earnings = 0
    if (user.pay_type === 'hourly') earnings = hours * Number(user.hourly_rate || 0)
    else if (user.pay_type === 'per_job') earnings = myMonth.length * Number(user.per_job_rate || 0)
    setMonthStats({ completed: myMonth.length, hours: Math.round(hours * 10) / 10, earnings: Math.round(earnings * 100) / 100 })

    // Open shift (daily mode) — a job_time_entries row with no job and no clock-out.
    if (user._timeMode === 'daily') {
      const { data: shift } = await supabase.from('job_time_entries')
        .select('id, clocked_in_at')
        .eq('user_id', user.id).is('job_id', null).eq('entry_type', 'shift').is('clocked_out_at', null)
        .order('clocked_in_at', { ascending: false }).limit(1).maybeSingle()
      setActiveShift(shift || null)
    }

    setLoading(false)
    setRefreshing(false)
  }, [user])

  useEffect(() => { load() }, [load])

  // Live "on shift" timer
  useEffect(() => {
    if (!activeShift) { setShiftElapsed(''); return }
    const tick = () => {
      const secs = Math.max(0, Math.floor((Date.now() - new Date(activeShift.clocked_in_at).getTime()) / 1000))
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60)
      setShiftElapsed(`${h}h ${String(m).padStart(2, '0')}m`)
    }
    tick()
    const id = setInterval(tick, 30000)
    return () => clearInterval(id)
  }, [activeShift])

  async function handleStartDay() {
    setShiftBusy(true)
    const { data, error } = await supabase.from('job_time_entries').insert({
      tenant_id: user.tenant_id, user_id: user.id, job_id: null,
      entry_type: 'shift', clocked_in_at: new Date().toISOString(),
    }).select('id, clocked_in_at').single()
    setShiftBusy(false)
    if (error) { Alert.alert('Error', error.message); return }
    setActiveShift(data)
    // Start broadcasting location for the day so the crew shows live on
    // dispatch. Start-of-day is a user-initiated moment, so escalate to the
    // "Always" location prompt for pocket-tracking through the shift.
    startLocationTracking(user, { requestBackground: true }).catch(() => {})
  }

  async function handleEndDay() {
    if (!activeShift) return
    Alert.alert(t('end_my_day'), t('on_shift_since') + ' ' + fmtTime(activeShift.clocked_in_at), [
      { text: t('cancel') || 'Cancel', style: 'cancel' },
      { text: t('end_my_day'), style: 'destructive', onPress: async () => {
        setShiftBusy(true)
        const out = new Date()
        const mins = Math.round((out.getTime() - new Date(activeShift.clocked_in_at).getTime()) / 60000)
        const { error } = await supabase.from('job_time_entries')
          .update({ clocked_out_at: out.toISOString(), duration_minutes: mins })
          .eq('id', activeShift.id)
        setShiftBusy(false)
        if (error) { Alert.alert('Error', error.message); return }
        setActiveShift(null)
        // Stop broadcasting once the shift ends.
        stopLocationTracking().catch(() => {})
      } },
    ])
  }

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? t('good_morning') : hour < 17 ? t('good_afternoon') : t('good_evening')
  const completedToday = todayJobs.filter(j => j.status === 'completed').length

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={GOLD} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <Text style={styles.greeting}>{greeting}, {user.full_name?.split(' ')[0]} 👋</Text>
              <Text style={styles.date}>{now.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
            </View>
            <TouchableOpacity style={styles.sosBtn} onPress={onSOS} activeOpacity={0.8}>
              <Text style={styles.sosBtnText}>🆘</Text>
              <Text style={styles.sosHoldLabel}>SOS</Text>
            </TouchableOpacity>
          </View>

          {/* Stats bar */}
          <View style={styles.statsBar}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{todayJobs.length}</Text>
              <Text style={styles.statLabel}>{t('today')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>{completedToday}</Text>
              <Text style={styles.statLabel}>{t('done_label')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>{todayJobs.length - completedToday}</Text>
              <Text style={styles.statLabel}>{t('remaining')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>{monthStats.completed}</Text>
              <Text style={styles.statLabel}>{t('this_month')}</Text>
            </View>
          </View>
        </View>

        {/* Day-long shift clock-in (daily mode) */}
        {dailyMode && (
          activeShift ? (
            <View style={styles.shiftCardOn}>
              <View style={{ flex: 1 }}>
                <Text style={styles.shiftOnLabel}>🟢 {t('on_shift_since')} {fmtTime(activeShift.clocked_in_at)}</Text>
                {!!shiftElapsed && <Text style={styles.shiftTimer}>{shiftElapsed}</Text>}
              </View>
              <TouchableOpacity style={styles.endDayBtn} onPress={handleEndDay} disabled={shiftBusy} activeOpacity={0.85}>
                {shiftBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.endDayBtnText}>{t('end_my_day')}</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.startDayBtn} onPress={handleStartDay} disabled={shiftBusy} activeOpacity={0.85}>
              {shiftBusy ? <ActivityIndicator color={SLATE} /> : <Text style={styles.startDayBtnText}>⏱  {t('start_my_day')}</Text>}
            </TouchableOpacity>
          )
        )}

        {loading ? (
          <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Active job banner */}
            {activeJob && (
              <TouchableOpacity style={styles.activeBanner} onPress={() => onJobPress(activeJob)}>
                <View style={styles.activePulse} />
                <View style={styles.activeInfo}>
                  <Text style={styles.activeLabel}>🔶 {t('active_job')}</Text>
                  <Text style={styles.activeClient}>
                    {(activeJob.client_addresses as any)?.nickname || (activeJob.clients as any)?.full_name}
                  </Text>
                  <Text style={styles.activeTime}>{fmtTime(activeJob.scheduled_start)} – {fmtTime(activeJob.scheduled_end)}</Text>
                </View>
                <Text style={styles.activeArrow}>→</Text>
              </TouchableOpacity>
            )}

            {/* Next job */}
            {nextJob && !activeJob && (
              <TouchableOpacity style={styles.nextJobCard} onPress={() => onJobPress(nextJob)}>
                <View style={styles.nextJobHeader}>
                  <Text style={styles.nextJobLabel}>⏰ {t('next_job')}</Text>
                  <Text style={styles.nextJobTime}>{fmtTime(nextJob.scheduled_start)}</Text>
                </View>
                <Text style={styles.nextJobClient}>
                  {(nextJob.client_addresses as any)?.nickname || (nextJob.clients as any)?.full_name}
                </Text>
                <Text style={styles.nextJobAddress}>
                  📍 {(nextJob.client_addresses as any)?.street}, {(nextJob.client_addresses as any)?.city}
                </Text>
                {(nextJob.client_addresses as any)?.lockbox_code && (
                  <Text style={styles.nextJobLockbox}>🔐 {(nextJob.client_addresses as any)?.lockbox_code}</Text>
                )}
              </TouchableOpacity>
            )}

            {/* Quick actions */}
            <View style={styles.quickActions}>
              <TouchableOpacity style={styles.quickBtn} onPress={() => onNavigate('schedule')}>
                <Text style={styles.quickBtnIcon}>📅</Text>
                <Text style={styles.quickBtnLabel}>{t('schedule')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.quickBtn} onPress={() => onNavigate('mileage')}>
                <Text style={styles.quickBtnIcon}>↗</Text>
                <Text style={styles.quickBtnLabel}>{t('log_miles')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.quickBtn} onPress={() => onNavigate('profile')}>
                <Text style={styles.quickBtnIcon}>◉</Text>
                <Text style={styles.quickBtnLabel}>{t('profile')}</Text>
              </TouchableOpacity>
            </View>

            {/* Today's job list preview */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{t('todays_jobs')}</Text>
              </View>
              {todayJobs.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>{t('no_jobs_today')} 🌟</Text>
                </View>
              ) : todayJobs.map((job: any) => {
                const addr = job.client_addresses
                const isDone = job.status === 'completed'
                const isActive = job.status === 'in_progress'
                return (
                  <TouchableOpacity key={job.id} style={[styles.jobRow, isDone && { opacity: 0.5 }]} onPress={() => onJobPress(job)}>
                    <View style={[styles.jobDot, { backgroundColor: isDone ? '#10B981' : isActive ? '#F59E0B' : '#3B82F6' }]} />
                    <View style={styles.jobInfo}>
                      <Text style={styles.jobClient}>{addr?.nickname || (job.clients as any)?.full_name}</Text>
                      <Text style={styles.jobTime}>{fmtTime(job.scheduled_start)}{job.is_turnover ? ' · 🏠 ' + t('turnover') : ''}</Text>
                    </View>
                    <Text style={styles.jobArrow}>→</Text>
                  </TouchableOpacity>
                )
              })}
            </View>

            {/* Monthly earnings */}
            {user.role !== 'owner' && (
              <View style={styles.earningsCard}>
                <Text style={styles.earningsLabel}>💰 {t('my_earnings')}</Text>
                <Text style={styles.earningsValue}>${monthStats.earnings.toLocaleString('en-US', { minimumFractionDigits: 2 })}</Text>
                <View style={styles.earningsStats}>
                  <View style={styles.earningStat}>
                    <Text style={styles.earningStatValue}>{monthStats.completed}</Text>
                    <Text style={styles.earningStatLabel}>{t('done_label')}</Text>
                  </View>
                  <View style={styles.earningStat}>
                    <Text style={styles.earningStatValue}>{monthStats.hours}h</Text>
                    <Text style={styles.earningStatLabel}>{t('total_time')}</Text>
                  </View>
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  scroll: { paddingBottom: 40 },
  startDayBtn: { marginHorizontal: 16, marginTop: 16, backgroundColor: GOLD, borderRadius: 14, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
  startDayBtnText: { color: SLATE, fontSize: 17, fontWeight: '800' },
  shiftCardOn: { marginHorizontal: 16, marginTop: 16, backgroundColor: '#ECFDF5', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: '#A7F3D0' },
  shiftOnLabel: { color: '#065F46', fontSize: 14, fontWeight: '700' },
  shiftTimer: { color: '#047857', fontSize: 22, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  endDayBtn: { backgroundColor: '#10B981', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  endDayBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  header: { backgroundColor: SLATE_DARK, padding: 20, paddingBottom: 0 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  greeting: { color: '#fff', fontSize: 22, fontWeight: '800' },
  date: { color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 },
  sosBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', shadowColor: '#EF4444', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8 },
  sosBtnText: { fontSize: 20 },
  sosHoldLabel: { fontSize: 7, color: 'rgba(255,255,255,0.8)', fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.3 },
  statsBar: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, padding: 14, marginBottom: 20 },
  stat: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, backgroundColor: 'rgba(255,255,255,0.1)' },
  statValue: { color: '#fff', fontSize: 20, fontWeight: '800' },
  statLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
  activeBanner: { margin: 16, backgroundColor: '#FEF3C7', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: '#FCD34D' },
  activePulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#F59E0B', marginRight: 12 },
  activeInfo: { flex: 1 },
  activeLabel: { fontSize: 11, fontWeight: '700', color: '#92400E', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  activeClient: { fontSize: 16, fontWeight: '800', color: '#111827', marginBottom: 2 },
  activeTime: { fontSize: 12, color: '#6B7280' },
  activeArrow: { fontSize: 18, color: '#F59E0B', fontWeight: '700' },
  nextJobCard: { margin: 16, marginTop: 0, backgroundColor: '#fff', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
  nextJobHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  nextJobLabel: { fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 },
  nextJobTime: { fontSize: 13, fontWeight: '700', color: GOLD },
  nextJobClient: { fontSize: 18, fontWeight: '800', color: '#0F172A', marginBottom: 4 },
  nextJobAddress: { fontSize: 12, color: '#64748B', marginBottom: 4 },
  nextJobLockbox: { fontSize: 12, color: '#334155', fontWeight: '600' },
  quickActions: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 16 },
  quickBtn: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4 },
  quickBtnIcon: { fontSize: 22, marginBottom: 4 },
  quickBtnLabel: { fontSize: 10, fontWeight: '700', color: '#334155', textAlign: 'center' },
  section: { paddingHorizontal: 16 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  seeAll: { fontSize: 12, color: GOLD, fontWeight: '600' },
  emptyCard: { backgroundColor: '#fff', borderRadius: 12, padding: 20, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  emptyText: { fontSize: 13, color: '#94A3B8' },
  jobRow: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  jobDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  jobInfo: { flex: 1 },
  jobClient: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  jobTime: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
  jobArrow: { fontSize: 16, color: '#CBD5E1' },
  moreBtn: { backgroundColor: '#F8FAFC', borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  moreBtnText: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  earningsCard: { margin: 16, backgroundColor: SLATE_DARK, borderRadius: 16, padding: 20 },
  earningsLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  earningsValue: { color: GOLD, fontSize: 36, fontWeight: '900', marginBottom: 14 },
  earningsStats: { flexDirection: 'row', gap: 16 },
  earningStat: { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 10, padding: 10, flex: 1, alignItems: 'center' },
  earningStatValue: { color: '#fff', fontSize: 20, fontWeight: '800' },
  earningStatLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
})
