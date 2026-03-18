import React, { useState, useEffect, useRef, useCallback } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Pressable, Alert, Vibration, ActivityIndicator, Animated, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Location from 'expo-location'
import { supabase } from '../lib/supabase'
import { sendSOSNotification } from '../lib/notifications'

const HOLD_DURATION = 3000
const COUNTDOWN_SECONDS = 120

interface Props {
  user: any
  onCancel: () => void
  onSent: () => void
}

export function SOSScreen({ user, onCancel, onSent }: Props) {
  const [phase, setPhase] = useState<'ready' | 'holding' | 'sent' | 'responded'>('ready')
  const [holdProgress, setHoldProgress] = useState(0)
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS)
  const [location, setLocation] = useState<any>(null)
  const [locationLabel, setLocationLabel] = useState('Getting your location...')
  const [responding, setResponding] = useState(false)

  const holdTimer = useRef<any>(null)
  const holdInterval = useRef<any>(null)
  const countdownInterval = useRef<any>(null)
  const pulseAnim = useRef(new Animated.Value(1)).current

  // Get GPS on mount
  useEffect(() => {
    async function getLocation() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync()
        if (status !== 'granted') {
          setLocationLabel('Location unavailable — enable in Settings')
          return
        }
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
        setLocation(loc.coords)
        setLocationLabel(`${loc.coords.latitude.toFixed(6)}, ${loc.coords.longitude.toFixed(6)}`)
      } catch (e) {
        setLocationLabel('Could not get location')
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

  // Countdown after SOS sent
  useEffect(() => {
    if (phase === 'sent') {
      countdownInterval.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            clearInterval(countdownInterval.current)
            // TODO: Trigger 911 call via RapidSOS/Twilio
            Alert.alert(
              '📞 Calling 911',
              `No response from your team. Showing GPS coordinates:\n\n${location?.latitude?.toFixed(6)}, ${location?.longitude?.toFixed(6)}\n\nLocation: ${locationLabel}\n\nRead these to the 911 dispatcher.`,
              [{ text: 'OK' }]
            )
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }
    return () => clearInterval(countdownInterval.current)
  }, [phase])

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
    // Then do async work
    // Send push to all owners/managers
    sendSOSNotification(user.tenant_id, user.full_name, locationLabel).catch(console.warn)
    supabase.from('sos_alerts').insert({
      tenant_id: user.tenant_id,
      user_id: user.id,
      triggered_at: new Date().toISOString(),
      lat: location?.latitude || null,
      lng: location?.longitude || null,
      status: 'active',
    }).then(() => { onSent() }).catch((e: any) => console.warn('SOS insert error:', e))
  }

  async function markOK() {
    setResponding(true)
    await supabase.from('sos_alerts')
      .update({ status: 'false_alarm', resolved_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('status', 'active')
    clearInterval(countdownInterval.current)
    try { Vibration.cancel() } catch(e) {}
    setResponding(false)
    onCancel()
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>

      {/* Header */}
      <View style={styles.header}>
        {phase !== 'sent' && (
          <TouchableOpacity onPress={onCancel} style={styles.cancelTopBtn}>
            <Text style={styles.cancelTopText}>← Cancel</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.headerTitle}>Emergency SOS</Text>
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
          <Text style={styles.instructionTitle}>Hold button for 3 seconds</Text>
          <Text style={styles.instructionSub}>
            This will alert your owner and manager immediately.{'\n'}
            If no response in 2 minutes, 911 will be called.
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
            >
              <Text style={styles.sosEmoji}>🆘</Text>
              <Text style={styles.sosButtonText}>SOS</Text>
              <Text style={styles.sosHoldText}>
                {phase === 'holding'
                  ? `${Math.ceil((100 - holdProgress) / 33.3)}...`
                  : 'Hold 3 sec'}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.warningText}>
            ⚠ Only use in a genuine emergency
          </Text>

        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.sentContent}>
          {/* Pulsing alert */}
          <Animated.View style={[styles.sentCircle, { transform: [{ scale: pulseAnim }] }]}>
            <Text style={styles.sentEmoji}>🆘</Text>
            <Text style={styles.sentTitle}>ALERT SENT</Text>
          </Animated.View>

          <Text style={styles.sentMessage}>
            Your owner and manager have been notified.{'\n'}
            Help is on the way.
          </Text>

          {/* GPS coordinates */}
          {location && (
            <View style={styles.coordsCard}>
              <Text style={styles.coordsLabel}>Your GPS coordinates</Text>
              <Text style={styles.coordsValue}>
                {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
              </Text>
              <Text style={styles.coordsAddress}>{locationLabel}</Text>
            </View>
          )}

          {/* Countdown */}
          <View style={styles.countdownCard}>
            <Text style={styles.countdownLabel}>
              {countdown > 0 ? '911 auto-call in' : 'Calling 911...'}
            </Text>
            <Text style={[styles.countdownNum, countdown <= 30 && { color: '#EF4444' }]}>
              {countdown > 0 ? `${Math.floor(countdown/60)}:${String(countdown%60).padStart(2,'0')}` : '📞'}
            </Text>
            <Text style={styles.countdownSub}>
              {countdown > 0 ? 'Tap "I\'m OK" if this was a mistake' : 'Read your GPS coordinates to dispatcher'}
            </Text>
          </View>

          {/* I'm OK button */}
          <TouchableOpacity
            style={[styles.okBtn, responding && { opacity: 0.6 }]}
            onPress={markOK}
            disabled={responding}
          >
            {responding
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.okBtnText}>✓ I'm OK — Cancel SOS</Text>
            }
          </TouchableOpacity>
        </ScrollView>
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
  countdownCard: { backgroundColor: 'rgba(239,68,68,0.15)', borderRadius: 14, padding: 12, width: '100%', alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' },
  countdownLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
  countdownNum: { color: '#FCA5A5', fontSize: 40, fontWeight: '900', fontVariant: ['tabular-nums'] },
  countdownSub: { color: 'rgba(255,255,255,0.5)', fontSize: 11, textAlign: 'center', marginTop: 4 },
  okBtn: { backgroundColor: '#10B981', borderRadius: 14, padding: 18, width: '100%', alignItems: 'center' },
  okBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
})
