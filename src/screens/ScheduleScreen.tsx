import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { SLATE_DARK, GOLD } from '../lib/theme'

const STATUS_COLORS: Record<string, string> = {
  scheduled:   '#3B82F6',
  en_route:    '#8B5CF6',
  in_progress: '#F59E0B',
  completed:   '#10B981',
  cancelled:   '#9CA3AF',
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  scheduled: 'status_scheduled', en_route: 'status_en_route',
  in_progress: 'status_in_progress', completed: 'status_completed', cancelled: 'status_cancelled',
}

function isSameDay(a: Date, b: Date) { return a.toDateString() === b.toDateString() }
function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r }

type ViewMode = 'month' | 'week'

export function ScheduleScreen({ user, onJobPress }: { user: any; onJobPress: (job: any) => void }) {
  const { t } = useLang()
  const DAY_NAMES = [t('day_sun'), t('day_mon'), t('day_tue'), t('day_wed'), t('day_thu'), t('day_fri'), t('day_sat')]
  const [jobs, setJobs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [anchor, setAnchor] = useState(new Date())
  const [view, setView] = useState<ViewMode>('month')

  useEffect(() => { load() }, [])

  async function load() {
    const now = new Date()
    const start = new Date(now); start.setMonth(now.getMonth() - 1); start.setHours(0,0,0,0)
    const end = new Date(now); end.setMonth(now.getMonth() + 2); end.setHours(23,59,59,999)
    const isOwner = ['owner', 'manager', 'dispatcher'].includes(user.role)
    const { data } = await supabase.from('jobs')
      .select('id, status, scheduled_start, scheduled_end, is_turnover, clients!jobs_client_id_fkey(full_name), client_addresses!jobs_address_id_fkey(id, street, city, nickname, photo_url), job_assignments(user_id)')
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
  }

  function getJobsForDay(day: Date) {
    return jobs.filter(j => isSameDay(new Date(j.scheduled_start), day))
  }

  const now = new Date()
  const selectedJobs = getJobsForDay(selectedDate)

  function buildMonthGrid() {
    const year = anchor.getFullYear()
    const month = anchor.getMonth()
    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)
    const startPad = firstDay.getDay()
    const days: (Date | null)[] = []
    for (let i = 0; i < startPad; i++) days.push(null)
    for (let i = 1; i <= lastDay.getDate(); i++) days.push(new Date(year, month, i))
    while (days.length % 7 !== 0) days.push(null)
    const weeks: (Date | null)[][] = []
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
    return weeks
  }

  function buildWeekDays() {
    const weekStart = new Date(anchor)
    weekStart.setDate(anchor.getDate() - anchor.getDay())
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  }

  const monthLabel = anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const weekStart = new Date(anchor); weekStart.setDate(anchor.getDate() - anchor.getDay())
  const weekLabel = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' + addDays(weekStart, 6).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => {
          if (view === 'month') setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1))
          else setAnchor(a => addDays(a, -7))
        }}><Text style={styles.navBtn}>‹</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => { setAnchor(new Date()); setSelectedDate(new Date()) }}>
          <Text style={styles.headerLabel}>{view === 'month' ? monthLabel : weekLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => {
          if (view === 'month') setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1))
          else setAnchor(a => addDays(a, 7))
        }}><Text style={styles.navBtn}>›</Text></TouchableOpacity>
      </View>

      <View style={styles.viewToggle}>
        {(['month', 'week'] as ViewMode[]).map(v => (
          <TouchableOpacity key={v} style={[styles.viewBtn, view === v && styles.viewBtnActive]} onPress={() => setView(v)}>
            <Text style={[styles.viewBtnText, view === v && styles.viewBtnTextActive]}>
              {v === 'month' ? t('month_view') : t('week_view')}
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.jobCountLabel}>{ti(t('n_jobs'), { n: String(jobs.length) })}</Text>
      </View>

      <ScrollView>
        <View style={styles.dayNamesRow}>
          {DAY_NAMES.map(d => (
            <Text key={d} style={styles.dayName}>{d}</Text>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
        ) : view === 'month' ? (
          <View>
            {buildMonthGrid().map((week, wi) => (
              <View key={wi} style={styles.weekRow}>
                {week.map((day, di) => {
                  if (!day) return <View key={di} style={styles.dayCell} />
                  const dayJobs = getJobsForDay(day)
                  const isToday = isSameDay(day, now)
                  const isSelected = isSameDay(day, selectedDate)
                  const isOtherMonth = day.getMonth() !== anchor.getMonth()
                  return (
                    <TouchableOpacity key={di} style={[styles.dayCell, isSelected && styles.dayCellSelected]} onPress={() => setSelectedDate(day)}>
                      <View style={[styles.dayNum, isToday && styles.dayNumToday, isSelected && styles.dayNumSelected]}>
                        <Text style={[styles.dayNumText, isToday && styles.dayNumTextToday, isSelected && styles.dayNumTextSelected, isOtherMonth && { opacity: 0.3 }]}>
                          {day.getDate()}
                        </Text>
                      </View>
                      {dayJobs.slice(0, 2).map((job, i) => (
                        <View key={i} style={[styles.jobDot, { backgroundColor: STATUS_COLORS[job.status] || GOLD }]}>
                          <Text style={styles.jobDotText} numberOfLines={1}>
                            {(job.client_addresses as any)?.nickname || (job.clients as any)?.full_name}
                          </Text>
                        </View>
                      ))}
                      {dayJobs.length > 2 && (
                        <Text style={styles.moreJobs}>+{dayJobs.length - 2}</Text>
                      )}
                    </TouchableOpacity>
                  )
                })}
              </View>
            ))}
          </View>
        ) : (
          <View>
            <View style={styles.weekRow}>
              {buildWeekDays().map((day, i) => {
                const dayJobs = getJobsForDay(day)
                const isToday = isSameDay(day, now)
                const isSelected = isSameDay(day, selectedDate)
                return (
                  <TouchableOpacity key={i} style={[styles.weekDayCell, isSelected && styles.dayCellSelected]} onPress={() => setSelectedDate(day)}>
                    <View style={[styles.dayNum, isToday && styles.dayNumToday, isSelected && styles.dayNumSelected]}>
                      <Text style={[styles.dayNumText, isToday && styles.dayNumTextToday, isSelected && styles.dayNumTextSelected]}>
                        {day.getDate()}
                      </Text>
                    </View>
                    {dayJobs.map((job, i) => (
                      <View key={i} style={[styles.weekJobBlock, { backgroundColor: STATUS_COLORS[job.status] || GOLD }]}>
                        <Text style={styles.weekJobText} numberOfLines={1}>
                          {fmtTime(job.scheduled_start)}
                        </Text>
                        <Text style={styles.weekJobName} numberOfLines={1}>
                          {(job.client_addresses as any)?.nickname || (job.clients as any)?.full_name}
                        </Text>
                      </View>
                    ))}
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>
        )}

        <View style={styles.selectedDaySection}>
          <Text style={styles.selectedDayLabel}>
            {selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            {isSameDay(selectedDate, now) ? ` · ${t('today')}` : ''}
          </Text>
          {selectedJobs.length === 0 ? (
            <View style={styles.emptyDay}>
              <Text style={styles.emptyText}>{t('no_jobs_day')}</Text>
            </View>
          ) : selectedJobs.map((job: any) => {
            const addr = job.client_addresses as any
            const color = STATUS_COLORS[job.status] || GOLD
            return (
              <TouchableOpacity key={job.id} style={[styles.jobCard, { borderLeftColor: color }]} onPress={() => onJobPress(job)}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={styles.jobTime}>{fmtTime(job.scheduled_start)}</Text>
                    <View style={[styles.statusBadge, { backgroundColor: color + '22' }]}>
                      <Text style={[styles.statusText, { color }]}>{t((STATUS_LABEL_KEYS[job.status] || 'status_scheduled') as any)}</Text>
                    </View>
                  </View>
                  <Text style={styles.jobClient}>{addr?.nickname || (job.clients as any)?.full_name}</Text>
                  <Text style={styles.jobAddress}>📍 {addr?.street}, {addr?.city}</Text>
                  {job.is_turnover && <Text style={styles.turnoverTag}>🏠 {t('turnover')}</Text>}
                </View>
                <Text style={{ color: '#CBD5E1', fontSize: 18 }}>›</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: SLATE_DARK, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 },
  navBtn: { color: '#fff', fontSize: 28, fontWeight: '300', paddingHorizontal: 8 },
  headerLabel: { color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  viewToggle: { backgroundColor: SLATE_DARK, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  viewBtn: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  viewBtnActive: { backgroundColor: GOLD, borderColor: GOLD },
  viewBtnText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  viewBtnTextActive: { color: '#fff' },
  jobCountLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 11, marginLeft: 'auto' },
  dayNamesRow: { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  dayName: { flex: 1, textAlign: 'center', fontSize: 10, fontWeight: '700', color: '#94A3B8', paddingVertical: 6, textTransform: 'uppercase' },
  weekRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  dayCell: { flex: 1, minHeight: 64, padding: 2, borderRightWidth: 1, borderRightColor: '#E2E8F0', backgroundColor: '#fff' },
  dayCellSelected: { backgroundColor: '#FEF9EC' },
  weekDayCell: { flex: 1, minHeight: 80, padding: 4, borderRightWidth: 1, borderRightColor: '#E2E8F0', backgroundColor: '#fff' },
  dayNum: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 2, alignSelf: 'center' },
  dayNumToday: { backgroundColor: GOLD },
  dayNumSelected: { backgroundColor: '#1E293B' },
  dayNumText: { fontSize: 12, color: '#374151', fontWeight: '500' },
  dayNumTextToday: { color: '#fff', fontWeight: '700' },
  dayNumTextSelected: { color: '#fff', fontWeight: '700' },
  jobDot: { borderRadius: 3, padding: 1, marginBottom: 1, paddingHorizontal: 2 },
  jobDotText: { fontSize: 8, color: '#fff', fontWeight: '600' },
  moreJobs: { fontSize: 8, color: '#94A3B8', textAlign: 'center' },
  weekJobBlock: { borderRadius: 4, padding: 3, marginBottom: 2 },
  weekJobText: { fontSize: 9, color: '#fff', fontWeight: '600' },
  weekJobName: { fontSize: 8, color: 'rgba(255,255,255,0.85)' },
  selectedDaySection: { padding: 16 },
  selectedDayLabel: { fontSize: 14, fontWeight: '700', color: '#334155', marginBottom: 10 },
  emptyDay: { alignItems: 'center', paddingVertical: 24 },
  emptyText: { fontSize: 13, color: '#94A3B8' },
  jobCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderLeftWidth: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
  jobTime: { fontSize: 13, fontWeight: '700', color: '#0F172A' },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  statusText: { fontSize: 10, fontWeight: '700', textTransform: 'capitalize' },
  jobClient: { fontSize: 14, fontWeight: '700', color: '#0F172A', marginBottom: 2 },
  jobAddress: { fontSize: 11, color: '#94A3B8' },
  turnoverTag: { fontSize: 10, color: '#06B6D4', fontWeight: '700', marginTop: 3 },
})
