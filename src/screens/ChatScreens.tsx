import React, { useState, useEffect, useRef } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'

const TEAL = '#00C9A7'
const NAVY = '#0A1628'

const ROLE_COLORS: Record<string, string> = {
  owner: '#8B5CF6',
  manager: '#3B82F6',
  dispatcher: '#F59E0B',
  lead_cleaner: '#10B981',
  cleaner: '#00C9A7',
  trainee: '#9CA3AF',
}

// ── Channel List Screen ───────────────────────────────────────────
export function ChatListScreen({ user, onOpenChannel, onNewDM }: { user: any; onOpenChannel: (channel: any) => void; onNewDM: () => void }) {
  const [channels, setChannels] = useState<any[]>([])
  const [crew, setCrew] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'channels'|'dms'>('channels')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [chanRes, crewRes] = await Promise.all([
      supabase.from('message_channels').select('*')
        .eq('tenant_id', user.tenant_id)
        .order('last_message_at', { ascending: false, nullsFirst: false }),
      supabase.from('users').select('id, full_name, role, avatar_url')
        .eq('tenant_id', user.tenant_id)
        .eq('is_active', true)
        .neq('id', user.id)
        .order('full_name'),
    ])
    setChannels(chanRes.data ?? [])
    setCrew(crewRes.data ?? [])
    setLoading(false)
  }

  async function openDM(otherUser: any) {
    // Find or create DM channel
    const existing = channels.find(c =>
      c.channel_type === 'dm' &&
      c.participant_ids?.includes(user.id) &&
      c.participant_ids?.includes(otherUser.id)
    )
    if (existing) { onOpenChannel({ ...existing, displayName: otherUser.full_name }); return }

    const { data } = await supabase.from('message_channels').insert({
      tenant_id: user.tenant_id,
      channel_type: 'dm',
      name: null,
      participant_ids: [user.id, otherUser.id],
    }).select().single()
    if (data) onOpenChannel({ ...data, displayName: otherUser.full_name })
    load()
  }

  const teamChannels = channels.filter(c => c.channel_type === 'team')
  const dmChannels = channels.filter(c =>
    c.channel_type === 'dm' && c.participant_ids?.includes(user.id)
  )

  function getDMName(channel: any) {
    const otherId = channel.participant_ids?.find((id: string) => id !== user.id)
    const other = crew.find(c => c.id === otherId)
    return other?.full_name || 'Unknown'
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>💬 Messages</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {(['channels', 'dms'] as const).map(t => (
          <TouchableOpacity key={t} style={[styles.tabBtn, tab === t && styles.tabBtnActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabBtnText, tab === t && styles.tabBtnTextActive]}>
              {t === 'channels' ? '# Channels' : '💬 Direct messages'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={TEAL} /></View>
      ) : tab === 'channels' ? (
        <FlatList
          data={teamChannels}
          keyExtractor={item => item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.channelRow} onPress={() => onOpenChannel({ ...item, displayName: item.name })}>
              <View style={styles.channelIcon}>
                <Text style={styles.channelIconText}>#</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.channelName}>{item.name}</Text>
                {item.last_message && <Text style={styles.channelPreview} numberOfLines={1}>{item.last_message}</Text>}
              </View>
              <Text style={{ color: '#D1D5DB', fontSize: 18 }}>›</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No channels yet</Text>}
        />
      ) : (
        <FlatList
          data={crew}
          keyExtractor={item => item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => {
            const dmChannel = dmChannels.find(c => c.participant_ids?.includes(item.id))
            const color = ROLE_COLORS[item.role] || TEAL
            return (
              <TouchableOpacity style={styles.channelRow} onPress={() => openDM(item)}>
                {item.avatar_url ? (
                  <Image source={{ uri: item.avatar_url }} style={[styles.avatarPhoto, { width: 40, height: 40, borderRadius: 20 }]} />
                ) : (
                  <View style={[styles.avatar, { backgroundColor: color }]}>
                    <Text style={styles.avatarText}>{item.full_name?.split(' ')[0]?.[0] || '?'}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.channelName}>{item.full_name}</Text>
                  <Text style={styles.channelRole}>{item.role?.replace('_', ' ')}</Text>
                  {dmChannel?.last_message && <Text style={styles.channelPreview} numberOfLines={1}>{dmChannel.last_message}</Text>}
                </View>
                <Text style={{ color: '#D1D5DB', fontSize: 18 }}>›</Text>
              </TouchableOpacity>
            )
          }}
          ListEmptyComponent={<Text style={styles.emptyText}>No other crew members</Text>}
        />
      )}
    </SafeAreaView>
  )
}

// ── Chat Screen ───────────────────────────────────────────────────
export function ChatScreen({ channel, user, onBack }: { channel: any; user: any; onBack: () => void }) {
  const [messages, setMessages] = useState<any[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const flatListRef = useRef<FlatList>(null)

  useEffect(() => {
    loadMessages()
    const interval = setInterval(loadMessages, 8000)
    return () => clearInterval(interval)
  }, [channel.id])

  async function loadMessages() {
    const { data } = await supabase
      .from('chat_messages')
      .select('*, users!chat_messages_sender_id_fkey(avatar_url, full_name)')
      .eq('channel_id', channel.id)
      .order('created_at')
    // Merge avatar_url from users join
    const msgs = (data ?? []).map((m: any) => ({
      ...m,
      avatar_url: m.avatar_url || m.users?.avatar_url || null,
      sender_name: m.sender_name || m.users?.full_name || 'Unknown',
    }))
    setMessages(msgs)
    setLoading(false)
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100)
  }

  async function send() {
    if (!text.trim()) return
    setSending(true)
    const msg = text.trim()
    setText('')
    // Get latest avatar_url from DB
    const { data: freshUser } = await supabase.from('users').select('avatar_url').eq('id', user.id).maybeSingle()
    await supabase.from('chat_messages').insert({
      tenant_id: user.tenant_id,
      channel_id: channel.id,
      sender_id: user.id,
      sender_name: user.full_name,
      sender_role: user.role,
      avatar_url: freshUser?.avatar_url || user.avatar_url || null,
      body: msg,
    })
    // Update channel last message
    await supabase.from('message_channels').update({
      last_message: msg,
      last_message_at: new Date().toISOString(),
    }).eq('id', channel.id)
    await loadMessages()
    setSending(false)
  }

  function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
  function fmtDate(iso: string) {
    const d = new Date(iso)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) return 'Today'
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  // Group by date
  const flatData: any[] = []
  let lastDate = ''
  messages.forEach(msg => {
    const date = fmtDate(msg.created_at)
    if (date !== lastDate) { flatData.push({ type: 'date', id: 'd-' + date, date }); lastDate = date }
    flatData.push({ type: 'msg', ...msg })
  })

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{channel.channel_type === 'team' ? '# ' : ''}{channel.displayName || channel.name}</Text>
          <Text style={styles.headerSub}>{channel.channel_type === 'team' ? 'Team channel' : 'Direct message'}</Text>
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
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
              if (item.type === 'date') return (
                <View style={styles.dateSep}>
                  <Text style={styles.dateSepText}>{item.date}</Text>
                </View>
              )
              const isMe = item.sender_id === user.id
              const color = ROLE_COLORS[item.sender_role] || TEAL
              return (
                <View style={[styles.msgRow, isMe && styles.msgRowMe]}>
                  {item.avatar_url ? (
                    <Image source={{ uri: item.avatar_url }} style={styles.avatarPhoto} />
                  ) : (
                    <View style={[styles.avatar, { backgroundColor: color }]}>
                      <Text style={styles.avatarText}>{item.sender_name?.split(' ')[0]?.[0] || '?'}</Text>
                    </View>
                  )}
                  <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleOther]}>
                    {!isMe && (
                      <Text style={[styles.senderName, { color }]}>
                        {item.sender_name?.split(' ')[0]} <Text style={styles.senderRole}>{item.sender_role?.replace('_', ' ')}</Text>
                      </Text>
                    )}
                    <Text style={[styles.msgText, isMe && styles.msgTextMe]}>{item.body}</Text>
                    <Text style={[styles.msgTime, isMe && styles.msgTimeMe]}>{fmtTime(item.created_at)}</Text>
                  </View>
                </View>
              )
            }}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>💬</Text>
                <Text style={styles.emptyTitle}>No messages yet</Text>
                <Text style={styles.emptyText}>Start the conversation!</Text>
              </View>
            }
          />
        )}

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Message..."
            placeholderTextColor="#9CA3AF"
            multiline
            maxLength={500}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
            onPress={send}
            disabled={!text.trim() || sending}
          >
            {sending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.sendBtnText}>↑</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
  backBtn: { padding: 4 },
  backText: { color: TEAL, fontSize: 22, fontWeight: '300' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  headerSub: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 1 },
  tabRow: { flexDirection: 'row', backgroundColor: NAVY, paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  tabBtn: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  tabBtnActive: { backgroundColor: TEAL, borderColor: TEAL },
  tabBtnText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  tabBtnTextActive: { color: '#fff' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  channelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#F3F4F6' },
  channelIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: NAVY, alignItems: 'center', justifyContent: 'center' },
  channelIconText: { color: TEAL, fontSize: 18, fontWeight: '700' },
  channelName: { fontSize: 14, fontWeight: '700', color: '#111827' },
  channelRole: { fontSize: 11, color: '#9CA3AF', textTransform: 'capitalize' },
  channelPreview: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  emptyText: { textAlign: 'center', color: '#9CA3AF', fontSize: 13, marginTop: 40 },
  messageList: { padding: 16, paddingBottom: 8 },
  dateSep: { alignItems: 'center', marginVertical: 12 },
  dateSepText: { fontSize: 11, color: '#9CA3AF', fontWeight: '600' },
  msgRow: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-end', gap: 8 },
  msgRowMe: { flexDirection: 'row-reverse' },
  bubble: { maxWidth: '75%', padding: 10, borderRadius: 16 },
  bubbleMe: { backgroundColor: NAVY, borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: '#fff', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#E5E7EB' },
  senderName: { fontSize: 10, fontWeight: '700', marginBottom: 3 },
  senderRole: { color: '#9CA3AF', fontWeight: '400', textTransform: 'capitalize' },
  msgText: { fontSize: 14, color: '#111827', lineHeight: 20 },
  msgTextMe: { color: '#fff' },
  msgTime: { fontSize: 9, color: '#9CA3AF', marginTop: 4, textAlign: 'right' },
  msgTimeMe: { color: 'rgba(255,255,255,0.5)' },
  emptyState: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 12, opacity: 0.3 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 4 },
  inputRow: { flexDirection: 'row', padding: 12, paddingBottom: 24, gap: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB', backgroundColor: '#fff', alignItems: 'flex-end' },
  input: { flex: 1, borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, color: '#111827', maxHeight: 100, backgroundColor: '#F9FAFB' },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: TEAL, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: '#E5E7EB' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
})
