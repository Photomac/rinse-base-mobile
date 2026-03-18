import React, { useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert, Linking, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'

const TEAL = '#00C9A7'
const NAVY = '#0A1628'

function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }

const CHECKLIST = [
  { id: '1', label: 'Kitchen — counters, sink, stovetop, microwave' },
  { id: '2', label: 'Bathrooms — toilet, sink, tub/shower, mirrors' },
  { id: '3', label: 'Floors — vacuum/sweep all rooms' },
  { id: '4', label: 'Floors — mop hard surfaces' },
  { id: '5', label: 'Dust — all surfaces, fans, baseboards' },
  { id: '6', label: 'Trash — empty all bins' },
  { id: '7', label: 'Beds — make or change linens' },
  { id: '8', label: 'Final walkthrough — nothing missed' },
]

export function JobDetailScreen({ job, user, onBack, onStatusChange }: { job: any; user: any; onBack: () => void; onStatusChange: (job: any, status: string) => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [clockedIn, setClockedIn] = useState(job.status === 'in_progress')

  const addr = job.client_addresses
  const client = job.clients
  const completedCount = Object.values(checked).filter(Boolean).length
  const allChecked = CHECKLIST.every(i => checked[i.id])
  const progressPct = Math.round((completedCount / CHECKLIST.length) * 100)

  async function handleClockIn() {
    setSaving(true)
    await supabase.from('jobs').update({ status: 'in_progress' }).eq('id', job.id)
    setClockedIn(true)
    onStatusChange(job, 'in_progress')
    setSaving(false)
  }

  async function completeJob() {
    setSaving(true)
    await supabase.from('jobs').update({ status: 'completed', crew_done_at: new Date().toISOString() }).eq('id', job.id)
    onStatusChange(job, 'completed')
    onBack()
    setSaving(false)
  }

  function handleComplete() {
    if (!allChecked) {
      Alert.alert('Checklist incomplete', 'Complete all items before marking done.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark done anyway', style: 'destructive', onPress: completeJob },
      ])
    } else completeJob()
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}><Text style={styles.backText}>← Back</Text></TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{addr?.nickname || client?.full_name || 'Job detail'}</Text>
        <View style={{ width: 60 }} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <Text style={styles.clientName}>{addr?.nickname || client?.full_name}{job.is_turnover ? '  🏠 Turnover' : ''}</Text>
          <Text style={styles.timeRow}>🕐 {fmtTime(job.scheduled_start)} – {fmtTime(job.scheduled_end)}</Text>
          <TouchableOpacity onPress={() => {
            const q = addr?.lat ? `${addr.lat},${addr.lng}` : `${addr?.street}, ${addr?.city}`
            Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(q)}`)
          }}>
            <Text style={styles.address}>📍 {addr?.street}, {addr?.city}, {addr?.state} {addr?.zip}</Text>
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
        </View>

        {job.supplies_needed?.length > 0 && (
          <View style={[styles.card, { backgroundColor: '#FFFBEB', borderColor: '#FCD34D' }]}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#854D0E', marginBottom: 6 }}>📦 Supplies needed</Text>
            <Text style={{ fontSize: 13, color: '#92400E' }}>{Array.isArray(job.supplies_needed) ? job.supplies_needed.join(', ') : job.supplies_needed}</Text>
          </View>
        )}

        {!clockedIn && job.status !== 'completed' && (
          <TouchableOpacity style={[styles.clockInBtn, saving && { opacity: 0.6 }]} onPress={handleClockIn} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.clockInText}>▶ Clock in — Start job</Text>}
          </TouchableOpacity>
        )}

        {(clockedIn || job.status === 'in_progress') && (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={styles.sectionTitle}>Cleaning checklist</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: TEAL }}>{completedCount}/{CHECKLIST.length}</Text>
            </View>
            <View style={styles.progressBg}><View style={[styles.progressFill, { width: `${progressPct}%` as any }]} /></View>
            {CHECKLIST.map(item => (
              <TouchableOpacity key={item.id} style={styles.checkItem} onPress={() => setChecked(prev => ({ ...prev, [item.id]: !prev[item.id] }))} activeOpacity={0.6}>
                <View style={[styles.checkbox, checked[item.id] && styles.checkboxDone]}>
                  {checked[item.id] && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>✓</Text>}
                </View>
                <Text style={[styles.checkLabel, checked[item.id] && { color: '#9CA3AF', textDecorationLine: 'line-through' }]}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {(clockedIn || job.status === 'in_progress') && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Notes (optional)</Text>
            <TextInput style={styles.notesInput} value={notes} onChangeText={setNotes} placeholder="Any issues or observations..." placeholderTextColor="#9CA3AF" multiline numberOfLines={3} />
          </View>
        )}

        {(clockedIn || job.status === 'in_progress') && job.status !== 'completed' && (
          <TouchableOpacity style={[styles.completeBtn, saving && { opacity: 0.6 }]} onPress={handleComplete} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.completeBtnText}>✓ Mark job complete</Text>}
          </TouchableOpacity>
        )}

        {job.status === 'completed' && (
          <View style={styles.completedBanner}><Text style={{ color: '#065F46', fontSize: 16, fontWeight: '800' }}>✓ Job completed</Text></View>
        )}
      </ScrollView>
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
  clockInBtn: { backgroundColor: TEAL, borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 12 },
  clockInText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#111827' },
  progressBg: { height: 6, backgroundColor: '#F3F4F6', borderRadius: 3, marginBottom: 14, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: TEAL, borderRadius: 3 },
  checkItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F9FAFB', gap: 12 },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center' },
  checkboxDone: { backgroundColor: TEAL, borderColor: TEAL },
  checkLabel: { fontSize: 13, color: '#374151', flex: 1 },
  notesInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, padding: 12, fontSize: 13, color: '#111827', minHeight: 80, textAlignVertical: 'top', marginTop: 8 },
  completeBtn: { backgroundColor: '#10B981', borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 12 },
  completeBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  completedBanner: { backgroundColor: '#D1FAE5', borderRadius: 14, padding: 18, alignItems: 'center' },
})
