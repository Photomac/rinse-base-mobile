import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert, RefreshControl, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { SLATE_DARK, GOLD } from '../lib/theme'

const RATE = 0.67
const PURPOSES_EN = ['Job travel', 'Supply run', 'Equipment pickup', 'Client meeting', 'Training', 'Other']
const PURPOSES_KEYS: Record<string, any> = {
  'Job travel': 'job_travel', 'Supply run': 'supply_run_miles',
  'Equipment pickup': 'equipment_pickup', 'Client meeting': 'client_meeting',
  'Training': 'training', 'Other': 'other'
}

function fmtDate(iso: string) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
function fmt$(n: number) { return '$' + n.toFixed(2) }

export function MileageScreen({ user }: { user: any }) {
  const { t } = useLang()
  const [trips, setTrips] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ date: new Date().toISOString().split('T')[0], from: '', to: '', miles: '', purpose: t('job_travel'), notes: '' })

  async function load() {
    const { data } = await supabase.from('mileage_logs').select('*').eq('tenant_id', user.tenant_id).eq('user_id', user.id).order('started_at', { ascending: false }).limit(50)
    setTrips(data ?? [])
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { load() }, [])

  async function handleSubmit() {
    if (!form.from || !form.to) { Alert.alert('Error', 'Enter origin and destination'); return }
    const miles = parseFloat(form.miles)
    if (!miles || miles <= 0) { Alert.alert('Error', 'Enter valid miles'); return }
    setSaving(true)
    const { error } = await supabase.from('mileage_logs').insert({
      tenant_id: user.tenant_id, user_id: user.id,
      started_at: new Date(form.date + 'T08:00:00').toISOString(),
      origin_label: form.from.trim(), dest_label: form.to.trim(),
      distance_miles: miles, reimbursement_amt: Math.round(miles * RATE * 100) / 100,
      purpose: form.purpose, notes: form.notes.trim() || null, flagged: false,
    })
    if (error) { Alert.alert('Error', error.message) }
    else { setForm({ date: new Date().toISOString().split('T')[0], from: '', to: '', miles: '', purpose: t('job_travel'), notes: '' }); setShowForm(false); load() }
    setSaving(false)
  }

  const totalMiles = trips.reduce((s, t) => s + Number(t.distance_miles || 0), 0)
  const approvedAmt = trips.filter(t => t.approved_at).reduce((s, t) => s + Number(t.reimbursement_amt || 0), 0)
  const pendingAmt = trips.filter(t => !t.approved_at && !t.flagged).reduce((s, t) => s + Number(t.reimbursement_amt || 0), 0)
  const f = (k: string, v: string) => setForm(prev => ({ ...prev, [k]: v }))

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>↗ My mileage</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowForm(v => !v)}>
          <Text style={styles.addBtnText}>{showForm ? '✕ Cancel' : t('log_trip')}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={GOLD} />}>
        <View style={styles.kpiRow}>
          <View style={styles.kpi}><Text style={styles.kpiValue}>{totalMiles.toFixed(1)}</Text><Text style={styles.kpiLabel}>Total miles</Text></View>
          <View style={[styles.kpi, styles.kpiMiddle]}><Text style={[styles.kpiValue, { color: '#F59E0B' }]}>{fmt$(pendingAmt)}</Text><Text style={styles.kpiLabel}>Pending</Text></View>
          <View style={styles.kpi}><Text style={[styles.kpiValue, { color: '#10B981' }]}>{fmt$(approvedAmt)}</Text><Text style={styles.kpiLabel}>Approved</Text></View>
        </View>
        <View style={styles.rateBar}><Text style={styles.rateText}>Rate: <Text style={{ fontWeight: '700', color: '#0F172A' }}>${RATE.toFixed(3)}/mile</Text> · IRS 2026</Text></View>
        {showForm && (
          <View style={styles.card}>
            <Text style={styles.formTitle}>🚗 Log a trip</Text>
            <Text style={styles.fieldLabel}>Date</Text>
            <TextInput style={styles.input} value={form.date} onChangeText={v => f('date', v)} placeholderTextColor="#94A3B8" />
            <Text style={styles.fieldLabel}>From *</Text>
            <TextInput style={styles.input} value={form.from} onChangeText={v => f('from', v)} placeholder="Starting location" placeholderTextColor="#94A3B8" />
            <Text style={styles.fieldLabel}>To *</Text>
            <TextInput style={styles.input} value={form.to} onChangeText={v => f('to', v)} placeholder="Destination" placeholderTextColor="#94A3B8" />
            <Text style={styles.fieldLabel}>Miles *</Text>
            <TextInput style={styles.input} value={form.miles} onChangeText={v => f('miles', v)} placeholder={t('miles_placeholder')} keyboardType="decimal-pad" placeholderTextColor="#94A3B8" />
            {form.miles && parseFloat(form.miles) > 0 && (
              <View style={styles.estimateBadge}><Text style={styles.estimateText}>💰 Estimated: {fmt$(parseFloat(form.miles) * RATE)}</Text></View>
            )}
            <Text style={styles.fieldLabel}>Purpose</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6 }}>
              {PURPOSES_EN.map(p => (
                <TouchableOpacity key={p} style={[styles.chip, form.purpose === p && styles.chipActive]} onPress={() => f('purpose', p)}>
                  <Text style={[styles.chipText, form.purpose === p && styles.chipTextActive]}>{t(PURPOSES_KEYS[p])}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={[styles.submitBtn, saving && { opacity: 0.6 }]} onPress={handleSubmit} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitBtnText}>Submit for approval{form.miles && parseFloat(form.miles) > 0 ? ` — ${fmt$(parseFloat(form.miles) * RATE)}` : ''}</Text>}
            </TouchableOpacity>
          </View>
        )}
        {loading ? <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} /> : trips.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyIcon}>🚗</Text><Text style={styles.emptyTitle}>No trips yet</Text><Text style={styles.emptyText}>Log your mileage to get reimbursed</Text></View>
        ) : trips.map(trip => {
          const isApproved = !!trip.approved_at
          const isFlagged = !!trip.flagged
          return (
            <View key={trip.id} style={styles.tripRow}>
              <View style={[styles.dot, { backgroundColor: isApproved ? '#10B981' : isFlagged ? '#EF4444' : '#F59E0B' }]} />
              <View style={styles.tripInfo}>
                <Text style={styles.tripRoute} numberOfLines={1}>{trip.origin_label} → {trip.dest_label}</Text>
                <Text style={styles.tripMeta}>{fmtDate(trip.started_at)} · {trip.purpose}</Text>
              </View>
              <View style={styles.tripRight}>
                <Text style={styles.tripMiles}>{Number(trip.distance_miles).toFixed(1)} mi</Text>
                <Text style={[styles.tripAmt, isApproved && { color: '#10B981' }]}>{fmt$(Number(trip.reimbursement_amt))}</Text>
                <View style={[styles.tripStatus, { backgroundColor: isApproved ? '#DCFCE7' : isFlagged ? '#FEE2E2' : '#FEF9C3' }]}>
                  <Text style={[styles.tripStatusText, { color: isApproved ? '#15803D' : isFlagged ? '#DC2626' : '#854D0E' }]}>{isApproved ? '✓ Approved' : isFlagged ? '⚑ Flagged' : '• Pending'}</Text>
                </View>
              </View>
            </View>
          )
        })}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: SLATE_DARK, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20 },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  addBtn: { backgroundColor: GOLD, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  scroll: { padding: 16, paddingBottom: 40 },
  kpiRow: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 16, marginBottom: 12, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  kpi: { flex: 1, alignItems: 'center', padding: 16 },
  kpiMiddle: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#E2E8F0' },
  kpiValue: { fontSize: 22, fontWeight: '900', color: GOLD, marginBottom: 2 },
  kpiLabel: { fontSize: 10, color: '#94A3B8', fontWeight: '600', textTransform: 'uppercase' },
  rateBar: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  rateText: { fontSize: 12, color: '#64748B', textAlign: 'center' },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  formTitle: { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 14 },
  fieldLabel: { fontSize: 10, fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 5, marginTop: 10 },
  input: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 10, padding: 12, fontSize: 14, color: '#0F172A' },
  estimateBadge: { backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#6EE7B7', borderRadius: 10, padding: 10, marginTop: 8 },
  estimateText: { color: '#065F46', fontSize: 13, fontWeight: '700', textAlign: 'center' },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#F8FAFC', marginRight: 8 },
  chipActive: { backgroundColor: GOLD, borderColor: GOLD },
  chipText: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  submitBtn: { backgroundColor: GOLD, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 16 },
  submitBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12, opacity: 0.3 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#0F172A', marginBottom: 4 },
  emptyText: { fontSize: 13, color: '#94A3B8' },
  tripRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8, gap: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  tripInfo: { flex: 1 },
  tripRoute: { fontSize: 13, fontWeight: '600', color: '#0F172A', marginBottom: 2 },
  tripMeta: { fontSize: 11, color: '#94A3B8' },
  tripRight: { alignItems: 'flex-end', gap: 2 },
  tripMiles: { fontSize: 13, fontWeight: '700' },
  tripAmt: { fontSize: 13, fontWeight: '800', color: '#334155' },
  tripStatus: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  tripStatusText: { fontSize: 9, fontWeight: '700' },
})
