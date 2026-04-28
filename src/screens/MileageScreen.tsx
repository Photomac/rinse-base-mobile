import React, { useState, useEffect, useRef } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert, RefreshControl, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Location from 'expo-location'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { SLATE_DARK, GOLD } from '../lib/theme'
import { ensureForegroundLocation } from '../lib/permissions'

const IRS_RATE = 0.70 // 2025 IRS standard mileage rate fallback
const PURPOSES_KEYS = ['job_travel', 'supply_run_miles', 'equipment_pickup', 'client_meeting', 'training', 'other'] as const
type PurposeKey = typeof PURPOSES_KEYS[number]

function fmtDate(iso: string) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
function fmt$(n: number) { return '$' + n.toFixed(2) }
function fmtDuration(ms: number) {
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// Haversine distance in miles
function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

export function MileageScreen({ user }: { user: any }) {
  const { t, lang } = useLang()
  const [trips, setTrips] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ date: new Date().toISOString().split('T')[0], from: '', to: '', miles: '', purpose: 'job_travel' as PurposeKey, notes: '' })

  // GPS tracking state
  const [tracking, setTracking] = useState(false)
  const [trackingStart, setTrackingStart] = useState<Date | null>(null)
  const [trackingMiles, setTrackingMiles] = useState(0)
  const [trackingPurpose, setTrackingPurpose] = useState<PurposeKey>('job_travel')
  const [elapsed, setElapsed] = useState(0)
  const locationSub = useRef<any>(null)
  const lastCoord = useRef<{ lat: number; lng: number } | null>(null)
  const timerRef = useRef<any>(null)
  const milesRef = useRef(0)
  const [mileageRate, setMileageRate] = useState(IRS_RATE)

  async function load() {
    try {
      const [tripsRes, tenantRes] = await Promise.all([
        supabase.from('mileage_logs').select('*')
          .eq('tenant_id', user.tenant_id).eq('user_id', user.id)
          .order('started_at', { ascending: false }).limit(50),
        supabase.from('tenants').select('mileage_rate').eq('id', user.tenant_id).single()
      ])
      setTrips(tripsRes.data ?? [])
      if (tenantRes.data?.mileage_rate != null) setMileageRate(tenantRes.data.mileage_rate)
    } catch (err) {
      console.warn('Failed to load mileage data:', err)
    }
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { load() }, [])

  // Elapsed timer
  useEffect(() => {
    if (tracking && trackingStart) {
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - trackingStart.getTime())
      }, 1000)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [tracking, trackingStart])

  async function startTracking() {
    // User explicitly tapped Start tracking, so it's the right moment to
    // surface a Settings deep-link if the permission was previously denied.
    const status = await ensureForegroundLocation()
    if (status !== 'granted') return
    milesRef.current = 0
    lastCoord.current = null
    setTrackingMiles(0)
    setTrackingStart(new Date())
    setTracking(true)

    locationSub.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 5000 },
      (loc) => {
        const { latitude, longitude } = loc.coords
        if (lastCoord.current) {
          const d = haversine(lastCoord.current.lat, lastCoord.current.lng, latitude, longitude)
          if (d > 0.01) { // ignore < 50ft noise
            milesRef.current += d
            setTrackingMiles(Math.round(milesRef.current * 100) / 100)
          }
        }
        lastCoord.current = { lat: latitude, lng: longitude }
      }
    )
  }

  async function stopTracking() {
    if (locationSub.current) {
      locationSub.current.remove()
      locationSub.current = null
    }
    setTracking(false)
    const miles = Math.round(milesRef.current * 100) / 100

    if (miles < 0.1) {
      Alert.alert(t('trip_too_short'), t('trip_too_short_msg'))
      setTrackingMiles(0)
      return
    }

    Alert.alert(
      ti(t('save_trip_title'), { miles: String(miles) }),
      ti(t('estimated_reimbursement'), { amt: fmt$(miles * mileageRate) }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('submit_approval'),
          onPress: async () => {
            setSaving(true)
            const { error } = await supabase.from('mileage_logs').insert({
              tenant_id: user.tenant_id, user_id: user.id,
              started_at: trackingStart?.toISOString() || new Date().toISOString(),
              origin_label: 'GPS tracked', dest_label: 'GPS tracked',
              distance_miles: miles,
              reimbursement_amt: Math.round(miles * mileageRate * 100) / 100,
              purpose: trackingPurpose, notes: t('auto_tracked_gps'), flagged: false,
            })
            setSaving(false)
            if (error) { Alert.alert(t('error'), 'Failed to save trip. Please try again.'); return }
            setTrackingMiles(0)
            load()
          }
        }
      ]
    )
  }

  async function handleSubmit() {
    if (!form.from || !form.to) { Alert.alert(t('error'), t('enter_origin_dest')); return }
    const miles = parseFloat(form.miles)
    if (!miles || miles <= 0) { Alert.alert(t('error'), t('enter_valid_miles')); return }
    setSaving(true)
    const { error } = await supabase.from('mileage_logs').insert({
      tenant_id: user.tenant_id, user_id: user.id,
      started_at: new Date(form.date + 'T08:00:00').toISOString(),
      origin_label: form.from.trim(), dest_label: form.to.trim(),
      distance_miles: miles, reimbursement_amt: Math.round(miles * mileageRate * 100) / 100,
      purpose: form.purpose, notes: form.notes.trim() || null, flagged: false,
    })
    setSaving(false)
    if (error) { Alert.alert(t('error'), 'Failed to save mileage. Please try again.'); return }
    setForm({ date: new Date().toISOString().split('T')[0], from: '', to: '', miles: '', purpose: 'job_travel', notes: '' })
    setShowForm(false)
    load()
  }

  const totalMiles = trips.reduce((s, t) => s + Number(t.distance_miles || 0), 0)
  const approvedAmt = trips.filter(t => t.approved_at).reduce((s, t) => s + Number(t.reimbursement_amt || 0), 0)
  const pendingAmt = trips.filter(t => !t.approved_at && !t.flagged).reduce((s, t) => s + Number(t.reimbursement_amt || 0), 0)
  const f = (k: string, v: string) => setForm(prev => ({ ...prev, [k]: v }))

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>↗ {t('my_mileage')}</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowForm(v => !v)}>
          <Text style={styles.addBtnText}>{showForm ? '✕' : '+ ' + t('log_trip')}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={GOLD} />}
      >
        {/* KPIs */}
        <View style={styles.kpiRow}>
          <View style={styles.kpi}><Text style={styles.kpiValue}>{totalMiles.toFixed(1)}</Text><Text style={styles.kpiLabel}>{t('total_miles')}</Text></View>
          <View style={[styles.kpi, styles.kpiMiddle]}><Text style={[styles.kpiValue, { color: '#F59E0B' }]}>{fmt$(pendingAmt)}</Text><Text style={styles.kpiLabel}>{t('pending')}</Text></View>
          <View style={styles.kpi}><Text style={[styles.kpiValue, { color: '#10B981' }]}>{fmt$(approvedAmt)}</Text><Text style={styles.kpiLabel}>{t('approved')}</Text></View>
        </View>

        {/* GPS Tracker */}
        <View style={[styles.gpsCard, tracking && styles.gpsCardActive]}>
          <View style={styles.gpsHeader}>
            <Text style={styles.gpsTitle}>{tracking ? '📍 ' + t('loading').replace('...', '...') : '🚗 ' + t('log_trip')}</Text>
            {tracking && <View style={styles.gpsPulse} />}
          </View>

          {tracking ? (
            <>
              <View style={styles.gpsStats}>
                <View style={styles.gpsStat}>
                  <Text style={styles.gpsStatValue}>{trackingMiles.toFixed(2)}</Text>
                  <Text style={styles.gpsStatLabel}>{t('miles')}</Text>
                </View>
                <View style={styles.gpsStatDivider} />
                <View style={styles.gpsStat}>
                  <Text style={styles.gpsStatValue}>{fmtDuration(elapsed)}</Text>
                  <Text style={styles.gpsStatLabel}>Time</Text>
                </View>
                <View style={styles.gpsStatDivider} />
                <View style={styles.gpsStat}>
                  <Text style={[styles.gpsStatValue, { color: '#10B981' }]}>{fmt$(trackingMiles * mileageRate)}</Text>
                  <Text style={styles.gpsStatLabel}>{t('estimated')}</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.stopBtn} onPress={stopTracking}>
                <Text style={styles.stopBtnText}>{t('stop_and_save')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.gpsSubtitle}>{t('gps_subtitle')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 10 }}>
                {PURPOSES_KEYS.map(key => (
                  <TouchableOpacity key={key} style={[styles.chip, trackingPurpose === key && styles.chipActive]} onPress={() => setTrackingPurpose(key)}>
                    <Text style={[styles.chipText, trackingPurpose === key && styles.chipTextActive]}>{t(key)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity style={styles.startBtn} onPress={startTracking}>
                <Text style={styles.startBtnText}>{t('start_tracking')}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Manual form */}
        {showForm && (
          <View style={styles.card}>
            <Text style={styles.formTitle}>{t('log_manually')}</Text>
            <Text style={styles.fieldLabel}>{t('date')}</Text>
            <TextInput style={styles.input} value={form.date} onChangeText={v => f('date', v)} placeholderTextColor="#94A3B8" />
            <Text style={styles.fieldLabel}>{t('from_label')} *</Text>
            <TextInput style={styles.input} value={form.from} onChangeText={v => f('from', v)} placeholder={t('from_label')} placeholderTextColor="#94A3B8" />
            <Text style={styles.fieldLabel}>{t('to_label')} *</Text>
            <TextInput style={styles.input} value={form.to} onChangeText={v => f('to', v)} placeholder={t('to_label')} placeholderTextColor="#94A3B8" />
            <Text style={styles.fieldLabel}>{t('miles')} *</Text>
            <TextInput style={styles.input} value={form.miles} onChangeText={v => f('miles', v)} placeholder="0.0" keyboardType="decimal-pad" placeholderTextColor="#94A3B8" />
            {form.miles && parseFloat(form.miles) > 0 && (
              <View style={styles.estimateBadge}><Text style={styles.estimateText}>💰 {fmt$(parseFloat(form.miles) * mileageRate)}</Text></View>
            )}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 8 }}>
              {PURPOSES_KEYS.map(key => (
                <TouchableOpacity key={key} style={[styles.chip, form.purpose === key && styles.chipActive]} onPress={() => f('purpose', key)}>
                  <Text style={[styles.chipText, form.purpose === key && styles.chipTextActive]}>{t(key)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={[styles.submitBtn, saving && { opacity: 0.6 }]} onPress={handleSubmit} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitBtnText}>{t('save_trip')}</Text>}
            </TouchableOpacity>
          </View>
        )}

        {/* Trip history */}
        {loading ? <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} /> : trips.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🚗</Text>
            <Text style={styles.emptyTitle}>{t('no_trips')}</Text>
            <Text style={styles.emptyText}>{t('no_trips_sub')}</Text>
          </View>
        ) : trips.map(trip => {
          const isApproved = !!trip.approved_at
          const isFlagged = !!trip.flagged
          const isGPS = trip.notes?.includes('GPS')
          return (
            <View key={trip.id} style={styles.tripRow}>
              <View style={[styles.dot, { backgroundColor: isApproved ? '#10B981' : isFlagged ? '#EF4444' : '#F59E0B' }]} />
              <View style={styles.tripInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.tripRoute} numberOfLines={1}>
                    {isGPS ? '📍 ' + t('auto_tracked_gps') : `${trip.origin_label} → ${trip.dest_label}`}
                  </Text>
                </View>
                <Text style={styles.tripMeta}>{fmtDate(trip.started_at)} · {t(trip.purpose as PurposeKey) || trip.purpose}</Text>
              </View>
              <View style={styles.tripRight}>
                <Text style={styles.tripMiles}>{Number(trip.distance_miles).toFixed(1)} mi</Text>
                <Text style={[styles.tripAmt, isApproved && { color: '#10B981' }]}>{fmt$(Number(trip.reimbursement_amt))}</Text>
                <View style={[styles.tripStatus, { backgroundColor: isApproved ? '#DCFCE7' : isFlagged ? '#FEE2E2' : '#FEF9C3' }]}>
                  <Text style={[styles.tripStatusText, { color: isApproved ? '#15803D' : isFlagged ? '#DC2626' : '#854D0E' }]}>
                    {isApproved ? '✓ ' + t('approved') : isFlagged ? '⚑ ' + t('flagged') : '• ' + t('pending')}
                  </Text>
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
  addBtn: { backgroundColor: 'rgba(255,255,255,0.12)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  scroll: { padding: 16, paddingBottom: 40 },
  kpiRow: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 16, marginBottom: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#E2E8F0' },
  kpi: { flex: 1, alignItems: 'center', padding: 16 },
  kpiMiddle: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#E2E8F0' },
  kpiValue: { fontSize: 22, fontWeight: '900', color: GOLD, marginBottom: 2 },
  kpiLabel: { fontSize: 10, color: '#94A3B8', fontWeight: '600', textTransform: 'uppercase' },
  gpsCard: { backgroundColor: '#fff', borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 1.5, borderColor: '#E2E8F0' },
  gpsCardActive: { borderColor: GOLD, backgroundColor: '#FFFBF0' },
  gpsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  gpsTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  gpsPulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#10B981' },
  gpsSubtitle: { fontSize: 12, color: '#64748B', lineHeight: 18, marginBottom: 4 },
  gpsStats: { flexDirection: 'row', backgroundColor: '#F8FAFC', borderRadius: 12, padding: 14, marginBottom: 14 },
  gpsStat: { flex: 1, alignItems: 'center' },
  gpsStatDivider: { width: 1, backgroundColor: '#E2E8F0' },
  gpsStatValue: { fontSize: 20, fontWeight: '900', color: GOLD },
  gpsStatLabel: { fontSize: 10, color: '#94A3B8', fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
  startBtn: { backgroundColor: GOLD, borderRadius: 12, padding: 14, alignItems: 'center' },
  startBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  stopBtn: { backgroundColor: '#EF4444', borderRadius: 12, padding: 14, alignItems: 'center' },
  stopBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  formTitle: { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 14 },
  fieldLabel: { fontSize: 10, fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 5, marginTop: 10 },
  input: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 10, padding: 12, fontSize: 14, color: '#0F172A' },
  estimateBadge: { backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#6EE7B7', borderRadius: 10, padding: 10, marginTop: 8 },
  estimateText: { color: '#065F46', fontSize: 13, fontWeight: '700', textAlign: 'center' },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#F8FAFC', marginRight: 8 },
  chipActive: { backgroundColor: GOLD, borderColor: GOLD },
  chipText: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  submitBtn: { backgroundColor: GOLD, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 12 },
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
