import React, { useState, useEffect } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { NavigationContainer } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { supabase } from './src/lib/supabase'
import { LoginScreen } from './src/screens/LoginScreen'
import { DashboardScreen } from './src/screens/DashboardScreen'
import { TodayScreen } from './src/screens/TodayScreen'
import { ScheduleScreen } from './src/screens/ScheduleScreen'
import { MileageScreen } from './src/screens/MileageScreen'
import { ProfileScreen } from './src/screens/ProfileScreen'
import { JobDetailScreen } from './src/screens/JobDetailScreen'
import { SOSScreen } from './src/screens/SOSScreen'
import { registerPushToken } from './src/lib/notifications'
import { LangProvider } from './src/contexts/LangContext'

const TEAL = '#00C9A7'
const NAVY = '#0A1628'
const Tab = createBottomTabNavigator()

export default function App() {
  const [session, setSession] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState<any>(null)
  const [activeTab, setActiveTab] = useState('Dashboard')
  const [showSOS, setShowSOS] = useState(false)

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

  function handleNavigate(screen: string) {
    const tabMap: Record<string, string> = {
      dashboard: 'Dashboard',
      jobs: 'Today',
      schedule: 'Schedule',
      mileage: 'Mileage',
      profile: 'Profile',
    }
    if (tabMap[screen]) setActiveTab(tabMap[screen])
  }

  if (loading) {
    return (
      <View style={styles.loading}>
        <View style={styles.logo}><Text style={styles.logoText}>RB</Text></View>
        <ActivityIndicator color={TEAL} style={{ marginTop: 24 }} />
      </View>
    )
  }

  if (!session || !user) {
    return <LangProvider><SafeAreaProvider><LoginScreen /></SafeAreaProvider></LangProvider>
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
            tabBarStyle: { backgroundColor: NAVY, borderTopColor: 'rgba(255,255,255,0.08)', paddingBottom: 16, height: 80 },
            tabBarActiveTintColor: TEAL,
            tabBarInactiveTintColor: 'rgba(255,255,255,0.35)',
            tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginTop: 2 },
          }}
        >
          <Tab.Screen
            name="Dashboard"
            options={{ tabBarLabel: 'Home', tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>⊞</Text> }}
          >
            {() => <DashboardScreen key={user?.id} user={user} onJobPress={setSelectedJob} onNavigate={handleNavigate} onSOS={() => setShowSOS(true)} />}
          </Tab.Screen>

          <Tab.Screen
            name="Today"
            options={{ tabBarLabel: "Today", tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>☀</Text> }}
          >
            {() => <TodayScreen key={user?.id} user={user} onJobPress={setSelectedJob} />}
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
  loading: { flex: 1, backgroundColor: NAVY, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 72, height: 72, borderRadius: 20, backgroundColor: TEAL, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontSize: 28, fontWeight: '800' },
})
