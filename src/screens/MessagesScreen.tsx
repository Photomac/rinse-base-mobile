import React, { useState, useEffect, useRef } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, KeyboardAvoidingView, Platform, ActivityIndicator, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { SLATE_DARK, GOLD } from '../lib/theme'

const TEAL = GOLD
const NAVY = SLATE_DARK

const SENDER_COLORS: Record<string, string> = {
  owner: '#8B5CF6',
  crew: '#3B82F6',
  client: '#10B981',
}

interface Props {
  job: any
  user: any
  onBack: () => void
}

export function MessagesScreen({ job, user, onBack }: Props) {
  const { t, lang } = useLang()
  const [messages, setMessages] = useState<any[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const flatListRef = useRef<FlatList>(null)

  const addr = job.client_addresses as any
  const senderName = user.full_name || 'Crew'

  useEffect(() => {
    loadMessages()
    // Poll for new messages every 10 seconds
    const interval = setInterval(loadMessages, 10000)
    return () => clearInterval(interval)
  }, [])

  async function loadMessages() {
    try {
      const { data } = await supabase
        .from('job_messages')
        .select('*')
        .eq('job_id', job.id)
        .order('created_at')
      setMessages(data ?? [])
    } catch (err) { console.warn('Failed to load messages:', err) }
    setLoading(false)
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100)
  }

  async function send() {
    if (!text.trim()) return
    setSending(true)
    const msg = text.trim()
    const { error } = await supabase.from('job_messages').insert({
      tenant_id: user.tenant_id,
      job_id: job.id,
      sender_type: 'crew',
      sender_name: senderName,
      message: msg,
    })
    if (error) { Alert.alert(t('error'), t('message_send_failed')); setSending(false); return }
    setText('')
    await loadMessages()
    setSending(false)
  }

  function fmtTime(iso: string) {
    return new Date(iso).toLocaleTimeString(lang === 'es' ? 'es-MX' : 'en-US', { hour: 'numeric', minute: '2-digit' })
  }

  function fmtDate(iso: string) {
    const d = new Date(iso)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) return t('today')
    return d.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric' })
  }

  // Group messages by date
  const grouped: { date: string; messages: any[] }[] = []
  let currentDate = ''
  messages.forEach(msg => {
    const date = fmtDate(msg.created_at)
    if (date !== currentDate) {
      currentDate = date
      grouped.push({ date, messages: [] })
    }
    grouped[grouped.length - 1].messages.push(msg)
  })

  const flatData = grouped.flatMap(g => [
    { type: 'date', date: g.date, id: 'date-' + g.date },
    ...g.messages.map(m => ({ type: 'message', ...m }))
  ])

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>← {t('back')}</Text>
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.headerTitle} numberOfLines={1}>💬 {addr?.nickname || (job.clients as any)?.full_name}</Text>
          <Text style={styles.headerSub}>{ti(t('n_messages'), { n: String(messages.length) })}</Text>
        </View>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        {loading ? (
          <View style={styles.centered}><ActivityIndicator color={TEAL} size="large" /></View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={flatData}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
            renderItem={({ item }) => {
              if (item.type === 'date') {
                return (
                  <View style={styles.dateSeparator}>
                    <Text style={styles.dateSeparatorText}>{item.date}</Text>
                  </View>
                )
              }
              const isMe = item.sender_type === 'crew'
              const color = SENDER_COLORS[item.sender_type] || '#9CA3AF'
              return (
                <View style={[styles.msgRow, isMe && styles.msgRowMe]}>
                  {!isMe && (
                    <View style={[styles.avatar, { backgroundColor: color }]}>
                      <Text style={styles.avatarText}>{item.sender_name?.[0] || '?'}</Text>
                    </View>
                  )}
                  <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleOther, { borderColor: color + '40' }]}>
                    {!isMe && (
                      <Text style={[styles.senderName, { color }]}>{item.sender_name}
                        <Text style={styles.senderType}> · {item.sender_type}</Text>
                      </Text>
                    )}
                    <Text style={[styles.msgText, isMe && styles.msgTextMe]}>{item.message}</Text>
                    <Text style={[styles.msgTime, isMe && styles.msgTimeMe]}>{fmtTime(item.created_at)}</Text>
                  </View>
                </View>
              )
            }}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>💬</Text>
                <Text style={styles.emptyTitle}>{t('no_messages')}</Text>
                <Text style={styles.emptyText}>{t('messages_empty_sub')}</Text>
              </View>
            }
          />
        )}

        {/* Input */}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={t('type_message_placeholder')}
            placeholderTextColor="#9CA3AF"
            multiline
            maxLength={500}
            onSubmitEditing={send}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
            onPress={send}
            disabled={!text.trim() || sending}
          >
            {sending
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.sendBtnText}>↑</Text>
            }
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  backBtn: { padding: 4 },
  backText: { color: TEAL, fontSize: 14, fontWeight: '600' },
  headerInfo: { flex: 1, alignItems: 'center' },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  headerSub: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageList: { padding: 16, paddingBottom: 8 },
  dateSeparator: { alignItems: 'center', marginVertical: 12 },
  dateSeparatorText: { fontSize: 11, color: '#9CA3AF', fontWeight: '600', backgroundColor: '#F8F9FA', paddingHorizontal: 12 },
  msgRow: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-end', gap: 8 },
  msgRowMe: { flexDirection: 'row-reverse' },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  bubble: { maxWidth: '75%', padding: 10, borderRadius: 16, borderWidth: 1 },
  bubbleMe: { backgroundColor: NAVY, borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: '#fff', borderBottomLeftRadius: 4 },
  senderName: { fontSize: 10, fontWeight: '700', marginBottom: 3 },
  senderType: { color: '#9CA3AF', fontWeight: '400' },
  msgText: { fontSize: 14, color: '#111827', lineHeight: 20 },
  msgTextMe: { color: '#fff' },
  msgTime: { fontSize: 9, color: '#9CA3AF', marginTop: 4, textAlign: 'right' },
  msgTimeMe: { color: 'rgba(255,255,255,0.5)' },
  emptyState: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 12, opacity: 0.3 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 4 },
  emptyText: { fontSize: 13, color: '#9CA3AF', textAlign: 'center' },
  inputRow: { flexDirection: 'row', padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB', backgroundColor: '#fff', alignItems: 'flex-end' },
  input: { flex: 1, borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, color: '#111827', maxHeight: 100, backgroundColor: '#F9FAFB' },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: TEAL, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: '#E5E7EB' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
})
