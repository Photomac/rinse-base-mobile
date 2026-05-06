import React, { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, StatusBar, Image } from 'react-native'
import { supabase } from '../lib/supabase'
import { SLATE_DARK, GOLD } from '../lib/theme'
import { useLang } from '../contexts/LangContext'

export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { t } = useLang()

  async function handleLogin() {
    if (!email || !password) { Alert.alert(t('login_failed'), !email ? t('enter_email') : t('enter_password')); return }
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) Alert.alert(t('login_failed'), error.message)
    setLoading(false)
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <StatusBar barStyle="light-content" />
      <View style={styles.logoSection}>
        <Image source={require('../../assets/icon.png')} style={styles.logoMark} />
        <Text style={styles.appName}>Rinsebase</Text>
        <Text style={styles.tagline}>{t('tagline')}</Text>
      </View>
      <View style={styles.form}>
        <Text style={styles.label}>{t('email')}</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder={t('email_placeholder')} placeholderTextColor="rgba(255,255,255,0.3)" autoCapitalize="none" keyboardType="email-address" />
        <Text style={styles.label}>{t('password')}</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder={t('password_placeholder')} placeholderTextColor="rgba(255,255,255,0.3)" secureTextEntry />
        <TouchableOpacity style={[styles.button, loading && { opacity: 0.6 }]} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{t('sign_in')} →</Text>}
        </TouchableOpacity>
        <Text style={styles.helpText}>{t('contact_manager')}</Text>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SLATE_DARK, paddingHorizontal: 24, justifyContent: 'center' },
  logoSection: { alignItems: 'center', marginBottom: 48 },
  logoMark: { width: 88, height: 88, borderRadius: 22, marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 20 },

  appName: { color: '#fff', fontSize: 28, fontWeight: '800', marginBottom: 6 },
  tagline: { color: 'rgba(255,255,255,0.4)', fontSize: 13 },
  form: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 20, padding: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  label: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, padding: 14, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  button: { backgroundColor: GOLD, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  helpText: { color: 'rgba(255,255,255,0.3)', fontSize: 11, textAlign: 'center', marginTop: 16 },
})
