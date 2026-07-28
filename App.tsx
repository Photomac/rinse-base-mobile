import { Sentry } from './src/lib/sentry' // first: initializes Sentry before anything else
import React, { useState, useEffect, useRef } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, AppState } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { NavigationContainer } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { supabase } from './src/lib/supabase'
import { LoginScreen } from './src/screens/LoginScreen'
import { DashboardScreen } from './src/screens/DashboardScreen'
import { ScheduleScreen } from './src/screens/ScheduleScreen'
import { MileageScreen } from './src/screens/MileageScreen'
import { ProfileScreen } from './src/screens/ProfileScreen'
import { JobDetailScreen } from './src/screens/JobDetailScreen'
import { SOSScreen } from './src/screens/SOSScreen'
import { ChatListScreen, ChatScreen } from './src/screens/ChatScreens'
import { registerPushToken } from './src/lib/notifications'
import { startLocationTracking, stopLocationTracking } from './src/lib/locationTracker'
// Side-effect import: registers the arrival-geofence TaskManager task at bundle
// eval so headless OS launches (region crossings) find the handler.
import './src/lib/arrivalGeofence'
import { flushQueue } from './src/lib/photoQueue'
import { saveCachedProfile, loadCachedProfile, clearCachedProfile } from './src/lib/profileCache'
import { clearDataCache } from './src/lib/dataCache'
import * as Notifications from 'expo-notifications'
import { LangProvider } from './src/contexts/LangContext'
import { initErrorReporting, setErrorContext } from './src/lib/errorReporter'
import { ErrorBoundary } from './src/components/ErrorBoundary'

const GOLD = '#D4A843'
const SLATE_DARK = '#0F172A'
const Tab = createBottomTabNavigator()

// Capture uncaught mobile errors into admin_error_log (admin System Health).
initErrorReporting()

// ── Inner app — hooks called unconditionally here ─────────────────
function AppInner() {
  const insets = useSafeAreaInsets() // ✅ always called, no early returns above it

  const [session, setSession] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState<any>(null)
  const [chatUnread, setChatUnread] = useState(0)
  const [activeTab, setActiveTab] = useState('Dashboard')
  const [showSOS, setShowSOS] = useState(false)
  const [activeChannel, setActiveChannel] = useState<any>(null)
  const navigationRef = useRef<any>(null)
  const lastAuthId = useRef<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) { lastAuthId.current = session.user.id; loadUser(session.user.id) }
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) { lastAuthId.current = session.user.id; loadUser(session.user.id) }
      else {
        // SIGNED_OUT is explicit sign-out or a server-invalidated session —
        // never a network blip (those are retried without an event) — so it's
        // safe to drop the offline profile copy here.
        if (_event === 'SIGNED_OUT' && lastAuthId.current) { clearCachedProfile(lastAuthId.current); clearDataCache() }
        setUser(null); setLoading(false)
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function loadUser(authId: string) {
    const { data, error } = await supabase.from('users').select('*').or(`auth_user_id.eq.${authId},id.eq.${authId}`).maybeSingle()
    if (data) {
      // Crew→client contact policy. Default: crew can't call the host directly
      // (the cleaning company owns that relationship) — they reach dispatch.
      try {
        const { data: tenant } = await supabase.from('tenants')
          .select('crew_can_contact_client, dispatch_phone, time_tracking_mode, laundry_takehome_bonus, laundry_onsite_bonus, laundry_office_bonus, laundry_laundromat_bonus').eq('id', data.tenant_id).maybeSingle()
        let dispatchPhone = tenant?.dispatch_phone || null
        if (!dispatchPhone) {
          const { data: owner } = await supabase.from('users')
            .select('phone').eq('tenant_id', data.tenant_id).eq('role', 'owner')
            .not('phone', 'is', null).limit(1).maybeSingle()
          dispatchPhone = owner?.phone || null
        }
        data._contact = { crewCanContactClient: !!tenant?.crew_can_contact_client, dispatchPhone }
        // 'daily' → crew clock in once for the day (shift); 'per_job' (default) → per-clean timer.
        data._timeMode = tenant?.time_tracking_mode || 'per_job'
        // >0 → tenant pays a laundry bonus for at least one destination
        // (home / on-site / office / laundromat); gates the bag counter on cleans.
        data._laundryBonus = Math.max(
          Number(tenant?.laundry_takehome_bonus || 0), Number(tenant?.laundry_onsite_bonus || 0),
          Number(tenant?.laundry_office_bonus || 0), Number(tenant?.laundry_laundromat_bonus || 0))
      } catch (e) { data._contact = { crewCanContactClient: false, dispatchPhone: null }; data._timeMode = 'per_job'; data._laundryBonus = 0 }
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
    setUser(effective)
    setLoading(false)
    if (effective) {
      setErrorContext({ tenantId: effective.tenant_id, email: effective.email, role: effective.role })
      registerPushToken(effective).catch(console.warn)
      startLocationTracking(effective).catch(console.warn)
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
        if (throttled()) return
        Notifications.scheduleNotificationAsync({
          content: { title: '✅ New job assigned', body: `You have a new job scheduled`, sound: true },
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
        if (!mine || throttled()) return
        const newTime = new Date(job.scheduled_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        Notifications.scheduleNotificationAsync({
          content: { title: '📅 Job rescheduled', body: `Your job has been moved to ${newTime}`, sound: true },
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

  useEffect(() => {
    if (!user) return
    refreshChatUnread()
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

  // Drain any photos captured offline — once on login, and every time the app
  // returns to the foreground (e.g. crew regains signal and reopens the app).
  useEffect(() => {
    if (!user) return
    flushQueue().catch(() => {})
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') flushQueue().catch(() => {})
    })
    return () => sub.remove()
  }, [user])

  if (loading) {
    return (
      <View style={styles.loading}>
        <View style={styles.logo}><Text style={styles.logoText}>RB</Text></View>
        <ActivityIndicator color={GOLD} style={{ marginTop: 24 }} />
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

  return (
    <NavigationContainer>
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
          options={{ tabBarLabel: 'Home', tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>⊞</Text> }}
        >
          {({ navigation }: any) => (
            <DashboardScreen
              key={user?.id}
              user={user}
              onJobPress={setSelectedJob}
              onNavigate={(screen: string) => {
                const tabMap: Record<string, string> = { dashboard: 'Dashboard', jobs: 'Schedule', schedule: 'Schedule', mileage: 'Mileage', profile: 'Profile' }
                if (tabMap[screen]) navigation.navigate(tabMap[screen])
              }}
              onSOS={() => setShowSOS(true)}
            />
          )}
        </Tab.Screen>

        <Tab.Screen
          name="Schedule"
          options={{ tabBarLabel: 'Schedule', tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>📅</Text> }}
        >
          {() => <ScheduleScreen key={user?.id} user={user} onJobPress={setSelectedJob} />}
        </Tab.Screen>

        <Tab.Screen
          name="Mileage"
          options={{ tabBarLabel: 'Mileage', tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>↗</Text> }}
        >
          {() => <MileageScreen key={user?.id} user={user} />}
        </Tab.Screen>

        <Tab.Screen
          name="Chat"
          options={{
            tabBarLabel: 'Chat',
            tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>💬</Text>,
            tabBarBadge: chatUnread > 0 ? (chatUnread > 9 ? '9+' : chatUnread) : undefined,
            tabBarBadgeStyle: { backgroundColor: '#EF4444', color: '#fff', fontSize: 10, fontWeight: '800' },
          }}
        >
          {() => <ChatListScreen user={user} onOpenChannel={openChatChannel} onNewDM={() => {}} />}
        </Tab.Screen>

        <Tab.Screen
          name="Profile"
          options={{ tabBarLabel: 'Profile', tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>◉</Text> }}
        >
          {() => <ProfileScreen key={user?.id} user={user} />}
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
  logo: { width: 72, height: 72, borderRadius: 20, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontSize: 28, fontWeight: '800' },
})
