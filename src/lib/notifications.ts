import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { supabase } from './supabase'
import { ensureNotifications } from './permissions'

// Configure how notifications appear when app is open.
// iOS 17+ / expo-notifications >= 0.32 replaced shouldShowAlert with
// shouldShowBanner + shouldShowList.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
})

export async function registerPushToken(user: any) {
  // Push notifications only work on real devices
  if (!Device.isDevice) return null

  // Silent: never throw a Settings deep-link Alert at app launch — login is
  // the wrong moment for that. The user can re-trigger from the SOS screen
  // or a future Settings page if they want to enable.
  const status = await ensureNotifications({ silent: true })
  if (status !== 'granted') return null

  // Get Expo push token (projectId pulled from app.json so it stays
  // in lockstep with the EAS Update URL)
  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId: '4768586a-ae45-4b35-984c-a1803f1b2985',
  })
  const token = tokenData.data

  // Save token to Supabase
  await supabase.from('push_tokens').upsert({
    tenant_id: user.tenant_id,
    user_id: user.id,
    token,
    platform: Platform.OS,
  }, { onConflict: 'user_id,token' })

  return token
}

// Push a new chat message to the other members of the channel. Sent
// client-side from the sender's device (same gateway as SOS) — recipients
// get it regardless of their app state. Chat had NO push path before this.
export async function sendChatNotification(channel: any, sender: any, body: string) {
  try {
    // Resolve recipient user_ids (everyone but the sender)
    let recipientIds: string[] = []
    if (channel?.channel_type === 'team') {
      const { data } = await supabase.from('users')
        .select('id').eq('tenant_id', sender.tenant_id).eq('is_active', true)
      recipientIds = (data ?? []).map((u: any) => u.id)
    } else {
      recipientIds = channel?.participant_ids ?? []
    }
    recipientIds = recipientIds.filter((id: string) => id && id !== sender.id)
    if (!recipientIds.length) return

    const { data: tokens } = await supabase.from('push_tokens')
      .select('token').eq('tenant_id', sender.tenant_id).in('user_id', recipientIds)
    const toTokens = Array.from(new Set((tokens ?? []).map((t: any) => t.token).filter(Boolean)))
    if (!toTokens.length) return

    const senderName = sender.nickname?.trim() || sender.full_name || 'Teammate'
    const isDm = channel?.channel_type === 'dm'
    const title = isDm ? senderName : (channel?.name || 'Team chat')
    const messages = toTokens.map(token => ({
      to: token,
      sound: 'default',
      title,
      body: isDm ? body : `${senderName}: ${body}`,
      data: { type: 'chat', channelId: channel?.id, tenantId: sender.tenant_id },
      priority: 'high',
    }))
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    })
    if (!res.ok) console.warn('Chat push send failed:', res.status, await res.text())
  } catch (e) {
    console.warn('Chat push send threw:', e)
  }
}

export async function sendSOSNotification(tenantId: string, crewName: string, location: string) {
  // Get all owner and manager tokens for this tenant
  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('token, users!push_tokens_user_id_fkey(role)')
    .eq('tenant_id', tenantId)

  if (!tokens?.length) return

  // Filter to owners and managers only
  const alertTokens = tokens
    .filter((t: any) => ['owner', 'manager', 'dispatcher'].includes(t.users?.role))
    .map((t: any) => t.token)

  if (!alertTokens.length) return

  // Send via Expo Push API
  const messages = alertTokens.map(token => ({
    to: token,
    sound: 'default',
    title: '🆘 SOS ALERT',
    body: `${crewName} needs help! Location: ${location}`,
    data: { type: 'sos', tenantId },
    priority: 'high',
    channelId: 'sos-alerts',
  }))

  // SOS push goes through Expo's push gateway. If this throws, we want
  // the failure logged loud — the SMS fallback (cron-based, server-side)
  // still goes out, but we should know push didn't reach.
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    })
    if (!res.ok) {
      console.warn('Expo push send failed:', res.status, await res.text())
    }
  } catch (e) {
    console.warn('Expo push send threw:', e)
  }
}
