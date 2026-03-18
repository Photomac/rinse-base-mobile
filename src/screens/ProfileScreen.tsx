import React from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'

const TEAL = '#00C9A7'
const NAVY = '#0A1628'

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner', manager: 'Manager', dispatcher: 'Dispatcher',
  lead_cleaner: 'Lead Cleaner', cleaner: 'Cleaner', trainee: 'Trainee',
}

export function ProfileScreen({ user }: { user: any }) {
  const initials = user.full_name?.split(' ').map((n: string) => n[0]).join('').slice(0,2).toUpperCase() || '?'
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}><Text style={styles.headerTitle}>◉ Profile</Text></View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.avatarSection}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
          <Text style={styles.name}>{user.full_name}</Text>
          <View style={styles.roleBadge}><Text style={styles.roleText}>{ROLE_LABELS[user.role] || user.role}</Text></View>
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Contact info</Text>
          {[['Email', user.email], ['Phone', user.phone || 'Not set']].map(([l, v]) => (
            <View key={l} style={styles.row}>
              <Text style={styles.rowLabel}>{l}</Text>
              <Text style={styles.rowValue}>{v}</Text>
            </View>
          ))}
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Pay structure</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Pay type</Text>
            <Text style={styles.rowValue}>{user.pay_type === 'hourly' ? 'Hourly' : user.pay_type === 'per_job' ? 'Per job' : 'Hourly + turnover'}</Text>
          </View>
          {user.hourly_rate && <View style={styles.row}><Text style={styles.rowLabel}>Hourly rate</Text><Text style={styles.rowValue}>${Number(user.hourly_rate).toFixed(2)}/hr</Text></View>}
          {user.per_job_rate && <View style={styles.row}><Text style={styles.rowLabel}>Per job rate</Text><Text style={styles.rowValue}>${Number(user.per_job_rate).toFixed(2)}/job</Text></View>}
        </View>
        <TouchableOpacity style={styles.signOutBtn} onPress={() => Alert.alert('Sign out', 'Are you sure?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => supabase.auth.signOut() }])}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, padding: 20 },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  scroll: { padding: 16, paddingBottom: 40 },
  avatarSection: { alignItems: 'center', marginBottom: 20, marginTop: 8 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: TEAL, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarText: { color: '#fff', fontSize: 28, fontWeight: '800' },
  name: { fontSize: 22, fontWeight: '800', color: '#111827', marginBottom: 8 },
  roleBadge: { backgroundColor: '#F3F4F6', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
  roleText: { fontSize: 12, color: '#6B7280', fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, borderWidth: 1, borderColor: '#F3F4F6' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#374151', marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F9FAFB' },
  rowLabel: { fontSize: 13, color: '#9CA3AF' },
  rowValue: { fontSize: 13, color: '#111827', fontWeight: '500' },
  signOutBtn: { backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FECACA', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  signOutText: { color: '#DC2626', fontSize: 15, fontWeight: '700' },
})
