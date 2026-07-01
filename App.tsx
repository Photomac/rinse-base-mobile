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
import { flushQueue } from './src/lib/photoQueue'
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
  const [activeTab, setActiveTab] = useState('Dashboard')
  const [showSOS, setShowSOS] = useState(false)
  const [activeChannel, setActiveChannel] = useState<any>(null)
  const navigationRef = useRef<any>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadUser(session.user.id)
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) loadUser(session.user.id)
      else { setUser(null); setLoading(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function loadUser(authId: string) {
    const { data } = await supabase.from('users').select('*').or(`auth_user_id.eq.${authId},id.eq.${authId}`).maybeSingle()
    if (data) {
      // Crew→client contact policy. Default: crew can't call the host directly
      // (the cleaning company owns that relationship) — they reach dispatch.
      try {
        const { data: tenant } = await supabase.from('tenants')
          .select('crew_can_contact_client, dispatch_phone, time_tracking_mode').eq('id', data.tenant_id).maybeSingle()
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
      } catch (e) { data._contact = { crewCanContactClient: false, dispatchPhone: null }; data._timeMode = 'per_job' }
    }
    setUser(data)
    setLoading(false)
    if (data) {
      setErrorContext({ tenantId: data.tenant_id, email: data.email, role: data.role })
      registerPushToken(data).catch(console.warn)
      startLocationTracking(data).catch(console.warn)
    }
  }

  // Real-time job change listener
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel('job-changes')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'jobs',
        filter: `tenant_id=eq.${user.tenant_id}`,
      }, (payload: any) => {
        const job = payload.new
        const old = payload.old
        if (job.scheduled_start !== old.scheduled_start) {
          const newTime = new Date(job.scheduled_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          Notifications.scheduleNotificationAsync({
            content: { title: '📅 Job rescheduled', body: `Your job has been moved to ${newTime}`, sound: true },
            trigger: null,
          }).catch(console.warn)
        }
        if (job.status === 'scheduled' && old.status !== 'scheduled') {
          Notifications.scheduleNotificationAsync({
            content: { title: '✅ New job assigned', body: `You have a new job scheduled`, sound: true },
            trigger: null,
          }).catch(console.warn)
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user])

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
    return <ChatScreen channel={activeChannel} user={user} onBack={() => setActiveChannel(null)} />
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
          options={{ tabBarLabel: 'Chat', tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>💬</Text> }}
        >
          {() => <ChatListScreen user={user} onOpenChannel={setActiveChannel} onNewDM={() => {}} />}
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
