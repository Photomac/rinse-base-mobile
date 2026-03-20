import React, { useState, useEffect, useRef } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
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
import * as Notifications from 'expo-notifications'
import { LangProvider } from './src/contexts/LangContext'

const GOLD = '#D4A843'
const SLATE_DARK = '#0F172A'
const Tab = createBottomTabNavigator()

export default function App() {
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
    setUser(data)
    setLoading(false)
    if (data) registerPushToken(data).catch(console.warn)
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
        // Notify crew if their job was rescheduled
        if (job.scheduled_start !== old.scheduled_start) {
          const newTime = new Date(job.scheduled_start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          Notifications.scheduleNotificationAsync({
            content: {
              title: '📅 Job rescheduled',
              body: `Your job has been moved to ${newTime}`,
              sound: true,
            },
            trigger: null,
          }).catch(console.warn)
        }
        // Notify if job was assigned to this user
        if (job.status === 'scheduled' && old.status !== 'scheduled') {
          Notifications.scheduleNotificationAsync({
            content: {
              title: '✅ New job assigned',
              body: `You have a new job scheduled`,
              sound: true,
            },
            trigger: null,
          }).catch(console.warn)
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user])

  function handleNavigate(screen: string) {
    const tabMap: Record<string, string> = {
      dashboard: 'Dashboard',
      jobs: 'Today',
      schedule: 'Schedule',
      mileage: 'Mileage',
      profile: 'Profile',
    }
    if (tabMap[screen] && navigationRef.current) {
      navigationRef.current.navigate(tabMap[screen])
    }
  }

  if (loading) {
    return (
      <View style={styles.loading}>
        <View style={styles.logo}><Text style={styles.logoText}>RB</Text></View>
        <ActivityIndicator color={GOLD} style={{ marginTop: 24 }} />
      </View>
    )
  }

  if (!session || !user) {
    return <LangProvider><SafeAreaProvider><LoginScreen /></SafeAreaProvider></LangProvider>
  }

  if (activeChannel) {
    return (
      <LangProvider>
      <SafeAreaProvider>
        <ChatScreen channel={activeChannel} user={user} onBack={() => setActiveChannel(null)} />
      </SafeAreaProvider>
      </LangProvider>
    )
  }

  if (showSOS) {
    return (
      <LangProvider><SafeAreaProvider>
        <SOSScreen
          user={user}
          onCancel={() => setShowSOS(false)}
          onSent={() => {}}
        />
      </SafeAreaProvider></LangProvider>
    )
  }

  if (selectedJob) {
    return (
      <LangProvider><SafeAreaProvider>
        <JobDetailScreen
          job={selectedJob}
          user={user}
          onBack={() => setSelectedJob(null)}
          onStatusChange={(job: any, status: string) => setSelectedJob((prev: any) => prev ? { ...prev, status } : null)}
        />
      </SafeAreaProvider></LangProvider>
    )
  }

  return (
    <LangProvider>
    <SafeAreaProvider>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarStyle: { backgroundColor: SLATE_DARK, borderTopColor: 'rgba(255,255,255,0.08)', paddingBottom: 20, paddingTop: 8, height: 88 },
            tabBarActiveTintColor: GOLD,
            tabBarInactiveTintColor: 'rgba(255,255,255,0.35)',
            tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginTop: 2 },
          }}
        >
          <Tab.Screen
            name="Dashboard"
            options={{ tabBarLabel: 'Home', tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>⊞</Text> }}
          >
            {({ navigation }: any) => <DashboardScreen key={user?.id} user={user} onJobPress={setSelectedJob} onNavigate={(screen: string) => {
              const tabMap: Record<string, string> = { dashboard: 'Dashboard', jobs: 'Today', schedule: 'Schedule', mileage: 'Mileage', profile: 'Profile' }
              if (tabMap[screen]) navigation.navigate(tabMap[screen])
            }} onSOS={() => setShowSOS(true)} />}
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
    </SafeAreaProvider>
    </LangProvider>
  )
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: SLATE_DARK, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 72, height: 72, borderRadius: 20, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontSize: 28, fontWeight: '800' },
})
