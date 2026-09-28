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
  // in lockstep with the EAS Update URL).
  //
  // getExpoPushTokenAsync registers the device with FCM/APNs and can throw
  // ("Calling the 'getRegistrationInfoAsync' function has failed") when that
  // registration fails — flaky network, Android without Google Play Services,
  // APNs hiccup, etc. That's an expected device condition, not a bug: swallow
  // it so it doesn't blow up the login flow or spam Sentry. The crew member
  // simply has no push token this session (SMS fallbacks still cover geofence/
  // clockout); it retries on the next launch.
  try {
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
  } catch (e) {
    console.warn('Push token registration failed (device will retry next launch):', e)
    return null
  }
}

// The SOS push to the office moved to src/lib/sosQueue.ts (2026-09-28), where
// it goes out once the alert row has landed instead of alongside an unchecked
// insert. There is no SMS fallback for SOS on the server; an earlier comment
// here said there was.
