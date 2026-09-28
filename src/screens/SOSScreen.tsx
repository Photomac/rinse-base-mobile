import React, { useState, useEffect, useRef } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, Vibration, ActivityIndicator, Animated, Platform, Linking, AccessibilityInfo } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Location from 'expo-location'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { ensureForegroundLocation } from '../lib/permissions'
import { startSOSTrail, stopSOSTrail } from '../lib/sosTracker'
import {
  QueuedSOS, raiseSOS, flushSOSQueue, cancelSOS, getSOS, resumableSOS,
  updateSOSLocation, onSOSChange, isSOSFlushing, sosDeliveryState,
} from '../lib/sosQueue'

const HOLD_DURATION = 3000
// Until the alert reaches the server, try again this often. Each try is capped
// by the queue's own request timeout, and tries never overlap.
const RETRY_EVERY_MS = 10_000
// How long "I'm OK" waits on the network before saying plainly that the office
// hasn't been told yet. The cancel keeps trying after that.
const CANCEL_WAIT_MS = 6_000

interface Props {
  user: any
  onCancel: () => void
  onSent: () => void
}

type Outcome = 'cancelled_unsent' | 'resolved' | 'resolve_queued'

// The screen never says "sent" on its own. What it shows after the hold comes
// from the SOS queue (src/lib/sosQueue.ts): "sending" until the first answer,
// "not reached anyone" on a network failure or a server refusal, and "sent"
// only once the server has the row. Until 2026-09-28 it said "ALERT SENT"
// before any network call, and in a dead zone nothing reached anyone.
export function SOSScreen({ user, onCancel, onSent }: Props) {
  const { t } = useLang()
  const [phase, setPhase] = useState<'ready' | 'holding' | 'active' | 'responded'>('ready')
  const [holdProgress, setHoldProgress] = useState(0)
  const [location, setLocation] = useState<any>(null)
  const [locationLabel, setLocationLabel] = useState('')
  const [alert, setAlert] = useState<QueuedSOS | null>(null)
  const [flushing, setFlushing] = useState(false)
  const [nextTryAt, setNextTryAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [responding, setResponding] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const holdTimer = useRef<any>(null)
  const holdInterval = useRef<any>(null)
  const firedRef = useRef(false)
  const alertRef = useRef<QueuedSOS | null>(null)
  const announced = useRef<string | null>(null)
  const pulseAnim = useRef(new Animated.Value(1)).current

  const alertId = alert?.id ?? null
  const delivery = alert ? sosDeliveryState(alert) : 'sending'
  const officePhone: string | null = user?._contact?.dispatchPhone || null

  useEffect(() => { alertRef.current = alert }, [alert])

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

  // An alert this phone raised and never delivered (app killed, phone died,
  // dead zone) picks up where it left off instead of a second one being raised.
  useEffect(() => {
    let alive = true
    resumableSOS(user.id).then(e => {
      if (!alive || !e || firedRef.current) return
      firedRef.current = true
      alertRef.current = e
      setAlert(e)
      setPhase('active')
      flushSOSQueue().catch(() => {})
      startSOSTrail(e.id).catch(() => {})
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Follow the queue: every delivery step lands here.
  useEffect(() => onSOSChange(() => {
    setFlushing(isSOSFlushing())
    const id = alertRef.current?.id
    if (!id) return
    getSOS(id).then(e => {
      // A cancel that reached the server is dropped from the queue; keep the
      // last copy, marked synced, so the screen knows it went through.
      const last = alertRef.current
      const next = e ?? (last?.id === id && last.cancelled_at ? { ...last, cancel_synced: true } : null)
      if (next) { alertRef.current = next; setAlert(next) }
    }).catch(() => {})
  }), [])

  // "I'm OK" answered "the office still sees your SOS" because there was no
  // signal. When the cancel gets through, say so.
  useEffect(() => {
    if (outcome === 'resolve_queued' && alert?.cancel_synced) setOutcome('resolved')
  }, [outcome, alert?.cancel_synced])

  // A fix that arrives after the press still goes out with the alert, as long
  // as the alert hasn't landed yet.
  useEffect(() => {
    if (alertId && location) updateSOSLocation(alertId, location.latitude, location.longitude).catch(() => {})
  }, [alertId, location])

  // Keep trying while the alert, its push to the office, or an "I'm OK" is
  // still on the phone. The app-wide drain and the SOS location task flush
  // too; the queue makes overlapping calls safe.
  useEffect(() => {
    if ((phase !== 'active' && phase !== 'responded') || !alertId) return
    let stopped = false
    let timer: any
    const needsWork = () => {
      const a = alertRef.current
      if (!a) return false
      return a.cancelled_at ? !a.cancel_synced : !a.landed_at || a.push === 'pending'
    }
    const tick = async () => {
      if (stopped) return
      if (needsWork()) {
        setNextTryAt(null)
        await flushSOSQueue().catch(() => {})
        if (stopped) return
      }
      setNextTryAt(needsWork() ? Date.now() + RETRY_EVERY_MS : null)
      timer = setTimeout(tick, RETRY_EVERY_MS)
    }
    setNextTryAt(Date.now() + RETRY_EVERY_MS)
    timer = setTimeout(tick, RETRY_EVERY_MS)
    return () => { stopped = true; clearTimeout(timer) }
  }, [phase, alertId])

  // Countdown to the next try while it hasn't gone through.
  useEffect(() => {
    if (phase !== 'active' || delivery === 'sent') return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [phase, delivery])

  // Pulse once the office has it.
  useEffect(() => {
    if (phase !== 'active' || delivery !== 'sent') return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: false }),
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [phase, delivery])

  // Say each change out loud for screen readers, and buzz when it goes through:
  // someone in trouble may not be looking at the screen.
  useEffect(() => {
    if (phase !== 'active' || announced.current === delivery) return
    const wasWaiting = announced.current !== null
    announced.current = delivery
    if (delivery === 'sent') {
      onSent()
      if (wasWaiting) { try { Vibration.vibrate([0, 80, 80, 80]) } catch (e) {} }
      AccessibilityInfo.announceForAccessibility(t('sos_sent_office_has_it'))
    } else if (delivery === 'offline') {
      AccessibilityInfo.announceForAccessibility(t('sos_no_signal'))
    } else if (delivery === 'refused') {
      AccessibilityInfo.announceForAccessibility(t('sos_refused'))
    }
  }, [phase, delivery])

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
    if (firedRef.current) return
    clearTimeout(holdTimer.current)
    clearInterval(holdInterval.current)
    if (holdProgress < 100) {
      setPhase('ready')
      setHoldProgress(0)
    }
  }

  async function sendSOS() {
    // onLongPress and the hold timer can both get here; one hold is one alert.
    if (firedRef.current) return
    firedRef.current = true
    clearTimeout(holdTimer.current)
    clearInterval(holdInterval.current)
    try { Vibration.vibrate([0, 200, 100, 200, 100, 200]) } catch(e) {}
    setHoldProgress(0)
    setPhase('active')
    // Onto the phone first, before any network. From here the alert survives
    // a dead zone or a killed app until the office has it.
    const entry = await raiseSOS({
      tenant_id: user.tenant_id,
      user_id: user.id,
      crew_name: user.full_name || 'A crew member',
      lat: location?.latitude ?? null,
      lng: location?.longitude ?? null,
    })
    alertRef.current = entry
    setAlert(entry)
    flushSOSQueue().catch(() => {})
    // The trail starts now, not after delivery: its background location task
    // is what keeps retrying if the crew member locks the phone or switches to
    // the dialer. It only records pings once the alert has landed.
    startSOSTrail(entry.id).catch(() => {})
  }

  async function markOK() {
    const id = alertRef.current?.id
    if (!id) return
    setResponding(true)
    // Stop the trail first and unconditionally: "I'm OK" has to stop the phone
    // broadcasting its location, network or no network.
    try { await stopSOSTrail() } catch { /* best-effort */ }
    const landedBefore = !!alertRef.current?.landed_at
    // Don't hold someone on a spinner for a whole network timeout. The cancel
    // is stored before this returns and keeps trying in the background.
    await Promise.race([cancelSOS(id).catch(() => {}), new Promise(r => setTimeout(r, CANCEL_WAIT_MS))])
    const after = await getSOS(id).catch(() => null)
    const landed = landedBefore || !!after?.landed_at
    const synced = !after || after.cancel_synced // dropped from the queue = the server has it
    if (after) { alertRef.current = after; setAlert(after) }
    setOutcome(!landed ? 'cancelled_unsent' : synced ? 'resolved' : 'resolve_queued')
    try { Vibration.cancel() } catch(e) {}
    setResponding(false)
    setPhase('responded')
  }

  const digits = (n: string) => n.replace(/[^\d+]/g, '')

  // One tap. The phone itself still asks before dialing (iOS shows a call
  // prompt, Android opens the dialer), so a pocket press can't place the call.
  function call911() {
    Linking.openURL('tel:911').catch(() => {
      Alert.alert(t('call_911_btn'), t('dial_911_manually'))
    })
  }

  function callOffice() {
    if (!officePhone) return
    Linking.openURL(`tel:${digits(officePhone)}`).catch(() => {
      Alert.alert(t('sos_call_office'), ti(t('sos_call_failed'), { phone: officePhone }))
    })
  }

  // A text often gets out on a bar where data can't. Opens Messages with the
  // position filled in; the crew member taps Send.
  function textOffice() {
    if (!officePhone) return
    const lat = location?.latitude ?? alertRef.current?.lat
    const lng = location?.longitude ?? alertRef.current?.lng
    const loc = lat != null && lng != null
      ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)} https://maps.google.com/?q=${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`
      : t('sos_sms_no_gps')
    const body = ti(t('sos_sms_body'), { name: user?.full_name || '', loc })
    const sep = Platform.OS === 'ios' ? '&' : '?'
    Linking.openURL(`sms:${digits(officePhone)}${sep}body=${encodeURIComponent(body)}`).catch(() => {
      Alert.alert(t('sos_text_office'), ti(t('sos_call_failed'), { phone: officePhone }))
    })
  }

  const retryLine = flushing || !nextTryAt
    ? t('sos_retrying')
    : ti(t('sos_next_try'), { s: String(Math.max(1, Math.ceil((nextTryAt - now) / 1000))) })

  const pushLine = !alert || alert.push === 'pending'
    ? t('sos_alerting_phones')
    : alert.push === 'sent' && (alert.push_recipients ?? 0) > 0
      ? ti(t('sos_phones_alerted'), { n: String(alert.push_recipients) })
      : t('sos_no_office_push')

  const responded = outcome === 'resolve_queued'
    ? { title: t('sos_ok_queued_title'), sub: t('sos_ok_queued_sub') }
    : outcome === 'resolved'
      ? { title: t('false_alarm_title'), sub: t('false_alarm_sub') }
      : { title: t('sos_cancelled_unsent_title'), sub: t('sos_cancelled_unsent_sub') }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>

      {/* Header */}
      <View style={styles.header}>
        {phase === 'ready' || phase === 'holding' ? (
          <TouchableOpacity onPress={onCancel} style={styles.cancelTopBtn}>
            <Text style={styles.cancelTopText}>← {t('cancel')}</Text>
          </TouchableOpacity>
        ) : <View style={{ width: 80 }} />}
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
          {delivery === 'sent' ? (
            <Animated.View style={[styles.sentCircle, { transform: [{ scale: pulseAnim }] }]}>
              <Text style={styles.sentEmoji}>🆘</Text>
              <Text style={styles.sentTitle}>{t('sos_sent_title')}</Text>
            </Animated.View>
          ) : delivery === 'sending' ? (
            <View style={[styles.sentCircle, styles.sendingCircle]}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.sentTitle}>{t('sos_sending_title')}</Text>
            </View>
          ) : (
            <View style={[styles.sentCircle, styles.notSentCircle]}>
              <Text style={styles.notSentMark}>!</Text>
              <Text style={styles.notSentTitle}>{t('sos_not_sent_title')}</Text>
            </View>
          )}

          {delivery === 'sending' && (
            <>
              <Text style={styles.statusHeadline}>{t('sos_sending_msg')}</Text>
              <Text style={styles.statusSub}>{t('sos_saved_on_phone')}</Text>
            </>
          )}

          {(delivery === 'offline' || delivery === 'refused') && (
            <View style={styles.notSentCard} accessibilityLiveRegion="assertive">
              <Text style={styles.notSentHeadline}>
                {t(delivery === 'offline' ? 'sos_no_signal' : 'sos_refused')}
              </Text>
              <Text style={styles.notSentSub}>{t('sos_call_now_retrying')}</Text>
              <View style={styles.retryRow}>
                {flushing && <ActivityIndicator size="small" color="#1A1408" />}
                <Text style={styles.retryText}>{retryLine}</Text>
              </View>
            </View>
          )}

          {delivery === 'sent' && (
            <>
              <Text style={styles.statusHeadline}>{t('sos_sent_office_has_it')}</Text>
              <Text style={styles.statusSub}>{pushLine}</Text>
              <Text style={styles.sentMessage}>{t('sos_sent_msg2')}</Text>
            </>
          )}

          {/* If this is a real life-threatening emergency, dial 911 directly. */}
          <TouchableOpacity onPress={call911} style={styles.call911Btn}
            accessibilityRole="button"
            accessibilityLabel="Call 911"
            accessibilityHint="Dials 911 from your phone for a life-threatening emergency">
            <Text style={styles.call911BtnText}>📞 {t('call_911_btn')}</Text>
            <Text style={styles.call911Sub}>{t('call_911_sub')}</Text>
          </TouchableOpacity>

          {officePhone ? (
            <>
              <TouchableOpacity onPress={callOffice} style={styles.officeBtn}
                accessibilityRole="button"
                accessibilityLabel={t('sos_call_office')}>
                <Text style={styles.officeBtnText}>📞 {t('sos_call_office')}</Text>
                <Text style={styles.officeSub}>{officePhone}</Text>
              </TouchableOpacity>
              {delivery !== 'sent' && (
                <TouchableOpacity onPress={textOffice} style={styles.textBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t('sos_text_office')}>
                  <Text style={styles.textBtnText}>💬 {t('sos_text_office')}</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <Text style={styles.noOfficeText}>{t('sos_no_office_number')}</Text>
          )}

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

          {/* I'm OK button */}
          <TouchableOpacity
            style={[styles.okBtn, (responding || !alert) && { opacity: 0.6 }]}
            onPress={markOK}
            disabled={responding || !alert}
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
          <View style={[styles.respondedCard, outcome === 'resolve_queued' && styles.respondedCardWarn]}>
            <Text style={[styles.respondedEmoji, outcome === 'resolve_queued' && styles.respondedEmojiWarn]}>
              {outcome === 'resolve_queued' ? '!' : '✓'}
            </Text>
            <Text style={styles.respondedTitle}>{responded.title}</Text>
            <Text style={styles.respondedSub}>{responded.sub}</Text>
            {outcome === 'resolve_queued' && officePhone && (
              <TouchableOpacity style={styles.respondedCallBtn} onPress={callOffice}>
                <Text style={styles.respondedCallText}>📞 {t('sos_call_office')}</Text>
              </TouchableOpacity>
            )}
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
  sentContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'flex-start', padding: 24, paddingTop: 28, paddingBottom: 60 },
  sentCircle: { width: 120, height: 120, borderRadius: 60, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', marginBottom: 16, shadowColor: '#EF4444', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 20 },
  sendingCircle: { backgroundColor: '#7F1D1D', shadowOpacity: 0 },
  notSentCircle: { backgroundColor: 'transparent', borderWidth: 4, borderColor: '#F59E0B', shadowOpacity: 0 },
  sentEmoji: { fontSize: 32 },
  sentTitle: { color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: 2, marginTop: 4 },
  notSentMark: { color: '#F59E0B', fontSize: 40, fontWeight: '900', lineHeight: 44 },
  notSentTitle: { color: '#F59E0B', fontSize: 13, fontWeight: '900', letterSpacing: 1, textAlign: 'center', paddingHorizontal: 8 },
  statusHeadline: { color: '#fff', fontSize: 20, fontWeight: '900', textAlign: 'center', marginBottom: 6 },
  statusSub: { color: 'rgba(255,255,255,0.75)', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 12 },
  notSentCard: { backgroundColor: '#F59E0B', borderRadius: 14, padding: 16, width: '100%', marginBottom: 16 },
  notSentHeadline: { color: '#1A1408', fontSize: 20, fontWeight: '900', lineHeight: 26, marginBottom: 8 },
  notSentSub: { color: '#1A1408', fontSize: 14, fontWeight: '600', lineHeight: 20 },
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  retryText: { color: '#1A1408', fontSize: 13, fontWeight: '800' },
  sentMessage: { color: 'rgba(255,255,255,0.8)', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 14 },
  coordsCard: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 14, padding: 12, width: '100%', marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  coordsLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  coordsValue: { color: '#fff', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'], marginBottom: 4 },
  coordsAddress: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  call911Btn: { backgroundColor: '#DC2626', borderRadius: 14, padding: 16, width: '100%', alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: '#B91C1C' },
  call911BtnText: { color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: 0.5 },
  call911Sub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 4, fontWeight: '600' },
  officeBtn: { backgroundColor: '#fff', borderRadius: 14, padding: 16, width: '100%', alignItems: 'center', marginBottom: 12 },
  officeBtnText: { color: '#1A1408', fontSize: 20, fontWeight: '900' },
  officeSub: { color: '#6B5E42', fontSize: 13, marginTop: 4, fontWeight: '700', fontVariant: ['tabular-nums'] },
  textBtn: { borderRadius: 14, padding: 14, width: '100%', alignItems: 'center', marginBottom: 16, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.6)' },
  textBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  noOfficeText: { color: 'rgba(255,255,255,0.6)', fontSize: 13, textAlign: 'center', marginBottom: 16 },
  okBtn: { backgroundColor: '#10B981', borderRadius: 14, padding: 18, width: '100%', alignItems: 'center' },
  okBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  respondedOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  respondedCard: { backgroundColor: '#0F172A', borderRadius: 20, padding: 32, alignItems: 'center', width: '100%', borderWidth: 1, borderColor: '#10B981' },
  respondedCardWarn: { borderColor: '#F59E0B' },
  respondedEmoji: { fontSize: 48, color: '#10B981', fontWeight: '900', marginBottom: 12 },
  respondedEmojiWarn: { color: '#F59E0B' },
  respondedTitle: { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 8, textAlign: 'center' },
  respondedSub: { color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  respondedCallBtn: { backgroundColor: '#fff', borderRadius: 12, padding: 16, width: '100%', alignItems: 'center', marginBottom: 12 },
  respondedCallText: { color: '#1A1408', fontSize: 16, fontWeight: '900' },
  respondedBtn: { backgroundColor: '#10B981', borderRadius: 12, padding: 16, width: '100%', alignItems: 'center' },
  respondedBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
})
