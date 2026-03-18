import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'

const TEAL = '#00C9A7'
const NAVY = '#0A1628'

const STATUS_COLORS: Record<string, string> = {
  scheduled:   '#3B82F6',
  en_route:    '#8B5CF6',
  in_progress: '#F59E0B',
  completed:   '#10B981',
  cancelled:   '#9CA3AF',
}

function isSameDay(a: Date, b: Date) { return a.toDateString() === b.toDateString() }
function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
function fmtDuration(start: string, end: string) {
  const mins = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000)
  return mins >= 60 ? `${Math.floor(mins/60)}h${mins%60 > 0 ? ` ${mins%60}m` : ''}` : `${mins}m`
}

export function ScheduleScreen({ user, onJobPress }: { user: any; onJobPress: (job: any) => void }) {
  const [jobs, setJobs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [weekOffset, setWeekOffset] = useState(0)

  const load = useCallback(async () => {
    const now = new Date()
    const start = new Date(now); start.setDate(now.getDate() - 14); start.setHours(0,0,0,0)
    const end = new Date(now); end.setDate(now.getDate() + 21); end.setHours(23,59,59,999)

    const isOwner = ['owner', 'manager', 'dispatcher'].includes(user.role)

    const { data } = await supabase.from('jobs')
      .select('id, status, scheduled_start, scheduled_end, is_turnover, clients!jobs_client_id_fkey(full_name), client_addresses!jobs_address_id_fkey(street, city, nickname), job_assignments(user_id)')
      .eq('tenant_id', user.tenant_id)
      .gte('scheduled_start', start.toISOString())
      .lte('scheduled_start', end.toISOString())
      .neq('status', 'cancelled')
      .order('scheduled_start')

    const myJobs = isOwner
      ? (data ?? [])
      : (data ?? []).filter((j: any) => j.job_assignments?.some((a: any) => a.user_id === user.id))

    setJobs(myJobs)
    setLoading(false)
    setRefreshing(false)
  }, [user])

  useEffect(() => { load() }, [load])

  // Build week days
  const now = new Date()
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - now.getDay() + weekOffset * 7)
  weekStart.setHours(0,0,0,0)
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d
  })

  const selectedJobs = jobs.filter(j => isSameDay(new Date(j.scheduled_start), selectedDate))

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>📅 My schedule</Text>
        <Text style={styles.headerSub}>{jobs.length} upcoming jobs</Text>
      </View>

      {/* Week navigator */}
      <View style={styles.weekNav}>
        <TouchableOpacity onPress={() => setWeekOffset(w => w - 1)} style={styles.navBtn}>
          <Text style={styles.navBtnText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.weekLabel}>
          {weekDays[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {weekDays[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </Text>
        <TouchableOpacity onPress={() => setWeekOffset(w => w + 1)} style={styles.navBtn}>
          <Text style={styles.navBtnText}>›</Text>
        </TouchableOpacity>
      </View>

      {/* Day selector */}
      <View style={styles.dayRow}>
        {weekDays.map((day, i) => {
          const isToday = isSameDay(day, now)
          const isSelected = isSameDay(day, selectedDate)
          const dayJobs = jobs.filter(j => isSameDay(new Date(j.scheduled_start), day))
          return (
            <TouchableOpacity key={i} style={[styles.dayBtn, isSelected && styles.dayBtnSelected]} onPress={() => setSelectedDate(day)}>
              <Text style={[styles.dayName, isSelected && styles.dayTextSelected, isToday && !isSelected && styles.dayTextToday]}>
                {day.toLocaleDateString('en-US', { weekday: 'narrow' })}
              </Text>
              <Text style={[styles.dayNum, isSelected && styles.dayTextSelected, isToday && !isSelected && styles.dayTextToday]}>
                {day.getDate()}
              </Text>
              {dayJobs.length > 0 && (
                <View style={[styles.dayDot, isSelected && styles.dayDotSelected]} />
              )}
            </TouchableOpacity>
          )
        })}
      </View>

      {/* Selected day jobs */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={TEAL} />}
      >
        <Text style={styles.selectedDateLabel}>
          {selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          {isSameDay(selectedDate, now) ? ' · Today' : ''}
        </Text>

        {loading ? (
          <ActivityIndicator color={TEAL} style={{ marginTop: 40 }} />
        ) : selectedJobs.length === 0 ? (
          <View style={styles.emptyDay}>
            <Text style={styles.emptyIcon}>{isSameDay(selectedDate, now) ? '🌟' : '📅'}</Text>
            <Text style={styles.emptyTitle}>No jobs {isSameDay(selectedDate, now) ? 'today' : 'this day'}</Text>
            <Text style={styles.emptyText}>{isSameDay(selectedDate, now) ? 'Enjoy your day off!' : 'Nothing scheduled'}</Text>
          </View>
        ) : (
          selectedJobs.map((job: any, idx) => {
            const addr = job.client_addresses
            const color = STATUS_COLORS[job.status] || STATUS_COLORS.scheduled
            const isDone = job.status === 'completed'
            return (
              <TouchableOpacity key={job.id} style={[styles.jobCard, isDone && { opacity: 0.6 }]} onPress={() => onJobPress(job)}>
                <View style={[styles.jobStripe, { backgroundColor: color }]} />
                <View style={styles.jobContent}>
                  <View style={styles.jobHeader}>
                    <Text style={styles.jobTime}>{fmtTime(job.scheduled_start)}</Text>
                    <Text style={styles.jobDuration}>{fmtDuration(job.scheduled_start, job.scheduled_end)}</Text>
                    <View style={[styles.statusDot, { backgroundColor: color }]} />
                  </View>
                  <Text style={styles.jobClient}>{addr?.nickname || (job.clients as any)?.full_name}</Text>
                  <Text style={styles.jobAddress}>📍 {addr?.street}, {addr?.city}</Text>
                  {job.is_turnover && <Text style={styles.turnoverTag}>🏠 Turnover</Text>}
                </View>
                <Text style={styles.jobArrow}>›</Text>
              </TouchableOpacity>
            )
          })
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, padding: 20, paddingBottom: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  headerSub: { color: 'rgba(255,255,255,0.5)', fontSize: 12 },
  weekNav: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 },
  navBtn: { padding: 8 },
  navBtnText: { color: '#fff', fontSize: 24, fontWeight: '300' },
  weekLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
  dayRow: { backgroundColor: NAVY, flexDirection: 'row', paddingHorizontal: 8, paddingBottom: 16 },
  dayBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 12 },
  dayBtnSelected: { backgroundColor: TEAL },
  dayName: { color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', marginBottom: 4 },
  dayNum: { color: '#fff', fontSize: 16, fontWeight: '700' },
  dayTextSelected: { color: '#fff' },
  dayTextToday: { color: TEAL },
  dayDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)', marginTop: 3 },
  dayDotSelected: { backgroundColor: '#fff' },
  scroll: { padding: 16, paddingBottom: 40 },
  selectedDateLabel: { fontSize: 14, fontWeight: '700', color: '#374151', marginBottom: 14 },
  emptyDay: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12, opacity: 0.4 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 4 },
  emptyText: { fontSize: 13, color: '#9CA3AF' },
  jobCard: { backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  jobStripe: { width: 4, alignSelf: 'stretch' },
  jobContent: { flex: 1, padding: 14 },
  jobHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  jobTime: { fontSize: 13, fontWeight: '700', color: '#111827' },
  jobDuration: { fontSize: 11, color: '#9CA3AF', flex: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  jobClient: { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 3 },
  jobAddress: { fontSize: 12, color: '#9CA3AF' },
  turnoverTag: { fontSize: 11, color: '#06B6D4', fontWeight: '700', marginTop: 4 },
  jobArrow: { fontSize: 20, color: '#D1D5DB', paddingRight: 14 },
})
