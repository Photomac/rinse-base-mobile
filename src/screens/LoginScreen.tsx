import React, { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, StatusBar } from 'react-native'
import { supabase } from '../lib/supabase'

const TEAL = '#00C9A7'
const NAVY = '#0A1628'

export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin() {
    if (!email || !password) { Alert.alert('Error', 'Please enter your email and password'); return }
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) Alert.alert('Login failed', error.message)
    setLoading(false)
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <StatusBar barStyle="light-content" />
      <View style={styles.logoSection}>
        <View style={styles.logoMark}><Text style={styles.logoText}>RB</Text></View>
        <Text style={styles.appName}>Rinsebase</Text>
        <Text style={styles.tagline}>Professional cleaning management</Text>
      </View>
      <View style={styles.form}>
        <Text style={styles.label}>Email</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="you@email.com" placeholderTextColor="#9CA3AF" autoCapitalize="none" keyboardType="email-address" />
        <Text style={styles.label}>Password</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Your password" placeholderTextColor="#9CA3AF" secureTextEntry />
        <TouchableOpacity style={[styles.button, loading && { opacity: 0.6 }]} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in →</Text>}
        </TouchableOpacity>
        <Text style={styles.helpText}>Contact your manager if you need help logging in</Text>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: NAVY, paddingHorizontal: 24, justifyContent: 'center' },
  logoSection: { alignItems: 'center', marginBottom: 48 },
  logoMark: { width: 72, height: 72, borderRadius: 20, backgroundColor: TEAL, alignItems: 'center', justifyContent: 'center', marginBottom: 16, shadowColor: TEAL, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16 },
  logoText: { color: '#fff', fontSize: 28, fontWeight: '800' },
  appName: { color: '#fff', fontSize: 28, fontWeight: '800', marginBottom: 6 },
  tagline: { color: 'rgba(255,255,255,0.4)', fontSize: 13 },
  form: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 20, padding: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  label: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, padding: 14, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  button: { backgroundColor: TEAL, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  helpText: { color: 'rgba(255,255,255,0.3)', fontSize: 11, textAlign: 'center', marginTop: 16 },
})
