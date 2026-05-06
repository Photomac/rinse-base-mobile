import React, { useState, useEffect, useRef, useCallback } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Pressable, Alert, Vibration, ActivityIndicator, Animated, Platform, Linking } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Location from 'expo-location'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { sendSOSNotification } from '../lib/notifications'
import { ensureForegroundLocation } from '../lib/permissions'

const HOLD_DURATION = 3000

interface Props {
  user: any
  onCancel: () => void
  onSent: () => void
}

export function SOSScreen({ user, onCancel, onSent }: Props) {
  const { t } = useLang()
  const [phase, setPhase] = useState<'ready' | 'holding' | 'sent' | 'responded'>('ready')
  const [holdProgress, setHoldProgress] = useState(0)
  const [location, setLocation] = useState<any>(null)
  const [locationLabel, setLocationLabel] = useState('')
  const [responding, setResponding] = useState(false)

  const holdTimer = useRef<any>(null)
  const holdInterval = useRef<any>(null)
  const pulseAnim = useRef(new Animated.Value(1)).current

  // Get GPS on mount. Use the central permission helper so we don't
  // re-fire the OS prompt every time SOS is opened — silent mode reads
  // the cached status and only requests if undetermined.
  useEffect(() => {
    setLocationLabel(t('getting_location'))
    async function getLocation() {
      try {
        const status = await ensureForegroundLocation({ silent: true })
        if (status !== 'granted') {
          setLocationLabel(t('location_unavailable'))
          return
        }
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
        setLocation(loc.coords)
        setLocationLabel(`${loc.coords.latitude.toFixed(6)}, ${loc.coords.longitude.toFixed(6)}`)
      } catch (e) {
        setLocationLabel(t('location_error'))
      }
    }
    getLocation()
  }, [])

  // Pulse animation
  useEffect(() => {
    if (phase === 'sent') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: false }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: false }),
        ])
      ).start()
    }
  }, [phase])

  // (Auto-911 countdown removed — the app does not auto-dial 911. Crews
  // can tap the explicit "Call 911" button in the sent-state UI to dial
  // out themselves. This is also App Store safe — no false promises.)

  function startHold() {
    try { Vibration.vibrate(50) } catch(e) {}
    setPhase('holding')
    setHoldProgress(0)
    let progress = 0
    holdInterval.current = setInterval(() => {
      progress += 100 / (HOLD_DURATION / 100)
      const newProgress = Math.min(progress, 100)
      setHoldProgress(newProgress)
      if (newProgress >= 100) {
        clearInterval(holdInterval.current)
        sendSOS()
      }
    }, 100)
    holdTimer.current = setTimeout(() => {
      clearInterval(holdInterval.current)
      setHoldProgress(100)
      // sendSOS is handled by onLongPress
    }, HOLD_DURATION)
  }

  function cancelHold() {
    clearTimeout(holdTimer.current)
    clearInterval(holdInterval.current)
    if (holdProgress < 100) {
      setPhase('ready')
      setHoldProgress(0)
    }
  }

  async function sendSOS() {
    try { Vibration.vibrate([0, 200, 100, 200, 100, 200]) } catch(e) {}
    // Set phase first so UI updates immediately
    setPhase('sent')
    setHoldProgress(0)
    // Send push to all owners/managers (fire-and-forget on the
    // wrapper, which is a real Promise, so .catch is safe here)
    sendSOSNotification(user.tenant_id, user.full_name, locationLabel).catch(console.warn)
    // Supabase query builders return a PromiseLike — await in try/catch
    // rather than chain .then/.catch, which crashes at runtime.
    try {
      await supabase.from('sos_alerts').insert({
        tenant_id: user.tenant_id,
        user_id: user.id,
        triggered_at: new Date().toISOString(),
        lat: location?.latitude || null,
        lng: location?.longitude || null,
        status: 'active',
      })
      onSent()
    } catch (e: any) {
      console.warn('SOS insert error:', e)
    }
  }

  async function markOK() {
    setResponding(true)
    try {
      await supabase.from('sos_alerts')
        .update({ status: 'false_alarm', resolved_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('status', 'active')
    } catch (e: any) {
      console.warn('SOS markOK error:', e)
      // Don't block the UI on a network failure — the local state still
      // resets so the crew member isn't stuck on the alert screen.
    }
    try { Vibration.cancel() } catch(e) {}
    setResponding(false)
    setPhase('responded')
  }

  function call911() {
    Alert.alert(
      t('call_911_title'),
      t('call_911_msg'),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('call_911_btn'),
          style: 'destructive',
          onPress: () => Linking.openURL('tel:911').catch(() => {
            Alert.alert(t('location_error'), 'Open your phone app and dial 911 directly.')
          }),
        },
      ],
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>

      {/* Header */}
      <View style={styles.header}>
        {phase !== 'sent' && (
          <TouchableOpacity onPress={onCancel} style={styles.cancelTopBtn}>
            <Text style={styles.cancelTopText}>← {t('cancel')}</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.headerTitle}>{t('emergency_sos')}</Text>
        <View style={{ width: 80 }} />
      </View>

      {/* Location */}
      <View style={styles.locationBar}>
        <Text style={styles.locationIcon}>📍</Text>
        <Text style={styles.locationText} numberOfLines={2}>{locationLabel}</Text>
      </View>

      {/* Main content */}
      {phase === 'ready' || phase === 'holding' ? (
        <View style={styles.content}>
          <Text style={styles.instructionTitle}>{t('hold_3_seconds')}</Text>
          <Text style={styles.instructionSub}>
            {t('sos_instruction')}{'\n'}
            {t('sos_instruction2')}
          </Text>

          {/* Big SOS hold button */}
          <View style={styles.buttonWrapper}>
            {/* Progress ring */}
            {phase === 'holding' && (
              <View style={styles.progressRing}>
                <View style={[styles.progressFill, { 
                  height: `${holdProgress}%` as any,
                  bottom: 0,
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  borderRadius: 999,
                  backgroundColor: 'rgba(255,255,255,0.25)',
                }]} />
              </View>
            )}
            <TouchableOpacity
              style={[styles.sosButton, phase === 'holding' && styles.sosButtonHolding]}
              onLongPress={sendSOS}
              delayLongPress={3000}
              onPressIn={startHold}
              onPressOut={cancelHold}
              onPress={() => {}}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Emergency SOS button"
              accessibilityHint="Press and hold for 3 seconds to alert your owner and manager"
            >
              <Text style={styles.sosEmoji}>🆘</Text>
              <Text style={styles.sosButtonText}>SOS</Text>
              <Text style={styles.sosHoldText}>
                {phase === 'holding'
                  ? `${Math.ceil((100 - holdProgress) / 33.3)}...`
                  : t('hold_btn_ready')}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.warningText}>
            {t('sos_warning')}
          </Text>

        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.sentContent}>
          {/* Pulsing alert */}
          <Animated.View style={[styles.sentCircle, { transform: [{ scale: pulseAnim }] }]}>
            <Text style={styles.sentEmoji}>🆘</Text>
            <Text style={styles.sentTitle}>{t('alert_sent')}</Text>
          </Animated.View>

          <Text style={styles.sentMessage}>
            {t('sos_sent_msg')}{'\n'}
            {t('sos_sent_msg2')}
          </Text>

          {/* GPS coordinates */}
          {location && (
            <View style={styles.coordsCard}>
              <Text style={styles.coordsLabel}>{t('your_gps')}</Text>
              <Text style={styles.coordsValue}>
                {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
              </Text>
              <Text style={styles.coordsAddress}>{locationLabel}</Text>
            </View>
          )}

          {/* If this is a real life-threatening emergency, dial 911 directly. */}
          <TouchableOpacity onPress={call911} style={styles.call911Btn}
            accessibilityRole="button"
            accessibilityLabel="Call 911"
            accessibilityHint="Dials 911 from your phone for a life-threatening emergency">
            <Text style={styles.call911BtnText}>📞 {t('call_911_btn')}</Text>
            <Text style={styles.call911Sub}>{t('call_911_sub')}</Text>
          </TouchableOpacity>

          {/* I'm OK button */}
          <TouchableOpacity
            style={[styles.okBtn, responding && { opacity: 0.6 }]}
            onPress={markOK}
            disabled={responding}
          >
            {responding
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.okBtnText}>✓ {t('im_ok')}</Text>
            }
          </TouchableOpacity>
        </ScrollView>
      )}

      {phase === 'responded' && (
        <View style={styles.respondedOverlay}>
          <View style={styles.respondedCard}>
            <Text style={styles.respondedEmoji}>✓</Text>
            <Text style={styles.respondedTitle}>{t('false_alarm_title')}</Text>
            <Text style={styles.respondedSub}>{t('false_alarm_sub')}</Text>
            <TouchableOpacity style={styles.respondedBtn} onPress={onCancel}>
              <Text style={styles.respondedBtnText}>{t('close')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a0000' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,0,0,0.2)' },
  cancelTopBtn: { padding: 4, width: 80 },
  cancelTopText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '600' },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '800', textAlign: 'center' },
  locationBar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, paddingHorizontal: 16, backgroundColor: 'rgba(255,255,255,0.05)', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  locationIcon: { fontSize: 16 },
  locationText: { flex: 1, color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  instructionTitle: { color: '#fff', fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 12 },
  instructionSub: { color: 'rgba(255,255,255,0.5)', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 48 },
  buttonWrapper: { alignItems: 'center', justifyContent: 'center', marginBottom: 40 },
  progressRing: { position: 'absolute', width: 220, height: 220, borderRadius: 110, overflow: 'hidden', borderWidth: 4, borderColor: 'rgba(255,255,255,0.3)' },
  progressFill: { backgroundColor: 'rgba(255,255,255,0.2)' },
  sosButton: { width: 200, height: 200, borderRadius: 100, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', shadowColor: '#EF4444', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 30, elevation: 20 },
  sosButtonHolding: { backgroundColor: '#DC2626', shadowOpacity: 1, shadowRadius: 40 },
  sosEmoji: { fontSize: 48, marginBottom: 4 },
  sosButtonText: { color: '#fff', fontSize: 28, fontWeight: '900', letterSpacing: 2 },
  sosHoldText: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600', marginTop: 4 },
  warningText: { color: 'rgba(255,200,0,0.8)', fontSize: 13, textAlign: 'center', fontWeight: '600' },
  sentContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'flex-start', padding: 24, paddingTop: 40, paddingBottom: 60 },
  sentCircle: { width: 120, height: 120, borderRadius: 60, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', marginBottom: 16, shadowColor: '#EF4444', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 20 },
  sentEmoji: { fontSize: 32 },
  sentTitle: { color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: 2, marginTop: 4 },
  sentMessage: { color: 'rgba(255,255,255,0.8)', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 14 },
  coordsCard: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 14, padding: 12, width: '100%', marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  coordsLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  coordsValue: { color: '#fff', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'], marginBottom: 4 },
  coordsAddress: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  call911Btn: { backgroundColor: '#DC2626', borderRadius: 14, padding: 16, width: '100%', alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: '#B91C1C' },
  call911BtnText: { color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: 0.5 },
  call911Sub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 4, fontWeight: '600' },
  okBtn: { backgroundColor: '#10B981', borderRadius: 14, padding: 18, width: '100%', alignItems: 'center' },
  okBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  respondedOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  respondedCard: { backgroundColor: '#0F172A', borderRadius: 20, padding: 32, alignItems: 'center', width: '100%', borderWidth: 1, borderColor: '#10B981' },
  respondedEmoji: { fontSize: 48, color: '#10B981', fontWeight: '900', marginBottom: 12 },
  respondedTitle: { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 8, textAlign: 'center' },
  respondedSub: { color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  respondedBtn: { backgroundColor: '#10B981', borderRadius: 12, padding: 16, width: '100%', alignItems: 'center' },
  respondedBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
})
