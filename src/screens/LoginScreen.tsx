import React, { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, StatusBar, Image } from 'react-native'
import { supabase } from '../lib/supabase'
import { SLATE_DARK, GOLD, SURFACE, CARD, BORDER, TEXT, TEXT_MUTED, TEXT_LIGHT } from '../lib/theme'
import { useLang } from '../contexts/LangContext'

// 'login' → normal sign-in. 'reset_request' → enter email, send the 6-digit
// recovery code. 'reset_verify' → enter code + new password. The email
// templates are CODE-ONLY (web #324 — Outlook Safe Links consumed one-shot
// links), which is exactly what a mobile flow needs: no deep links, the same
// code works here and on the web.
type Mode = 'login' | 'reset_request' | 'reset_verify'

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { t } = useLang()

  async function handleLogin() {
    if (!email || !password) { Alert.alert(t('login_failed'), !email ? t('enter_email') : t('enter_password')); return }
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      // Supabase auth errors arrive in English — map the common ones so
      // Spanish-first crew get a readable reason, not a raw API string.
      const msg = /invalid login credentials/i.test(error.message) ? t('login_invalid_credentials')
        : /network|fetch/i.test(error.message) ? t('login_network_error')
        : error.message
      Alert.alert(t('login_failed'), msg)
    }
    setLoading(false)
  }

  async function sendResetCode() {
    if (!email.trim()) { Alert.alert(t('reset_title'), t('enter_email')); return }
    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim())
    setLoading(false)
    // GoTrue answers success for unknown emails (no account enumeration), so
    // any error here is a real transport/rate problem worth showing.
    if (error) { Alert.alert(t('reset_title'), error.message); return }
    setMode('reset_verify')
  }

  async function verifyAndReset() {
    if (code.trim().length < 6) { Alert.alert(t('reset_title'), t('reset_code_invalid')); return }
    if (newPassword.length < 8) { Alert.alert(t('reset_title'), t('reset_password_short')); return }
    setLoading(true)
    const { error: vErr } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'recovery' })
    if (vErr) {
      setLoading(false)
      Alert.alert(t('reset_title'), /expired|invalid|not found/i.test(vErr.message) ? t('reset_code_invalid') : vErr.message)
      return
    }
    // verifyOtp established a session — set the password on it. On success the
    // App-level onAuthStateChange listener routes straight into the app.
    const { error: uErr } = await supabase.auth.updateUser({ password: newPassword })
    setLoading(false)
    if (uErr) { Alert.alert(t('reset_title'), uErr.message); return }
    Alert.alert('✅', t('reset_success'))
  }

  function backToLogin() {
    setMode('login'); setCode(''); setNewPassword('')
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.logoSection}>
        <Image source={require('../../assets/icon.png')} style={styles.logoMark} />
        <Text style={styles.appName}>Rinsebase</Text>
        <Text style={styles.tagline}>{t('tagline')}</Text>
      </View>

      {mode === 'login' && (
        <View style={styles.form}>
          <Text style={styles.label}>{t('email')}</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder={t('email_placeholder')} placeholderTextColor={TEXT_LIGHT} autoCapitalize="none" keyboardType="email-address" />
          <Text style={styles.label}>{t('password')}</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder={t('password_placeholder')} placeholderTextColor={TEXT_LIGHT} secureTextEntry />
          <TouchableOpacity style={[styles.button, loading && { opacity: 0.6 }]} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color={SLATE_DARK} /> : <Text style={styles.buttonText}>{t('sign_in')} →</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setMode('reset_request')}>
            <Text style={styles.linkText}>{t('forgot_password')}</Text>
          </TouchableOpacity>
          <Text style={styles.helpText}>{t('contact_manager')}</Text>
        </View>
      )}

      {mode === 'reset_request' && (
        <View style={styles.form}>
          <Text style={styles.formTitle}>{t('reset_title')}</Text>
          <Text style={styles.formSub}>{t('reset_instructions')}</Text>
          <Text style={styles.label}>{t('email')}</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder={t('email_placeholder')} placeholderTextColor={TEXT_LIGHT} autoCapitalize="none" keyboardType="email-address" autoFocus />
          <TouchableOpacity style={[styles.button, loading && { opacity: 0.6 }]} onPress={sendResetCode} disabled={loading}>
            {loading ? <ActivityIndicator color={SLATE_DARK} /> : <Text style={styles.buttonText}>{t('reset_send_code')} →</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={backToLogin}>
            <Text style={styles.linkText}>{t('back_to_login')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {mode === 'reset_verify' && (
        <View style={styles.form}>
          <Text style={styles.formTitle}>{t('reset_title')}</Text>
          <Text style={styles.formSub}>{t('reset_code_sent')}</Text>
          <Text style={styles.label}>{t('reset_code_label')}</Text>
          {/* OTP length is a PROJECT SETTING (currently 8 digits) — never
              hardcode it in the UI; a 6-cap truncated real codes on web once. */}
          <TextInput style={[styles.input, styles.codeInput]} value={code} onChangeText={setCode} placeholder="········" placeholderTextColor={TEXT_LIGHT} keyboardType="number-pad" maxLength={12} autoFocus />
          <Text style={styles.label}>{t('reset_new_password')}</Text>
          <TextInput style={styles.input} value={newPassword} onChangeText={setNewPassword} placeholder={t('reset_password_hint')} placeholderTextColor={TEXT_LIGHT} secureTextEntry />
          <TouchableOpacity style={[styles.button, loading && { opacity: 0.6 }]} onPress={verifyAndReset} disabled={loading}>
            {loading ? <ActivityIndicator color={SLATE_DARK} /> : <Text style={styles.buttonText}>{t('reset_submit')} →</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={sendResetCode} disabled={loading}>
            <Text style={styles.linkText}>{t('reset_resend')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={backToLogin}>
            <Text style={styles.helpText}>{t('back_to_login')}</Text>
          </TouchableOpacity>
        </View>
      )}
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
  formTitle: { color: TEXT, fontSize: 18, fontWeight: '800', marginBottom: 6 },
  formSub: { color: TEXT_MUTED, fontSize: 13, lineHeight: 19, marginBottom: 4 },
  label: { color: TEXT_MUTED, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: SURFACE, borderRadius: 12, padding: 14, color: TEXT, fontSize: 15, borderWidth: 1, borderColor: BORDER },
  codeInput: { fontSize: 22, fontWeight: '800', letterSpacing: 8, textAlign: 'center' },
  button: { backgroundColor: GOLD, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24 },
  buttonText: { color: SLATE_DARK, fontSize: 16, fontWeight: '800' },
  linkText: { color: TEXT, fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: 16 },
  helpText: { color: TEXT_LIGHT, fontSize: 11, textAlign: 'center', marginTop: 16 },
})
