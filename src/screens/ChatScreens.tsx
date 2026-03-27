import React, { useState, useEffect, useRef } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { SLATE_DARK, GOLD, ROLE_COLORS } from '../lib/theme'

// ── Channel List Screen ───────────────────────────────────────────
export function ChatListScreen({ user, onOpenChannel, onNewDM }: { user: any; onOpenChannel: (channel: any) => void; onNewDM: () => void }) {
  const [channels, setChannels] = useState<any[]>([])
  const [crew, setCrew] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'channels'|'dms'>('channels')
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [creatingGroup, setCreatingGroup] = useState(false)

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

  async function createGroup() {
    if (!groupName.trim() || selectedMembers.length < 2) return
    setCreatingGroup(true)
    const allMembers = [user.id, ...selectedMembers]
    const { data } = await supabase.from('message_channels').insert({
      tenant_id: user.tenant_id,
      channel_type: 'group',
      name: groupName.trim(),
      participant_ids: allMembers,
    }).select().single()
    if (data) {
      setShowNewGroup(false)
      setGroupName('')
      setSelectedMembers([])
      onOpenChannel({ ...data, displayName: groupName.trim() })
    }
    setCreatingGroup(false)
    load()
  }

  async function openDM(otherUser: any) {
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
    (c.channel_type === 'dm' || c.channel_type === 'group') && c.participant_ids?.includes(user.id)
  )

  function getDMName(channel: any) {
    if (channel.channel_type === 'group') return channel.name || 'Grupo'
    const otherId = channel.participant_ids?.find((id: string) => id !== user.id)
    const other = crew.find(c => c.id === otherId)
    return other?.full_name || 'Unknown'
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>💬 Messages</Text>
        <TouchableOpacity onPress={() => setShowNewGroup(true)} style={styles.newGroupBtn}>
          <Text style={styles.newGroupBtnText}>+ Group</Text>
        </TouchableOpacity>
      </View>

      {showNewGroup && (
        <View style={styles.groupModal}>
          <View style={styles.groupModalCard}>
            <Text style={styles.groupModalTitle}>New group chat</Text>
            <TextInput
              style={styles.groupNameInput}
              placeholder="Group name..."
              placeholderTextColor="#94A3B8"
              value={groupName}
              onChangeText={setGroupName}
            />
            <Text style={styles.groupMemberLabel}>Select members (min 2)</Text>
            <ScrollView style={{ maxHeight: 200 }}>
              {crew.map(c => {
                const selected = selectedMembers.includes(c.id)
                return (
                  <TouchableOpacity key={c.id}
                    style={[styles.memberRow, selected && styles.memberRowSelected]}
                    onPress={() => setSelectedMembers(prev =>
                      selected ? prev.filter(id => id !== c.id) : [...prev, c.id]
                    )}>
                    <View style={[styles.memberCheck, selected && styles.memberCheckSelected]}>
                      {selected && <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>✓</Text>}
                    </View>
                    <Text style={styles.memberName}>{c.full_name}</Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <TouchableOpacity style={styles.groupCancelBtn} onPress={() => { setShowNewGroup(false); setGroupName(''); setSelectedMembers([]) }}>
                <Text style={styles.groupCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.groupCreateBtn, (creatingGroup || !groupName.trim() || selectedMembers.length < 2) && { opacity: 0.5 }]}
                onPress={createGroup}
                disabled={creatingGroup || !groupName.trim() || selectedMembers.length < 2}>
                <Text style={styles.groupCreateText}>{creatingGroup ? 'Creando...' : 'Crear grupo'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

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
        <View style={styles.centered}><ActivityIndicator color={GOLD} /></View>
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
              <Text style={{ color: '#CBD5E1', fontSize: 18 }}>›</Text>
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
            const color = ROLE_COLORS[item.role] || GOLD
            return (
              <TouchableOpacity style={styles.channelRow} onPress={() => openDM(item)}>
                {item.avatar_url ? (
                  <Image source={{ uri: item.avatar_url }} style={styles.avatarPhoto} />
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
                <Text style={{ color: '#CBD5E1', fontSize: 18 }}>›</Text>
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
          <Text style={styles.headerSub}>{channel.channel_type === 'team' ? 'Canal del equipo' : 'Mensaje directo'}</Text>
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {loading ? (
          <View style={styles.centered}><ActivityIndicator color={GOLD} size="large" /></View>
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
              const color = ROLE_COLORS[item.sender_role] || GOLD
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
            placeholderTextColor="#94A3B8"
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
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: SLATE_DARK, flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
  backBtn: { padding: 4 },
  backText: { color: GOLD, fontSize: 22, fontWeight: '300' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  headerSub: { color: 'rgba(255,255,255,0.45)', fontSize: 11, marginTop: 1 },
  tabRow: { flexDirection: 'row', backgroundColor: SLATE_DARK, paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  tabBtn: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  tabBtnActive: { backgroundColor: GOLD, borderColor: GOLD },
  tabBtnText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  tabBtnTextActive: { color: '#fff' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  newGroupBtn: { backgroundColor: GOLD, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  newGroupBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  groupModal: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 100, alignItems: 'center', justifyContent: 'center', padding: 24 },
  groupModalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 20, width: '100%' },
  groupModalTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginBottom: 12 },
  groupNameInput: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 10, padding: 12, fontSize: 14, color: '#0F172A', marginBottom: 12 },
  groupMemberLabel: { fontSize: 11, fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, marginBottom: 4 },
  memberRowSelected: { backgroundColor: GOLD + '15' },
  memberCheck: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#E2E8F0', alignItems: 'center', justifyContent: 'center' },
  memberCheckSelected: { backgroundColor: GOLD, borderColor: GOLD },
  memberName: { fontSize: 14, fontWeight: '600', color: '#0F172A' },
  groupCancelBtn: { flex: 1, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', alignItems: 'center' },
  groupCancelText: { fontSize: 13, fontWeight: '600', color: '#64748B' },
  groupCreateBtn: { flex: 2, padding: 12, borderRadius: 10, backgroundColor: GOLD, alignItems: 'center' },
  groupCreateText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  channelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  channelIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: SLATE_DARK, alignItems: 'center', justifyContent: 'center' },
  channelIconText: { color: GOLD, fontSize: 18, fontWeight: '700' },
  channelName: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  channelRole: { fontSize: 11, color: '#94A3B8', textTransform: 'capitalize' },
  channelPreview: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  // ── Avatar styles (fixed: avatarPhoto was missing before) ──
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarPhoto: { width: 40, height: 40, borderRadius: 20, flexShrink: 0 },
  avatarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  emptyText: { textAlign: 'center', color: '#94A3B8', fontSize: 13, marginTop: 40 },
  messageList: { padding: 16, paddingBottom: 8 },
  dateSep: { alignItems: 'center', marginVertical: 12 },
  dateSepText: { fontSize: 11, color: '#94A3B8', fontWeight: '600' },
  msgRow: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-end', gap: 8 },
  msgRowMe: { flexDirection: 'row-reverse' },
  bubble: { maxWidth: '75%', padding: 10, borderRadius: 16 },
  bubbleMe: { backgroundColor: SLATE_DARK, borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: '#fff', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#E2E8F0' },
  senderName: { fontSize: 10, fontWeight: '700', marginBottom: 3 },
  senderRole: { color: '#94A3B8', fontWeight: '400', textTransform: 'capitalize' },
  msgText: { fontSize: 14, color: '#0F172A', lineHeight: 20 },
  msgTextMe: { color: '#fff' },
  msgTime: { fontSize: 9, color: '#94A3B8', marginTop: 4, textAlign: 'right' },
  msgTimeMe: { color: 'rgba(255,255,255,0.45)' },
  emptyState: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 12, opacity: 0.3 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#0F172A', marginBottom: 4 },
  inputRow: { flexDirection: 'row', padding: 12, paddingBottom: 24, gap: 8, borderTopWidth: 1, borderTopColor: '#E2E8F0', backgroundColor: '#fff', alignItems: 'flex-end' },
  input: { flex: 1, borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, color: '#0F172A', maxHeight: 100, backgroundColor: '#F8FAFC' },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: '#E2E8F0' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
})
