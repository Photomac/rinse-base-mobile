import React, { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, StatusBar, Image } from 'react-native'
import { supabase } from '../lib/supabase'
import { SLATE_DARK, GOLD, SURFACE, CARD, BORDER, TEXT, TEXT_MUTED, TEXT_LIGHT } from '../lib/theme'
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
      <StatusBar barStyle="dark-content" />
      <View style={styles.logoSection}>
        <Image source={require('../../assets/icon.png')} style={styles.logoMark} />
        <Text style={styles.appName}>Rinsebase</Text>
        <Text style={styles.tagline}>{t('tagline')}</Text>
      </View>
      <View style={styles.form}>
        <Text style={styles.label}>{t('email')}</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder={t('email_placeholder')} placeholderTextColor={TEXT_LIGHT} autoCapitalize="none" keyboardType="email-address" />
        <Text style={styles.label}>{t('password')}</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder={t('password_placeholder')} placeholderTextColor={TEXT_LIGHT} secureTextEntry />
        <TouchableOpacity style={[styles.button, loading && { opacity: 0.6 }]} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color={SLATE_DARK} /> : <Text style={styles.buttonText}>{t('sign_in')} →</Text>}
        </TouchableOpacity>
        <Text style={styles.helpText}>{t('contact_manager')}</Text>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: SURFACE, paddingHorizontal: 24, justifyContent: 'center' },
  logoSection: { alignItems: 'center', marginBottom: 40 },
  logoMark: { width: 88, height: 88, borderRadius: 22, marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 16 },

  appName: { color: TEXT, fontSize: 28, fontWeight: '800', marginBottom: 6 },
  tagline: { color: TEXT_MUTED, fontSize: 13 },
  form: { backgroundColor: CARD, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: BORDER, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.06, shadowRadius: 16 },
  label: { color: TEXT_MUTED, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: SURFACE, borderRadius: 12, padding: 14, color: TEXT, fontSize: 15, borderWidth: 1, borderColor: BORDER },
  button: { backgroundColor: GOLD, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24 },
  buttonText: { color: SLATE_DARK, fontSize: 16, fontWeight: '800' },
  helpText: { color: TEXT_LIGHT, fontSize: 11, textAlign: 'center', marginTop: 16 },
})
