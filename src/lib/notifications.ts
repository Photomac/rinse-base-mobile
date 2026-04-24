import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { supabase } from './supabase'

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

  // Request permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync()
  let finalStatus = existingStatus
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync()
    finalStatus = status
  }
  if (finalStatus !== 'granted') return null

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

  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  })
}
