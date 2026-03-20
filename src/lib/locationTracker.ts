// src/lib/locationTracker.ts
// Pings crew GPS every 5 minutes when they have an active job

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import { supabase } from './supabase'

const LOCATION_TASK = 'crew-location-task'
const PING_INTERVAL = 5 * 60 * 1000 // 5 minutes

let pingTimer: any = null
let currentUser: any = null

export function setTrackedUser(user: any) {
  currentUser = user
}

export async function startLocationTracking(user: any) {
  currentUser = user

  const { status } = await Location.requestForegroundPermissionsAsync()
  if (status !== 'granted') return

  // Check if user has any active jobs today
  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0)
  const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999)

  const { data: jobs } = await supabase
    .from('jobs')
    .select('id, status')
    .eq('tenant_id', user.tenant_id)
    .gte('scheduled_start', todayStart.toISOString())
    .lte('scheduled_start', todayEnd.toISOString())
    .neq('status', 'cancelled')

  const myJobs = (jobs ?? []).filter((j: any) =>
    j.job_assignments?.some?.((a: any) => a.user_id === user.id) || true
  )

  if (myJobs.length === 0) return // No jobs today, don't track

  // Start periodic pinging
  await pingLocation(user)
  pingTimer = setInterval(() => pingLocation(user), PING_INTERVAL)
}

export function stopLocationTracking() {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

async function pingLocation(user: any) {
  try {
    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    })

    // Find active job
    const now = new Date()
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0)
    const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999)

    const { data: activeJob } = await supabase
      .from('jobs')
      .select('id, status, job_assignments(user_id)')
      .eq('tenant_id', user.tenant_id)
      .eq('status', 'in_progress')
      .gte('scheduled_start', todayStart.toISOString())
      .lte('scheduled_start', todayEnd.toISOString())
      .maybeSingle()

    const jobId = activeJob?.id || null
    const status = activeJob ? 'active' : 'idle'

    await supabase.from('crew_locations').upsert({
      tenant_id: user.tenant_id,
      user_id: user.id,
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      accuracy: loc.coords.accuracy,
      job_id: jobId,
      status,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,user_id' })

  } catch (e) {
    console.warn('Location ping failed:', e)
  }
}
