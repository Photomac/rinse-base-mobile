import React from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { reportClientError } from '../lib/errorReporter'
import { tStatic } from '../lib/i18n'

// Catches React render errors (RN has no built-in boundary), reports them, and
// shows a recoverable fallback instead of a blank/crashed screen. It sits
// outside LangProvider, so it reads the app language through tStatic.
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    reportClientError(error?.message, `${error?.stack || ''}\n${info?.componentStack || ''}`, 'react-boundary')
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>{tStatic('err_title')}</Text>
          <Text style={styles.subtitle}>{tStatic('err_sub')}</Text>
          <TouchableOpacity style={styles.button} onPress={() => this.setState({ hasError: false })}>
            <Text style={styles.buttonText}>{tStatic('err_retry')}</Text>
          </TouchableOpacity>
        </View>
      )
    }
    return this.props.children
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  subtitle: { color: '#94a3b8', fontSize: 14, marginBottom: 20 },
  button: { backgroundColor: '#D4A843', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
})
