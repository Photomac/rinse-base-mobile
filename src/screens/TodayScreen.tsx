import React, { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, ActivityIndicator, Linking, Alert, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { SLATE_DARK, GOLD } from '../lib/theme'

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  scheduled:   { color: '#3B82F6', bg: '#DBEAFE', label: 'Scheduled'   },
  en_route:    { color: '#8B5CF6', bg: '#EDE9FE', label: 'En route'    },
  in_progress: { color: '#F59E0B', bg: '#FEF3C7', label: 'In progress' },
  completed:   { color: '#10B981', bg: '#D1FAE5', label: 'Completed'   },
  cancelled:   { color: '#9CA3AF', bg: '#F3F4F6', label: 'Cancelled'   },
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function TodayScreen({ user, onJobPress }: { user: any; onJobPress: (job: any) => void }) {
  const { t } = useLang()
  const [jobs, setJobs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const now = new Date()
    const start = new Date(now); start.setHours(0,0,0,0)
    const end = new Date(now); end.setHours(23,59,59,999)
    const { data } = await supabase.from('jobs')
      .select('id, address_id, status, scheduled_start, scheduled_end, is_turnover, supplies_needed, supplies_notes, clients!jobs_client_id_fkey(full_name, phone), client_addresses!jobs_address_id_fkey(id, street, city, state, zip, nickname, lockbox_code, arrival_instructions, lat, lng, photo_url), service_types(name), job_assignments(user_id, is_lead)')
      .eq('tenant_id', user.tenant_id)
      .gte('scheduled_start', start.toISOString())
      .lte('scheduled_start', end.toISOString())
      .neq('status', 'cancelled')
      .order('scheduled_start')
    const isOwner = user.role === 'owner' || user.role === 'manager'
    const myJobs = isOwner
      ? (data ?? [])
      : (data ?? []).filter((j: any) => j.job_assignments?.some((a: any) => a.user_id === user.id))
    setJobs(myJobs)
    setLoading(false)
    setRefreshing(false)
  }, [user])

  useEffect(() => { load() }, [load])

  async function checkPhotosAndComplete(job: any) {
    const { data: photos } = await supabase
      .from('job_photos')
      .select('id, photo_type')
      .eq('job_id', job.id)
      .in('photo_type', ['after', 'completed'])
    
    if (!photos || photos.length === 0) {
      Alert.alert(
        '📷 Photo Required',
        'Please take at least one after photo before marking this job complete.',
        [{ text: 'OK', style: 'default' }]
      )
      return
    }
    Alert.alert('Complete?', t('complete_confirm'), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Complete', onPress: () => updateStatus(job, 'completed') }
    ])
  }

  async function updateStatus(job: any, newStatus: string) {
    setUpdatingId(job.id)
    await supabase.from('jobs').update({ status: newStatus }).eq('id', job.id)
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: newStatus } : j))
    setUpdatingId(null)
  }

  const now = new Date()
  const greeting = now.getHours() < 12 ? t('good_morning') : now.getHours() < 17 ? t('good_afternoon') : t('good_evening')

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>{greeting}, {user.full_name?.split(' ')[0]} 👋</Text>
          <Text style={styles.date}>{now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{jobs.length}</Text>
          <Text style={styles.badgeLabel}>jobs</Text>
        </View>
      </View>
      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={GOLD} size="large" /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={GOLD} />}>
          {jobs.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🌟</Text>
              <Text style={styles.emptyTitle}>No jobs today</Text>
              <Text style={styles.emptyText}>Enjoy your day off!</Text>
            </View>
          ) : jobs.map((job: any) => {
            const st = STATUS_CONFIG[job.status] || STATUS_CONFIG.scheduled
            const addr = job.client_addresses
            const client = job.clients
            const isDone = job.status === 'completed'
            const isUpdating = updatingId === job.id
            return (
              <TouchableOpacity key={job.id} style={[styles.card, isDone && styles.cardDone]} onPress={() => onJobPress(job)} activeOpacity={0.7}>
                {addr?.photo_url && (
                  <Image source={{ uri: addr.photo_url }} style={{ width: '100%', height: 120, borderRadius: 8, marginBottom: 10 }} resizeMode="cover" />
                )}
                <View style={styles.cardHeader}>
                  <View style={{ flexDirection: 'row' }}>
                    <Text style={styles.timeText}>{fmtTime(job.scheduled_start)}</Text>
                    <Text style={styles.timeEnd}> – {fmtTime(job.scheduled_end)}</Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: st.bg }]}>
                    <Text style={[styles.statusText, { color: st.color }]}>{st.label}</Text>
                  </View>
                </View>
                <Text style={styles.clientName}>{addr?.nickname || client?.full_name || 'Job'}{job.is_turnover ? '  🏠 Turnover' : ''}</Text>
                <Text style={styles.address}>📍 {addr?.street}, {addr?.city}</Text>
                {job.supplies_needed?.length > 0 && (
                  <View style={styles.suppliesBadge}>
                    <Text style={styles.suppliesText}>📦 {Array.isArray(job.supplies_needed) ? job.supplies_needed.join(', ') : job.supplies_needed}</Text>
                  </View>
                )}
                {addr?.lockbox_code && <Text style={styles.lockbox}>🔐 Lockbox: {addr.lockbox_code}</Text>}
                {!isDone && (
                  <View style={styles.actions}>
                    <TouchableOpacity style={styles.actionBtn} onPress={() => {
                      const q = addr?.lat ? `${addr.lat},${addr.lng}` : `${addr?.street}, ${addr?.city}`
                      Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(q)}`)
                    }}>
                      <Text style={styles.actionBtnText}>🗺 Directions</Text>
                    </TouchableOpacity>
                    {client?.phone && (
                      <TouchableOpacity style={styles.actionBtn} onPress={() => Linking.openURL(`tel:${client.phone}`)}>
                        <Text style={styles.actionBtnText}>📞 Call</Text>
                      </TouchableOpacity>
                    )}
                    {job.status === 'scheduled' && (
                      <TouchableOpacity style={[styles.actionBtnPrimary, isUpdating && { opacity: 0.6 }]} onPress={() => updateStatus(job, 'en_route')} disabled={isUpdating}>
                        <Text style={styles.actionBtnPrimaryText}>{t('en_route')}</Text>
                      </TouchableOpacity>
                    )}
                    {job.status === 'en_route' && (
                      <TouchableOpacity style={[styles.actionBtnPrimary, isUpdating && { opacity: 0.6 }]} onPress={() => updateStatus(job, 'in_progress')} disabled={isUpdating}>
                        <Text style={styles.actionBtnPrimaryText}>{t('start_job')}</Text>
                      </TouchableOpacity>
                    )}
                    {job.status === 'in_progress' && (
                      <TouchableOpacity style={[styles.actionBtnGreen, isUpdating && { opacity: 0.6 }]} onPress={() => checkPhotosAndComplete(job)} disabled={isUpdating}>
                        <Text style={styles.actionBtnPrimaryText}>{t('complete')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
                {isDone && <Text style={styles.doneText}>✓ Completed</Text>}
              </TouchableOpacity>
            )
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: SLATE_DARK, padding: 20, paddingBottom: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  greeting: { color: '#fff', fontSize: 20, fontWeight: '800' },
  date: { color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 },
  badge: { backgroundColor: GOLD, borderRadius: 14, width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 22, fontWeight: '800' },
  badgeLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 10, fontWeight: '600' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 16, paddingBottom: 32 },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#0F172A', marginBottom: 6 },
  emptyText: { fontSize: 13, color: '#94A3B8' },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, borderWidth: 1, borderColor: '#E2E8F0' },
  cardDone: { opacity: 0.65 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  timeText: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  timeEnd: { fontSize: 13, color: '#64748B' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusText: { fontSize: 11, fontWeight: '700' },
  clientName: { fontSize: 16, fontWeight: '700', color: '#0F172A', marginBottom: 4 },
  address: { fontSize: 12, color: '#64748B', marginBottom: 8 },
  suppliesBadge: { backgroundColor: '#FEF9C3', borderWidth: 1, borderColor: '#FCD34D', borderRadius: 8, padding: 8, marginBottom: 8 },
  suppliesText: { fontSize: 11, color: '#854D0E', fontWeight: '600' },
  lockbox: { fontSize: 12, color: '#64748B', marginBottom: 8, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  actionBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#F8FAFC' },
  actionBtnText: { fontSize: 12, fontWeight: '600', color: '#334155' },
  actionBtnPrimary: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: GOLD, flex: 1, alignItems: 'center' },
  actionBtnGreen: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: '#10B981', flex: 1, alignItems: 'center' },
  actionBtnPrimaryText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  doneText: { fontSize: 12, color: '#10B981', fontWeight: '700', marginTop: 8, textAlign: 'center' },
})
