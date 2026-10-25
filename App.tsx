import { Sentry } from './src/lib/sentry' // first: initializes Sentry before anything else
import React, { useState, useEffect, useRef } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, AppState, Image, Alert } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { supabase, isSignedOut } from './src/lib/supabase'
import { LoginScreen } from './src/screens/LoginScreen'
import { DashboardScreen } from './src/screens/DashboardScreen'
import { ScheduleScreen } from './src/screens/ScheduleScreen'
import { OpenJobsScreen } from './src/screens/OpenJobsScreen'
import { boardQuery, boardJobsFor } from './src/lib/openJobs'
import { MileageScreen } from './src/screens/MileageScreen'
import { TeamTodayScreen } from './src/screens/TeamTodayScreen'
import { MyWeekScreen } from './src/screens/MyWeekScreen'
import { teamTabReplacesMileage, weekTabReplacesMileage, canSeeTeam } from './src/lib/teamDay'
import { ProfileScreen } from './src/screens/ProfileScreen'
import { JobDetailScreen } from './src/screens/JobDetailScreen'
import { SOSScreen } from './src/screens/SOSScreen'
import { ChatListScreen, ChatScreen } from './src/screens/ChatScreens'
import { registerPushToken } from './src/lib/notifications'
import { reportClientVersion, reportLocationSetting } from './src/lib/clientVersion'
import { startLocationTracking, stopLocationTracking } from './src/lib/locationTracker'
// Side-effect import also registers the SOS ping TaskManager task at bundle
// eval, so a headless OS relaunch mid-emergency finds the handler.
import { resumeSOSTrailIfOpen } from './src/lib/sosTracker'
// Side-effect import: registers the arrival-geofence TaskManager task at bundle
// eval so headless OS launches (region crossings) find the handler.
import './src/lib/arrivalGeofence'
import { flushQueue } from './src/lib/photoQueue'
import { flushVideoQueue } from './src/lib/videoQueue'
import { saveCachedProfile, loadCachedProfile, clearCachedProfile } from './src/lib/profileCache'
import { myUsersRowFilter, pickMyUsersRow } from './src/lib/myUsersRow'
import { USERS_READABLE_COLUMNS, fetchMyPay } from './src/lib/userPrivateDetails'
import { clearDataCache, readCacheEntry } from './src/lib/dataCache'
import { clearCarriedPhotos } from './src/lib/carriedPhotoFiles'
import { setCurrentTz, fmtTime } from './src/lib/timezone'
import { flushOutbox, onOutboxDrained, onCompletePastRefusedPhotos, overlayPending } from './src/lib/outbox'
import { prefetchDays, isDayChangePush } from './src/lib/offlinePrefetch'
import { tappedJobId, onScreen, tapRouter, loadTappedJob, tapLedger, SCHEDULE_JOB_SELECT, type TapIO } from './src/lib/pushTap'
import { flushIncidentNotifies } from './src/lib/incidentNotify'
import { flushSOSQueue, resumableSOS } from './src/lib/sosQueue'
import * as Notifications from 'expo-notifications'
import { LangProvider, useLang } from './src/contexts/LangContext'
import { ti, tStatic, localeStatic } from './src/lib/i18n'
import { initErrorReporting, setErrorContext } from './src/lib/errorReporter'
import { ErrorBoundary } from './src/components/ErrorBoundary'

const GOLD = '#D4A843'
const SLATE_DARK = '#0F172A'
const Tab = createBottomTabNavigator()
// Lets a push tap switch tabs from outside the navigator (lib/pushTap).
const navigationRef = createNavigationContainerRef<any>()
// Taps already handled, kept across launches (lib/pushTap).
const taps = tapLedger(AsyncStorage)

// Where a tapped job push looks for its job (lib/pushTap): live, then the
// saved copies, with queued writes laid over.
const tapIO = (user: any): TapIO => ({
  live: (jobId) => supabase.from('jobs').select(SCHEDULE_JOB_SELECT)
    .eq('id', jobId).eq('tenant_id', user.tenant_id).maybeSingle(),
  saved: (key) => readCacheEntry(key),
  overlay: (rows) => overlayPending('jobs', rows),
})

// Capture uncaught mobile errors into admin_error_log (admin System Health).
initErrorReporting()

// Company settings every screen reads off the profile (as `_`-prefixed fields).
type CompanySettings = {
  _contact: { crewCanContactClient: boolean; dispatchPhone: string | null }
  _timeMode: string
  _assignmentMode: string
  _tz: string | null
  _laundryBonus: number
}
const defaultSettings = (): CompanySettings => ({
  _contact: { crewCanContactClient: false, dispatchPhone: null }, _timeMode: 'per_job', _assignmentMode: 'default_crew', _tz: null, _laundryBonus: 0,
})
const settingsFrom = (p: any): CompanySettings => ({
  _contact: p._contact ?? defaultSettings()._contact,
  _timeMode: p._timeMode ?? 'per_job',
  _assignmentMode: p._assignmentMode ?? 'default_crew',
  _tz: p._tz ?? null,
  _laundryBonus: p._laundryBonus ?? 0,
})

// Null when they couldn't be read (no signal, timeout) — never a guess.
async function companySettings(tenantId: string): Promise<CompanySettings | null> {
  const { data: tenant, error } = await supabase.from('tenants')
    .select('crew_can_contact_client, dispatch_phone, time_tracking_mode, timezone, laundry_takehome_bonus, laundry_onsite_bonus, laundry_office_bonus, laundry_laundromat_bonus, assignment_mode').eq('id', tenantId).maybeSingle()
  if (error) return null
  // Crew→client contact policy. Default: crew can't call the host directly
  // (the cleaning company owns that relationship) — they reach dispatch.
  let dispatchPhone = tenant?.dispatch_phone || null
  if (!dispatchPhone) {
    const { data: owner, error: ownerErr } = await supabase.from('users')
      .select('phone').eq('tenant_id', tenantId).eq('role', 'owner')
      .not('phone', 'is', null).limit(1).maybeSingle()
    if (ownerErr) return null
    dispatchPhone = owner?.phone || null
  }
  return {
    _contact: { crewCanContactClient: !!tenant?.crew_can_contact_client, dispatchPhone },
    // 'daily' → crew clock in once for the day (shift); 'per_job' (default) → per-clean timer.
    _timeMode: tenant?.time_tracking_mode || 'per_job',
    // Crew job board. 'default_crew' (the default) hides the Open jobs tab
    // unless something is actually open; the broadcast modes always show it.
    _assignmentMode: tenant?.assignment_mode || 'default_crew',
    // The business's zone. Every job time and day bucket in the app renders
    // in THIS zone, not the phone's, so the crew and the owner read the same
    // clock for the same clean. Null → fall back to device-local.
    _tz: tenant?.timezone || null,
    // >0 → tenant pays a laundry bonus for at least one destination
    // (home / on-site / office / laundromat); gates the bag counter on cleans.
    _laundryBonus: Math.max(
      Number(tenant?.laundry_takehome_bonus || 0), Number(tenant?.laundry_onsite_bonus || 0),
      Number(tenant?.laundry_office_bonus || 0), Number(tenant?.laundry_laundromat_bonus || 0)),
  }
}

// ── Inner app — hooks called unconditionally here ─────────────────
function AppInner() {
  const insets = useSafeAreaInsets() // ✅ always called, no early returns above it

  const [session, setSession] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState<any>(null)
  const [chatUnread, setChatUnread] = useState(0)
  // Cleans on the crew job board right now, by the same rule as the list on
  // the tab (lib/openJobs.ts). Drives the Open jobs tab badge, and whether
  // the tab shows at all for a company still on default-crew assignment.
  const [openJobsCount, setOpenJobsCount] = useState(0)
  const [activeTab, setActiveTab] = useState('Dashboard')
  const [showSOS, setShowSOS] = useState(false)
  // Mileage or Team today opened full screen from Profile (or Home's Log
  // miles): whichever of the two isn't a tab for this person. My week opens
  // from Home's earnings card when it isn't their tab.
  const [subScreen, setSubScreen] = useState<'mileage' | 'team' | 'week' | null>(null)
  const [activeChannel, setActiveChannel] = useState<any>(null)
  const lastAuthId = useRef<string | null>(null)

  useEffect(() => {
    // Offline-tolerant (src/lib/supabase.ts): with the hour-long token lapsed
    // and no signal, this hands back the stored sign-in instead of null.
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) { lastAuthId.current = session.user.id; loadUser(session.user.id) }
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setSession(session)
        lastAuthId.current = session.user.id; loadUser(session.user.id)
        return
      }
      // No session with this event. SIGNED_OUT is an explicit sign-out or a
      // session the server invalidated. Anything else — INITIAL_SESSION after
      // a token renewal that couldn't reach the server — is a dead zone, not a
      // sign-out: the sign-in is still on the phone, so stay in the app on it.
      // (This event used to send a crew member with an expired token and no
      // signal to the login screen, where nothing can be queued.)
      isSignedOut(_event, session).then((signedOut) => {
        if (!signedOut) return
        setSession(null)
        // Safe to drop the offline profile copy: this is never a network blip.
        if (_event === 'SIGNED_OUT' && lastAuthId.current) { clearCachedProfile(lastAuthId.current); clearDataCache(); clearCarriedPhotos() }
        // Shared devices: don't leave the previous tenant's zone armed for
        // whoever signs in next.
        setCurrentTz(null)
        setUser(null); setLoading(false)
      })
    })
    return () => subscription.unsubscribe()
  }, [])

  async function loadUser(authId: string) {
    // The row the database acts as for this login: the active row whose id is
    // the login, else the active row linked by auth_user_id. Both candidates
    // in one read (RLS shows at most these two); `.maybeSingle()` errored when
    // both were readable and sent us to the offline copy.
    // Named columns, not '*': signed-in users can't SELECT a users row's pay,
    // SSN, bank or address columns (src/lib/userPrivateDetails.ts).
    const { data: rows, error } = await supabase.from('users').select(USERS_READABLE_COLUMNS).or(myUsersRowFilter(authId))
    // any: the profile carries the company settings (_tz, ...) and pay below.
    const data: any = pickMyUsersRow(rows, authId)
    if (data) {
      // The Profile tab's pay card: the person's own pay, kept with the profile
      // so it still shows offline. Only these three fields; nothing else
      // private is stored on the phone. Unreadable now, the card is left out.
      try {
        const pay = await fetchMyPay(data.id)
        if (pay) Object.assign(data, pay)
      } catch (e) { console.warn('Own pay load failed:', e) }
      let settings: CompanySettings | null = null
      try { settings = await companySettings(data.tenant_id) } catch { /* unreadable, same as an error */ }
      if (!settings) {
        // The profile arrived but the company settings didn't (weak signal,
        // timeout). Keep the last good ones instead of guessing: the guesses
        // were a per-job clock for a daily-shift company and every time in the
        // phone's zone, and they overwrote the good offline copy.
        const prev = await loadCachedProfile(authId)
        settings = prev && prev.tenant_id === data.tenant_id ? settingsFrom(prev) : defaultSettings()
      }
      Object.assign(data, settings)
      saveCachedProfile(authId, data)
    }
    // Offline fallback: a fetch ERROR (no signal, server down) is not proof the
    // profile is gone — use the last good copy so a crew member with a valid
    // session isn't bounced to the login screen. Only a clean "no row" answer
    // from the server means the profile really was removed → drop the cache
    // and fall through to login.
    let effective = data
    if (!data) {
      if (error) effective = await loadCachedProfile(authId)
      else clearCachedProfile(authId)
    }
    // Before setUser: the first paint of the dashboard already formats job
    // times, and a late call here would render one frame in the wrong zone.
    setCurrentTz(effective?._tz)
    setUser(effective)
    setLoading(false)
    if (effective) {
      setErrorContext({ tenantId: effective.tenant_id, email: effective.email, role: effective.role })
      registerPushToken(effective).catch(console.warn)
      // Which bundle is this device on? Answers "did this OTA land here".
      reportClientVersion().catch(console.warn)
      startLocationTracking(effective).catch(console.warn)
      // An SOS that outlived the process (app killed, phone rebooted) keeps
      // trailing; one resolved while we were dead clears itself instead.
      // Runs on a cached profile too: a crew member who reopened the app in a
      // dead zone is exactly who should still have a live trail resuming.
      resumeSOSTrailIfOpen().catch(console.warn)
    }
  }

  // Real-time job change listener.
  // INCIDENT NOTE (2026-07-02): the old version listened to ALL tenant job
  // UPDATEs and compared against payload.old — which is PK-only under default
  // replica identity, so every bulk sync update looked like a change and
  // blasted every crew phone with hundreds of "New job assigned" alerts.
  useEffect(() => {
    if (!user) return
    // Belt-and-suspenders: even legitimate bursts (bulk import auto-assigning
    // a big book) must not machine-gun the phone. Max 3 alerts per minute.
    let recentNotifies: number[] = []
    const throttled = () => {
      const now = Date.now()
      recentNotifies = recentNotifies.filter(t => now - t < 60_000)
      if (recentNotifies.length >= 3) return true
      recentNotifies.push(now)
      return false
    }
    const channel = supabase
      .channel('job-changes')
      // "New job assigned" keys off MY assignment row being created — the only
      // signal that actually means this user got a job.
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'job_assignments',
        filter: `user_id=eq.${user.id}`,
      }, () => {
        // A new stop: save it for offline now, not in up to 10 minutes.
        prefetchDays(user, { force: true }).catch(() => {})
        if (throttled()) return
        Notifications.scheduleNotificationAsync({
          content: { title: `✅ ${tStatic('notif_job_assigned_title')}`, body: tStatic('notif_job_assigned_body'), sound: true },
          trigger: null,
        }).catch(console.warn)
      })
      // Reschedule alerts: only when the old value is actually present and
      // differs, and only for jobs THIS user is assigned to. (jobs is currently
      // not in the realtime publication; this arms safely if it returns.)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'jobs',
        filter: `tenant_id=eq.${user.tenant_id}`,
      }, async (payload: any) => {
        const job = payload.new
        const old = payload.old
        if (!old?.scheduled_start || job.scheduled_start === old.scheduled_start) return
        const { data: mine } = await supabase.from('job_assignments')
          .select('id').eq('job_id', job.id).eq('user_id', user.id).limit(1).maybeSingle()
        if (!mine) return
        prefetchDays(user, { force: true }).catch(() => {})
        if (throttled()) return
        const newTime = fmtTime(job.scheduled_start, localeStatic())
        Notifications.scheduleNotificationAsync({
          content: { title: `📅 ${tStatic('notif_job_rescheduled_title')}`, body: ti(tStatic('notif_job_rescheduled_body'), { time: newTime }), sound: true },
          trigger: null,
        }).catch(console.warn)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user])

  // Chat unread badge — a channel is unread when its last_message_at is newer
  // than this user's chat_channel_reads row (same cheap rule the web uses; no
  // message counting). message_channels IS in the realtime publication, and
  // BOTH apps bump last_message_at on send, so one subscription covers all.
  const refreshChatUnread = async () => {
    if (!user) return
    try {
      const [chanRes, readsRes] = await Promise.all([
        supabase.from('message_channels').select('id, channel_type, participant_ids, last_message_at').eq('tenant_id', user.tenant_id),
        supabase.from('chat_channel_reads').select('channel_id, last_read_at').eq('user_id', user.id),
      ])
      const reads = Object.fromEntries((readsRes.data ?? []).map((r: any) => [r.channel_id, r.last_read_at]))
      const mine = (chanRes.data ?? []).filter((c: any) => c.channel_type === 'team' || c.participant_ids?.includes(user.id))
      setChatUnread(mine.filter((c: any) => c.last_message_at && (!reads[c.id] || c.last_message_at > reads[c.id])).length)
    } catch { /* badge is best-effort */ }
  }

  // Open-jobs count — refreshed with the chat badge and on every foreground
  // (the drain below), never on a claim, so the tab doesn't vanish under
  // someone who is standing on it.
  const refreshOpenJobs = async () => {
    if (!user) return
    try {
      // Counted here, not by the database, and by the list's own rule: a
      // clean still offered to another property's crew first
      // (jobs.open_to_all_at) isn't this person's to see, and a clean is open
      // while it has a spot left (max_crew), not just until it is staffed.
      const now = new Date()
      const { data } = await boardQuery(supabase.from('jobs')
        .select('id, status, scheduled_start, max_crew, open_for_claims_at, open_to_all_at, client_addresses!jobs_address_id_fkey(default_crew), job_assignments(user_id)'),
        user.tenant_id, now)
      setOpenJobsCount(boardJobsFor(data ?? [], user.id, now.getTime()).length)
    } catch { /* badge is best-effort */ }
  }

  useEffect(() => {
    if (!user) return
    refreshChatUnread()
    refreshOpenJobs()
    const ch = supabase
      .channel(`chat-unread-${user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'message_channels', filter: `tenant_id=eq.${user.tenant_id}` }, () => { refreshChatUnread() })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [user?.id])

  function openChatChannel(ch: any) {
    setActiveChannel(ch)
    if (user) {
      supabase.from('chat_channel_reads').upsert(
        { tenant_id: user.tenant_id, channel_id: ch.id, user_id: user.id, last_read_at: new Date().toISOString() },
        { onConflict: 'channel_id,user_id' },
      ).then(() => refreshChatUnread())
    }
  }

  // Drain offline work — once on login, and every time the app returns to the
  // foreground (e.g. crew regains signal and reopens the app). Photos first,
  // then the write outbox, so a queued completion never lands ahead of the
  // photos that satisfy its checklist.
  useEffect(() => {
    if (!user) return
    // Incident heads-ups last: they wait for the report (outbox) and its photos
    // (queue) to have landed.
    // Walkthrough videos drain on their own, alongside: one can take many
    // minutes on a weak bar, and nothing in the chain below should wait on it.
    // `pack`: also refresh the offline day pack (lib/offlinePrefetch) once the
    // queued writes are in — on login and on every return to the foreground,
    // not on the 2-minute timer (the pack keeps its own 10-minute pace).
    const drain = (pack = false) => {
      refreshOpenJobs()
      // An SOS goes first and on its own: it must never wait behind a photo
      // upload that can take minutes on one bar.
      flushSOSQueue().catch(() => {})
      flushVideoQueue().catch(() => {})
      flushQueue().catch(() => {}).then(() => flushOutbox()).catch(() => {}).then(() => flushIncidentNotifies()).catch(() => {})
        .then(() => { if (pack) return prefetchDays(user) }).catch(() => {})
    }
    drain(true)
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        drain(true)
        // Back from Settings, maybe with location changed: the Team page shows it.
        reportLocationSetting().catch(() => {})
      }
    })
    // Also retry while the app simply stays open: a crew driving back into
    // coverage with the app on screen never backgrounds it, so the foreground
    // trigger alone left photos waiting. Both drains are cheap no-ops when
    // nothing is queued, and flushQueue ignores overlapping calls.
    const iv = setInterval(() => { if (AppState.currentState === 'active') drain() }, 120_000)
    // Queued writes just synced: the phone is back on signal.
    const offDrained = onOutboxDrained(() => { prefetchDays(user).catch(() => {}) })
    return () => { sub.remove(); clearInterval(iv); offDrained() }
  }, [user])

  // A queued Complete waits for its clean's photos (lib/outbox), unless the
  // server keeps refusing one: then it is sent anyway and the crew is told,
  // as JobDetailScreen tells them at Complete when it is online.
  const { t } = useLang()
  const tRef = useRef(t)
  tRef.current = t
  useEffect(() => onCompletePastRefusedPhotos(({ error }) => {
    Alert.alert(`⚠️ ${tRef.current('photo_upload_failing_title')}`, ti(tRef.current('photo_complete_sent_failing_msg'), { error: error || '?' }))
  }), [])

  // The office assigned this phone a clean (notify-crew-assigned, data.type
  // 'job_assigned'): save the day for offline now, whether the push arrives
  // with the app open or is tapped. They dispatch the night before, while
  // phones are on home Wi-Fi.
  useEffect(() => {
    if (!user) return
    const onPush = (data: any) => { if (isDayChangePush(data)) prefetchDays(user, { force: true }).catch(() => {}) }
    const received = Notifications.addNotificationReceivedListener(n => onPush(n.request.content.data))
    const tapped = Notifications.addNotificationResponseReceivedListener(r => onPush(r.notification.request.content.data))
    return () => { received.remove(); tapped.remove() }
  }, [user])

  // A tapped crew job push (job_assigned, job_reminder) opens its job, or the
  // Schedule tab when the job can't be had; over a full screen it waits until
  // the tabs are back (lib/pushTap). The tap that launched the app is waiting
  // in getLastNotificationResponse(); the listener hands over each one while
  // it runs (the two can repeat a tap: the ledger takes each once).
  // useLastNotificationResponse() does the same, but throws on web.
  const [lastResponse, setLastResponse] = useState<Notifications.NotificationResponse | null>(null)
  useEffect(() => {
    try { const r = Notifications.getLastNotificationResponse(); if (r) setLastResponse(r) } catch { /* web: no taps */ }
    const sub = Notifications.addNotificationResponseReceivedListener(r => setLastResponse(r))
    return () => sub.remove()
  }, [])
  const screenRef = useRef(onScreen({ selectedJob, activeChannel, showSOS, subScreen }))
  screenRef.current = onScreen({ selectedJob, activeChannel, showSOS, subScreen })
  const userRef = useRef(user)
  userRef.current = user
  // A tab asked for before the navigator is up (a cold start) waits for onReady.
  const pendingTab = useRef<string | null>(null)
  const tapRef = useRef<ReturnType<typeof tapRouter> | null>(null)
  if (!tapRef.current) {
    tapRef.current = tapRouter({
      screen: () => screenRef.current,
      load: (jobId) => loadTappedJob(jobId, userRef.current, tapIO(userRef.current)),
      openJob: (job) => setSelectedJob(job),
      openSchedule: () => {
        pendingTab.current = 'Schedule'
        if (navigationRef.isReady()) { pendingTab.current = null; navigationRef.navigate('Schedule') }
      },
    })
  }

  useEffect(() => {
    if (!user || !lastResponse) return
    if (lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    const jobId = tappedJobId(lastResponse.notification.request.content.data, user.tenant_id)
    if (!jobId) return
    taps.first(lastResponse.notification.request.identifier).then(first => {
      if (!first) return
      try { Notifications.clearLastNotificationResponse() } catch { /* not on this platform */ }
      tapRef.current?.tap(jobId)
    })
  }, [lastResponse, user?.id])

  // A report the office sent back (notify-incident-send-back, data.type
  // 'incident_sent_back', no job to open) opens Home, where its "Sent back to
  // you" card is. The job tap above returns early for it.
  useEffect(() => {
    if (!user || !lastResponse) return
    if (lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    if ((lastResponse.notification.request.content.data as any)?.type !== 'incident_sent_back') return
    taps.first(lastResponse.notification.request.identifier).then(first => {
      if (!first) return
      try { Notifications.clearLastNotificationResponse() } catch { /* not on this platform */ }
      if (navigationRef.isReady()) navigationRef.navigate('Dashboard')
      else pendingTab.current = 'Dashboard'
    })
  }, [lastResponse, user?.id])

  // Back on the tabs: a tap that waited opens now.
  useEffect(() => {
    if (user) tapRef.current?.screenChanged()
  }, [user?.id, selectedJob?.id, activeChannel, showSOS, subScreen])

  // An SOS this phone never got to the server (app killed in a dead zone, dead
  // battery) reopens its screen at launch, so the crew member sees it still
  // hasn't gone and the screen's fast retry takes over from the drain.
  useEffect(() => {
    if (!user) return
    resumableSOS(user.id).then(open => { if (open) setShowSOS(true) }).catch(() => {})
  }, [user?.id])

  if (loading) {
    return (
      <View style={styles.loading}>
        <Image source={require('./assets/logo-horizontal-dark.png')} style={styles.logo} resizeMode="contain" accessibilityLabel="Rinsebase" />
        <ActivityIndicator color={GOLD} style={{ marginTop: 28 }} />
      </View>
    )
  }

  if (!session || !user) {
    return <LoginScreen />
  }

  if (activeChannel) {
    return <ChatScreen channel={activeChannel} user={user} onBack={() => { setActiveChannel(null); refreshChatUnread() }} />
  }

  if (showSOS) {
    return <SOSScreen user={user} onCancel={() => setShowSOS(false)} onSent={() => {}} />
  }

  if (subScreen === 'mileage') {
    return <MileageScreen user={user} onBack={() => setSubScreen(null)} />
  }

  if (subScreen === 'team') {
    return <TeamTodayScreen user={user} onBack={() => setSubScreen(null)} />
  }

  if (subScreen === 'week') {
    return <MyWeekScreen user={user} onBack={() => setSubScreen(null)} />
  }

  if (selectedJob) {
    return (
      <JobDetailScreen
        job={selectedJob}
        user={user}
        onBack={() => setSelectedJob(null)}
        onStatusChange={(job: any, status: string) => setSelectedJob((prev: any) => prev ? { ...prev, status } : null)}
      />
    )
  }

  // The office of a day-shift company gets the day's clock roster in Mileage's
  // slot, and its crew get My week there; either way Mileage moves under
  // Profile (lib/teamDay). Crew never see Team.
  const teamTab = teamTabReplacesMileage(user)
  const weekTab = weekTabReplacesMileage(user)
  const mileageAside = teamTab || weekTab

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => { const tab = pendingTab.current; if (tab) { pendingTab.current = null; navigationRef.navigate(tab) } }}
    >
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: SLATE_DARK,
            borderTopColor: 'rgba(255,255,255,0.08)',
            paddingBottom: insets.bottom + 8,
            paddingTop: 10,
            height: 60 + insets.bottom,
          },
          tabBarActiveTintColor: GOLD,
          tabBarInactiveTintColor: 'rgba(255,255,255,0.35)',
          tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginTop: 2 },
        }}
      >
        <Tab.Screen
          name="Dashboard"
          options={{ tabBarLabel: t('tab_home'), tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>⊞</Text> }}
        >
          {({ navigation }: any) => (
            <DashboardScreen
              key={user?.id}
              user={user}
              onJobPress={setSelectedJob}
              onNavigate={(screen: string) => {
                // No Mileage tab at a day-shift company: Log miles opens it full screen.
                if (screen === 'mileage' && mileageAside) { setSubScreen('mileage'); return }
                // The earnings card goes to the Pay tab where there is one.
                if (screen === 'week' && !weekTab) { setSubScreen('week'); return }
                const tabMap: Record<string, string> = { dashboard: 'Dashboard', jobs: 'Schedule', schedule: 'Schedule', mileage: 'Mileage', week: 'Week', profile: 'Profile' }
                if (tabMap[screen]) navigation.navigate(tabMap[screen])
              }}
              onSOS={() => setShowSOS(true)}
            />
          )}
        </Tab.Screen>

        <Tab.Screen
          name="Schedule"
          options={{ tabBarLabel: t('schedule'), tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>📅</Text> }}
        >
          {() => <ScheduleScreen key={user?.id} user={user} onJobPress={setSelectedJob} />}
        </Tab.Screen>

        {/* Crew job board. Always there for companies that broadcast cleans;
            for everyone else it appears only while something is open (an
            owner can open a single clean from the job panel in any mode). */}
        {(user._assignmentMode !== 'default_crew' || openJobsCount > 0) && (
          <Tab.Screen
            name="OpenJobs"
            options={{
              tabBarLabel: t('open_jobs_tab'),
              tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>🙋</Text>,
              tabBarBadge: openJobsCount > 0 ? (openJobsCount > 9 ? '9+' : openJobsCount) : undefined,
              tabBarBadgeStyle: { backgroundColor: GOLD, color: SLATE_DARK, fontSize: 10, fontWeight: '800' },
            }}
          >
            {() => <OpenJobsScreen key={user?.id} user={user} onJobPress={setSelectedJob} />}
          </Tab.Screen>
        )}

        {teamTab ? (
          <Tab.Screen
            name="Team"
            options={{ tabBarLabel: t('team_tab'), tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>👥</Text> }}
          >
            {({ navigation }: any) => <TeamTodayScreen key={user?.id} user={user} navigation={navigation} />}
          </Tab.Screen>
        ) : weekTab ? (
          <Tab.Screen
            name="Week"
            options={{ tabBarLabel: t('tab_pay'), tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>💰</Text> }}
          >
            {({ navigation }: any) => <MyWeekScreen key={user?.id} user={user} navigation={navigation} />}
          </Tab.Screen>
        ) : (
          <Tab.Screen
            name="Mileage"
            options={{ tabBarLabel: t('tab_mileage'), tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>↗</Text> }}
          >
            {() => <MileageScreen key={user?.id} user={user} />}
          </Tab.Screen>
        )}

        <Tab.Screen
          name="Chat"
          options={{
            tabBarLabel: t('tab_chat'),
            tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>💬</Text>,
            tabBarBadge: chatUnread > 0 ? (chatUnread > 9 ? '9+' : chatUnread) : undefined,
            tabBarBadgeStyle: { backgroundColor: '#EF4444', color: '#fff', fontSize: 10, fontWeight: '800' },
          }}
        >
          {() => <ChatListScreen user={user} onOpenChannel={openChatChannel} onNewDM={() => {}} />}
        </Tab.Screen>

        <Tab.Screen
          name="Profile"
          options={{ tabBarLabel: t('profile'), tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>◉</Text> }}
        >
          {() => (
            <ProfileScreen
              key={user?.id}
              user={user}
              onOpenMileage={mileageAside ? () => setSubScreen('mileage') : undefined}
              onOpenTeam={!teamTab && canSeeTeam(user.role) ? () => setSubScreen('team') : undefined}
            />
          )}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  )
}

// ── Root — providers wrap everything once ─────────────────────────
function App() {
  return (
    <ErrorBoundary>
      <LangProvider>
        <SafeAreaProvider>
          <AppInner />
        </SafeAreaProvider>
      </LangProvider>
    </ErrorBoundary>
  )
}

// Sentry.wrap adds native crash + performance instrumentation around the app.
export default Sentry.wrap(App)

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: SLATE_DARK, alignItems: 'center', justifyContent: 'center' },
  // The horizontal brand logo (light-on-dark variant of the website's
  // horizontal_logo_dark), rendered 1500x321 so it stays sharp at 3x.
  logo: { width: 260, height: 260 * 321 / 1500 },
})
