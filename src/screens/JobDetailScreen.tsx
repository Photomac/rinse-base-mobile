import React, { useState, useEffect, useRef } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert, Linking, ActivityIndicator, Modal } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { JobPhotosScreen } from './JobPhotosScreen'
import { MessagesScreen } from './MessagesScreen'
import { useLang } from '../contexts/LangContext'

import { SLATE_DARK, GOLD } from '../lib/theme'
const TEAL = GOLD
const NAVY = SLATE_DARK

const PAUSE_REASONS = [
  'Waiting for laundry',
  'Going to another job',
  'Supply run',
  'Waiting for access',
  'Break',
  'Other',
]

const DEFAULT_CHECKLIST = [
  { id: '1', label: 'Kitchen — counters, sink, stovetop, microwave', room: 'Kitchen', title: 'General clean' },
  { id: '2', label: 'Bathrooms — toilet, sink, tub/shower, mirrors', room: 'Bathroom', title: 'General clean' },
  { id: '3', label: 'Floors — vacuum/sweep all rooms', room: 'Floors', title: 'Vacuum/sweep' },
  { id: '4', label: 'Floors — mop hard surfaces', room: 'Floors', title: 'Mop' },
  { id: '5', label: 'Dust — all surfaces, fans, baseboards', room: 'General', title: 'Dust' },
  { id: '6', label: 'Trash — empty all bins', room: 'General', title: 'Trash' },
  { id: '7', label: 'Beds — make or change linens', room: 'Bedroom', title: 'Linens' },
  { id: '8', label: 'Final walkthrough — nothing missed', room: 'General', title: 'Walkthrough' },
]

function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
function fmtDuration(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function JobDetailScreen({ job, user, onBack, onStatusChange }: { job: any; user: any; onBack: () => void; onStatusChange: (job: any, status: string) => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [showPhotos, setShowPhotos] = useState(false)
  const [showMessages, setShowMessages] = useState(false)
  const [checklist, setChecklist] = useState(DEFAULT_CHECKLIST as any[])
  const [loadingChecklist, setLoadingChecklist] = useState(false)
  const [itemPhotos, setItemPhotos] = useState<Record<string, number>>({})
  const [activePhotoItem, setActivePhotoItem] = useState<any>(null)

  // Time tracking
  const [timeEntries, setTimeEntries] = useState<any[]>([])
  const [activeEntry, setActiveEntry] = useState<any>(null)
  const [isPaused, setIsPaused] = useState(false)
  const [elapsedMinutes, setElapsedMinutes] = useState(0)
  const [showPauseModal, setShowPauseModal] = useState(false)
  const [pauseReason, setPauseReason] = useState('')
  const timerRef = useRef<any>(null)

  const { t } = useLang()
  const addr = job.client_addresses as any
  const client = job.clients as any
  const isClockedIn = !!activeEntry && !isPaused
  const isStarted = timeEntries.length > 0 || !!activeEntry

  useEffect(() => {
    loadChecklist()
    loadTimeEntries()
  }, [])

  // Live timer
  useEffect(() => {
    if (isClockedIn && activeEntry) {
      timerRef.current = setInterval(() => {
        const start = new Date(activeEntry.clocked_in_at).getTime()
        const now = Date.now()
        const mins = (now - start) / 60000
        const prevMins = timeEntries
          .filter(e => e.clocked_out_at)
          .reduce((s, e) => s + (e.duration_minutes || 0), 0)
        setElapsedMinutes(prevMins + mins)
      }, 10000)
    } else {
      clearInterval(timerRef.current)
      const total = timeEntries.filter(e => e.clocked_out_at).reduce((s, e) => s + (e.duration_minutes || 0), 0)
      setElapsedMinutes(total)
    }
    return () => clearInterval(timerRef.current)
  }, [isClockedIn, activeEntry, timeEntries])

  async function loadTimeEntries() {
    const { data } = await supabase
      .from('job_time_entries')
      .select('*')
      .eq('job_id', job.id)
      .eq('user_id', user.id)
      .order('clocked_in_at')
    if (data) {
      setTimeEntries(data)
      const active = data.find(e => !e.clocked_out_at)
      if (active) {
        setActiveEntry(active)
        setIsPaused(false)
      }
      const total = data.filter(e => e.clocked_out_at).reduce((s, e) => s + (e.duration_minutes || 0), 0)
      setElapsedMinutes(total)
    }
  }

  async function loadChecklist() {
    const street = job.client_addresses?.street
    if (!street) return
    setLoadingChecklist(true)
    const { data: addrData } = await supabase
      .from('client_addresses').select('id')
      .eq('street', street).eq('tenant_id', user.tenant_id).maybeSingle()
    if (!addrData?.id) { setLoadingChecklist(false); return }
    const { data } = await supabase
      .from('address_checklist_templates')
      .select('id, room, title, sort_order')
      .eq('address_id', addrData.id)
      .order('room').order('sort_order')
    if (data && data.length > 0) {
      const items = data.map(item => ({ id: item.id, label: `${item.room} — ${item.title}`, room: item.room, title: item.title }))
      setChecklist(items)
      const { data: savedItems } = await supabase
        .from('job_checklist_items').select('task, room').eq('job_id', job.id)
      if (savedItems?.length) {
        const savedChecked: Record<string, boolean> = {}
        items.forEach(item => {
          if (savedItems.some(s => s.task === item.title && s.room === item.room)) savedChecked[item.id] = true
        })
        setChecked(savedChecked)
      }
      const { data: photos } = await supabase.from('job_photos').select('caption').eq('job_id', job.id)
      if (photos) {
        const counts: Record<string, number> = {}
        items.forEach(item => { counts[item.id] = photos.filter(p => p.caption === item.title).length })
        setItemPhotos(counts)
      }
    }
    setLoadingChecklist(false)
  }

  async function saveCheckItem(item: any, isChecked: boolean) {
    if (isChecked) {
      const { error } = await supabase.from('job_checklist_items').upsert({
        tenant_id: user.tenant_id, job_id: job.id,
        room: item.room, task: item.title, sort_order: 0,
        completed: true, completed_at: new Date().toISOString(), completed_by: user.id,
      }, { onConflict: 'job_id,task,room' })
      if (error) console.log('CHECKLIST SAVE ERROR:', error.message)
    } else {
      await supabase.from('job_checklist_items').delete().eq('job_id', job.id).eq('task', item.title).eq('room', item.room)
    }
  }

  async function handleClockIn() {
    setSaving(true)
    // Create time entry
    const { data: entry } = await supabase.from('job_time_entries').insert({
      tenant_id: user.tenant_id, job_id: job.id, user_id: user.id,
      clocked_in_at: new Date().toISOString(), entry_type: 'work',
    }).select().single()
    if (entry) setActiveEntry(entry)
    setIsPaused(false)
    // Update job status
    await supabase.from('jobs').update({ status: 'in_progress' }).eq('id', job.id)
    onStatusChange(job, 'in_progress')
    loadTimeEntries()
    setSaving(false)
  }

  async function handlePause() {
    setShowPauseModal(true)
  }

  async function confirmPause() {
    if (!pauseReason) { Alert.alert('Please select a reason'); return }
    setSaving(true)
    const now = new Date()
    const mins = (now.getTime() - new Date(activeEntry.clocked_in_at).getTime()) / 60000
    await supabase.from('job_time_entries').update({
      clocked_out_at: now.toISOString(),
      pause_reason: pauseReason,
      duration_minutes: Math.round(mins),
    }).eq('id', activeEntry.id)
    setActiveEntry(null)
    setIsPaused(true)
    setShowPauseModal(false)
    setPauseReason('')
    loadTimeEntries()
    setSaving(false)
  }

  async function handleResume() {
    setSaving(true)
    const { data: entry } = await supabase.from('job_time_entries').insert({
      tenant_id: user.tenant_id, job_id: job.id, user_id: user.id,
      clocked_in_at: new Date().toISOString(), entry_type: 'work',
    }).select().single()
    if (entry) setActiveEntry(entry)
    setIsPaused(false)
    loadTimeEntries()
    setSaving(false)
  }

  async function completeJob() {
    setSaving(true)
    // Clock out active entry
    if (activeEntry) {
      const now = new Date()
      const mins = (now.getTime() - new Date(activeEntry.clocked_in_at).getTime()) / 60000
      await supabase.from('job_time_entries').update({
        clocked_out_at: now.toISOString(),
        duration_minutes: Math.round(mins),
      }).eq('id', activeEntry.id)
    }
    await supabase.from('jobs').update({ status: 'completed' }).eq('id', job.id)
    onStatusChange(job, 'completed')
    onBack()
    setSaving(false)
  }

  const completedCount = Object.values(checked).filter(Boolean).length
  const allChecked = checklist.every(i => checked[i.id])
  const progressPct = Math.round((completedCount / checklist.length) * 100)

  if (showMessages) return <MessagesScreen job={job} user={user} onBack={() => setShowMessages(false)} />
  if (showPhotos) return <JobPhotosScreen job={job} user={user} preselectedItem={activePhotoItem} onBack={() => { setShowPhotos(false); loadChecklist() }} />

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}><Text style={styles.backText}>← Back</Text></TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{addr?.nickname || client?.full_name || 'Job detail'}</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Job info card */}
        <View style={styles.card}>
          <Text style={styles.clientName}>{addr?.nickname || client?.full_name}{job.is_turnover ? '  🏠 Turnover' : ''}</Text>
          <Text style={styles.timeRow}>🕐 {fmtTime(job.scheduled_start)} – {fmtTime(job.scheduled_end)}</Text>
          <TouchableOpacity onPress={() => {
            const q = addr?.lat ? `${addr.lat},${addr.lng}` : `${addr?.street}, ${addr?.city}`
            Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(q)}`)
          }}>
            <Text style={styles.address}>📍 {addr?.street}, {addr?.city}</Text>
          </TouchableOpacity>
          {addr?.lockbox_code && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>🔐</Text>
              <View><Text style={styles.infoLabel}>Lockbox code</Text><Text style={styles.infoValue}>{addr.lockbox_code}</Text></View>
            </View>
          )}
          {addr?.arrival_instructions && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>📋</Text>
              <View style={{ flex: 1 }}><Text style={styles.infoLabel}>Arrival instructions</Text><Text style={styles.infoValue}>{addr.arrival_instructions}</Text></View>
            </View>
          )}
          {client?.phone && (
            <TouchableOpacity style={styles.callBtn} onPress={() => Linking.openURL(`tel:${client.phone}`)}>
              <Text style={styles.callBtnText}>📞 Call {client.full_name?.split(' ')[0]}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.photosBtn} onPress={() => { setActivePhotoItem(null); setShowPhotos(true) }}>
            <Text style={styles.photosBtnText}>📸 Job Photos</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.messagesBtn} onPress={() => setShowMessages(true)}>
            <Text style={styles.messagesBtnText}>💬 Messages</Text>
          </TouchableOpacity>
        </View>

        {/* Time tracker card */}
        <View style={[styles.card, isClockedIn && { borderColor: TEAL, borderWidth: 2 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={styles.sectionTitle}>⏱ Time tracker</Text>
            {elapsedMinutes > 0 && (
              <Text style={{ fontSize: 18, fontWeight: '900', color: TEAL }}>{fmtDuration(elapsedMinutes)}</Text>
            )}
          </View>

          {/* Time entries history */}
          {timeEntries.filter(e => e.clocked_out_at).map((entry, i) => (
            <View key={entry.id} style={styles.timeEntry}>
              <Text style={styles.timeEntryText}>
                Session {i + 1}: {fmtTime(entry.clocked_in_at)} – {fmtTime(entry.clocked_out_at)}
              </Text>
              <Text style={styles.timeEntryDuration}>{fmtDuration(entry.duration_minutes || 0)}</Text>
              {entry.pause_reason && <Text style={styles.timeEntryReason}>⏸ {entry.pause_reason}</Text>}
            </View>
          ))}

          {/* Active session */}
          {isClockedIn && (
            <View style={[styles.timeEntry, { backgroundColor: '#ECFDF5', borderColor: TEAL }]}>
              <Text style={[styles.timeEntryText, { color: '#065F46' }]}>
                🟢 Active since {fmtTime(activeEntry.clocked_in_at)}
              </Text>
            </View>
          )}

          {isPaused && (
            <View style={[styles.timeEntry, { backgroundColor: '#FEF9C3', borderColor: '#FCD34D' }]}>
              <Text style={[styles.timeEntryText, { color: '#854D0E' }]}>⏸ Paused</Text>
            </View>
          )}

          {/* Action buttons */}
          {job.status !== 'completed' && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              {!isStarted && (
                <TouchableOpacity style={[styles.clockBtn, { backgroundColor: TEAL }]} onPress={handleClockIn} disabled={saving}>
                  {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.clockBtnText}>{t('clock_in_short')}</Text>}
                </TouchableOpacity>
              )}
              {isClockedIn && (
                <>
                  <TouchableOpacity style={[styles.clockBtn, { backgroundColor: '#F59E0B', flex: 1 }]} onPress={handlePause} disabled={saving}>
                    <Text style={styles.clockBtnText}>⏸ Pause</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.clockBtn, { backgroundColor: '#10B981', flex: 1 }]} onPress={() => {
                    Alert.alert('Complete job?', `Total time: ${fmtDuration(elapsedMinutes)}`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Complete', onPress: completeJob }
                    ])
                  }} disabled={saving}>
                    <Text style={styles.clockBtnText}>✓ Complete</Text>
                  </TouchableOpacity>
                </>
              )}
              {isPaused && (
                <TouchableOpacity style={[styles.clockBtn, { backgroundColor: TEAL }]} onPress={handleResume} disabled={saving}>
                  {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.clockBtnText}>{t('resume')}</Text>}
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        {/* Checklist */}
        {isStarted && (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={styles.sectionTitle}>Cleaning checklist</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: TEAL }}>{completedCount}/{checklist.length}</Text>
            </View>
            <View style={styles.progressBg}><View style={[styles.progressFill, { width: `${progressPct}%` as any }]} /></View>
            {loadingChecklist ? (
              <ActivityIndicator color={TEAL} style={{ marginVertical: 20 }} />
            ) : checklist.map((item: any) => (
              <View key={item.id} style={styles.checkItem}>
                <TouchableOpacity onPress={() => {
                  const newVal = !checked[item.id]
                  setChecked(prev => ({ ...prev, [item.id]: newVal }))
                  saveCheckItem(item, newVal)
                }} style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 }}>
                  <View style={[styles.checkbox, checked[item.id] && styles.checkboxDone]}>
                    {checked[item.id] && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>✓</Text>}
                  </View>
                  <Text style={[styles.checkLabel, checked[item.id] && { color: '#9CA3AF', textDecorationLine: 'line-through' }]}>{item.label}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.itemPhotoBtn, itemPhotos[item.id] > 0 && styles.itemPhotoBtnDone]}
                  onPress={() => { setActivePhotoItem(item); setShowPhotos(true) }}
                >
                  <Text style={styles.itemPhotoBtnText}>{itemPhotos[item.id] > 0 ? `📷 ${itemPhotos[item.id]}` : '📷'}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Notes */}
        {isStarted && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Notes (optional)</Text>
            <TextInput style={styles.notesInput} value={notes} onChangeText={setNotes} placeholder="Any issues or observations..." placeholderTextColor="#9CA3AF" multiline numberOfLines={3} />
          </View>
        )}

        {job.status === 'completed' && (
          <View style={styles.completedBanner}>
            <Text style={{ color: '#065F46', fontSize: 16, fontWeight: '800' }}>✓ Job completed</Text>
            {elapsedMinutes > 0 && <Text style={{ color: '#065F46', fontSize: 13, marginTop: 4 }}>Total time: {fmtDuration(elapsedMinutes)}</Text>}
          </View>
        )}
      </ScrollView>

      {/* Pause modal */}
      <Modal visible={showPauseModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>⏸ Why are you leaving?</Text>
            <Text style={styles.modalSub}>This helps calculate your hours accurately</Text>
            {PAUSE_REASONS.map(reason => (
              <TouchableOpacity
                key={reason}
                style={[styles.reasonBtn, pauseReason === reason && styles.reasonBtnActive]}
                onPress={() => setPauseReason(reason)}
              >
                <Text style={[styles.reasonBtnText, pauseReason === reason && { color: '#fff' }]}>{reason}</Text>
              </TouchableOpacity>
            ))}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => { setShowPauseModal(false); setPauseReason('') }}>
                <Text style={{ color: '#6B7280', fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalConfirmBtn, !pauseReason && { opacity: 0.4 }]} onPress={confirmPause} disabled={!pauseReason || saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>Pause job</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  backBtn: { padding: 4 },
  backText: { color: TEAL, fontSize: 14, fontWeight: '600' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center', marginHorizontal: 8 },
  scroll: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, borderWidth: 1, borderColor: '#F3F4F6' },
  clientName: { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 6 },
  timeRow: { fontSize: 14, color: '#374151', marginBottom: 6, fontWeight: '500' },
  address: { fontSize: 13, color: TEAL, marginBottom: 14, fontWeight: '500' },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: 10, backgroundColor: '#F9FAFB', borderRadius: 10 },
  infoIcon: { fontSize: 18 },
  infoLabel: { fontSize: 10, color: '#9CA3AF', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  infoValue: { fontSize: 14, color: '#111827', fontWeight: '600', marginTop: 2 },
  callBtn: { marginTop: 4, backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#BBF7D0', borderRadius: 10, padding: 12, alignItems: 'center' },
  callBtnText: { color: '#15803D', fontSize: 13, fontWeight: '700' },
  messagesBtn: { marginTop: 8, backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#6EE7B7', borderRadius: 10, padding: 12, alignItems: 'center' },
  messagesBtnText: { color: '#065F46', fontSize: 13, fontWeight: '700' },
  photosBtn: { marginTop: 8, backgroundColor: '#F5F3FF', borderWidth: 1, borderColor: '#DDD6FE', borderRadius: 10, padding: 12, alignItems: 'center' },
  photosBtnText: { color: '#7C3AED', fontSize: 13, fontWeight: '700' },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#111827' },
  timeEntry: { backgroundColor: '#F9FAFB', borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: '#E5E7EB' },
  timeEntryText: { fontSize: 12, color: '#374151', fontWeight: '600' },
  timeEntryDuration: { fontSize: 12, color: TEAL, fontWeight: '700', marginTop: 2 },
  timeEntryReason: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  clockBtn: { flex: 1, borderRadius: 12, padding: 14, alignItems: 'center', justifyContent: 'center' },
  clockBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  progressBg: { height: 6, backgroundColor: '#F3F4F6', borderRadius: 3, marginBottom: 14, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: TEAL, borderRadius: 3 },
  checkItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F9FAFB', gap: 12 },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center' },
  checkboxDone: { backgroundColor: TEAL, borderColor: TEAL },
  checkLabel: { fontSize: 13, color: '#374151', flex: 1 },
  itemPhotoBtn: { padding: 8, borderRadius: 8, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: '#E5E7EB' },
  itemPhotoBtnDone: { backgroundColor: '#ECFDF5', borderColor: '#6EE7B7' },
  itemPhotoBtnText: { fontSize: 14 },
  notesInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, padding: 12, fontSize: 13, color: '#111827', minHeight: 80, textAlignVertical: 'top', marginTop: 8 },
  completedBanner: { backgroundColor: '#D1FAE5', borderRadius: 14, padding: 18, alignItems: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#111827', marginBottom: 6 },
  modalSub: { fontSize: 13, color: '#9CA3AF', marginBottom: 16 },
  reasonBtn: { padding: 14, borderRadius: 12, borderWidth: 1.5, borderColor: '#E5E7EB', marginBottom: 8, backgroundColor: '#F9FAFB' },
  reasonBtnActive: { backgroundColor: NAVY, borderColor: NAVY },
  reasonBtnText: { fontSize: 14, fontWeight: '600', color: '#374151' },
  modalCancelBtn: { flex: 1, padding: 14, borderRadius: 12, alignItems: 'center', backgroundColor: '#F3F4F6' },
  modalConfirmBtn: { flex: 1, padding: 14, borderRadius: 12, alignItems: 'center', backgroundColor: '#EF4444' },
})
