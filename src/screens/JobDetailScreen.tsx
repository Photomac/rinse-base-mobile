import React, { useState, useEffect, useRef } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert, Linking, ActivityIndicator, Modal, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { ensureCamera } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { JobPhotosScreen } from './JobPhotosScreen'
import { JobInventoryScreen } from './JobInventoryScreen'
import { LaundryRunScreen } from './LaundryRunScreen'
import { MessagesScreen } from './MessagesScreen'
import { StayRatingCard } from '../components/StayRatingCard'
import { PhotoViewer } from '../components/PhotoViewer'
import { LostFoundCard } from '../components/LostFoundCard'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'

import { SLATE_DARK, GOLD } from '../lib/theme'
import { startLocationTracking, maybeStopLocationTracking } from '../lib/locationTracker'
import { flushQueue, pendingCount, pendingStatus, PendingStatus } from '../lib/photoQueue'
const TEAL = GOLD
const NAVY = SLATE_DARK

const PAUSE_REASONS = [
  { value: 'Waiting for laundry', key: 'waiting_laundry' as const },
  { value: 'Going to another job', key: 'going_another_job' as const },
  { value: 'Supply run', key: 'supply_run' as const },
  { value: 'Waiting for access', key: 'waiting_access' as const },
  { value: 'Break', key: 'break_time' as const },
  { value: 'Other', key: 'other' as const },
]

// Laundry on a regular clean: where did the bags go? Four destinations, each
// with its own per-bag rate on the tenant (take home / washed on-site /
// dropped at office / dropped at laundromat) — covers Elle's split and any
// other shop's. Writes the same laundry_runs row a laundromat task uses
// (keyed by this job), so payroll's bonus math and the laundry reports pick
// it up with zero extra plumbing. Rendered only when the tenant pays a bonus
// for at least one destination (user._laundryBonus > 0).
const LAUNDRY_MODES = [
  { key: 'bags_taken_home' as const,    labelKey: 'laundry_bags_home' as const },
  { key: 'bags_onsite' as const,        labelKey: 'laundry_bags_onsite' as const },
  { key: 'bags_to_office' as const,     labelKey: 'laundry_bags_office' as const },
  { key: 'bags_to_laundromat' as const, labelKey: 'laundry_bags_laundromat' as const },
]
function TakeHomeLaundryCard({ job, user, bagColor }: { job: any; user: any; bagColor?: string | null }) {
  const { t } = useLang()
  const [bags, setBags] = useState<Record<string, number>>({ bags_taken_home: 0, bags_onsite: 0, bags_to_office: 0, bags_to_laundromat: 0 })
  const [rowUserId, setRowUserId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    supabase.from('laundry_runs').select('user_id, bags_taken_home, bags_onsite, bags_to_office, bags_to_laundromat').eq('job_id', job.id).maybeSingle().then(({ data }) => {
      if (data) {
        setBags({
          bags_taken_home: data.bags_taken_home ?? 0, bags_onsite: data.bags_onsite ?? 0,
          bags_to_office: data.bags_to_office ?? 0, bags_to_laundromat: data.bags_to_laundromat ?? 0,
        })
        setRowUserId(data.user_id ?? null)
      }
    })
  }, [])

  async function save() {
    setSaving(true)
    const { error } = await supabase.from('laundry_runs').upsert({
      tenant_id: user.tenant_id,
      job_id: job.id,
      user_id: rowUserId || user.id,
      ...bags,
    }, { onConflict: 'job_id' })
    setSaving(false)
    if (error) { Alert.alert(t('error'), error.message); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 2200)
  }

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>🧺 {t('laundry_card_title')}</Text>
      <Text style={{ fontSize: 12, color: '#6B7280', marginTop: 2, marginBottom: 10 }}>{t('laundry_card_hint')}</Text>
      {bagColor && <Text style={{ fontSize: 12, fontWeight: '700', color: '#92400E', backgroundColor: '#FEF3C7', alignSelf: 'flex-start', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, marginBottom: 10 }}>🧺 {bagColor}</Text>}
      {LAUNDRY_MODES.map(({ key, labelKey }) => (
        <View key={key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#374151', flex: 1, paddingRight: 8 }}>{t(labelKey)}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <TouchableOpacity onPress={() => setBags(b => ({ ...b, [key]: Math.max(0, b[key] - 1) }))}
              style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: NAVY, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800', lineHeight: 22 }}>−</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: 20, fontWeight: '900', color: bags[key] > 0 ? '#111827' : '#9CA3AF', minWidth: 30, textAlign: 'center' }}>{bags[key]}</Text>
            <TouchableOpacity onPress={() => setBags(b => ({ ...b, [key]: b[key] + 1 }))}
              style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: NAVY, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800', lineHeight: 22 }}>+</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
      <TouchableOpacity
        onPress={save} disabled={saving}
        style={{ marginTop: 4, borderRadius: 12, padding: 12, alignItems: 'center', backgroundColor: saved ? '#10B981' : TEAL }}>
        {saving
          ? <ActivityIndicator color="#fff" size="small" />
          : <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>{saved ? `✓ ${t('saved')}` : t('takehome_save')}</Text>}
      </TouchableOpacity>
    </View>
  )
}

const DEFAULT_CHECKLIST: { id: string; labelKey: 'chk_kitchen' | 'chk_bathrooms' | 'chk_floors_vacuum' | 'chk_floors_mop' | 'chk_dust' | 'chk_trash' | 'chk_beds' | 'chk_walkthrough'; room: string; title: string }[] = [
  { id: '1', labelKey: 'chk_kitchen',       room: 'Kitchen',  title: 'General clean' },
  { id: '2', labelKey: 'chk_bathrooms',     room: 'Bathroom', title: 'General clean' },
  { id: '3', labelKey: 'chk_floors_vacuum', room: 'Floors',   title: 'Vacuum/sweep' },
  { id: '4', labelKey: 'chk_floors_mop',    room: 'Floors',   title: 'Mop' },
  { id: '5', labelKey: 'chk_dust',          room: 'General',  title: 'Dust' },
  { id: '6', labelKey: 'chk_trash',         room: 'General',  title: 'Trash' },
  { id: '7', labelKey: 'chk_beds',          room: 'Bedroom',  title: 'Linens' },
  { id: '8', labelKey: 'chk_walkthrough',   room: 'General',  title: 'Walkthrough' },
]

function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
function fmtDuration(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function JobDetailScreen({ job, user, onBack, onStatusChange }: { job: any; user: any; onBack: () => void; onStatusChange: (job: any, status: string) => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [showPhotos, setShowPhotos] = useState(false)
  const [showInventory, setShowInventory] = useState(false)
  const [showMessages, setShowMessages] = useState(false)
  const [showLaundry, setShowLaundry] = useState(false)
  const [checklist, setChecklist] = useState(DEFAULT_CHECKLIST as any[])
  const [loadingChecklist, setLoadingChecklist] = useState(false)
  const [itemPhotos, setItemPhotos] = useState<Record<string, number>>({})
  const [activePhotoItem, setActivePhotoItem] = useState<any>(null)
  const [viewPropertyPhoto, setViewPropertyPhoto] = useState(false)

  // Time tracking
  const [timeEntries, setTimeEntries] = useState<any[]>([])
  const [activeEntry, setActiveEntry] = useState<any>(null)
  const [isPaused, setIsPaused] = useState(false)
  const [elapsedMinutes, setElapsedMinutes] = useState(0)
  const [showPauseModal, setShowPauseModal] = useState(false)
  const [pauseReason, setPauseReason] = useState('')
  const [propMeta, setPropMeta] = useState<{ bedrooms: number | null; bathrooms: number | null; sqft: number | null; beds?: number | null; crew_notes?: string | null } | null>(null)
  const [accessCode, setAccessCode] = useState<string | null>(null)
  const timerRef = useRef<any>(null)

  const { t } = useLang()
  const addr = job.client_addresses as any
  const client = job.clients as any
  // Laundry + "how did the guests leave it" are STR/PM turnover features — a
  // residential client's clean hides both. client_type isn't in every list
  // payload, so loadPropMeta backfills it from the job's client.
  const [clientType, setClientType] = useState<string | null>(client?.client_type ?? null)
  const isResidential = clientType === 'residential'
  // One-tap "all laundry done on-site" flag — the lightweight cousin of the
  // bag-count card; payroll counts it per crew per period for on-site bonuses.
  const [laundryDoneOnsite, setLaundryDoneOnsite] = useState<boolean>(!!job.laundry_done_onsite)
  // Operto-parity turnover strip: checkout / next check-in / window live on the
  // job row (sync-ical keeps them fresh on drift); bag color lives on the property.
  const [turnover, setTurnover] = useState<{ checkout: string | null; checkin: string | null; window: number | null; urgency: string | null } | null>(null)
  const [guestCount, setGuestCount] = useState<number | null>(null)
  // Everyone working this job (lead first) — crew see who they're working with.
  const [crewOnJob, setCrewOnJob] = useState<{ name: string; isLead: boolean }[]>([])
  const [bagColor, setBagColor] = useState<string | null>(null)
  // Crew see the property, not the homeowner — client names are for admins.
  const isAdminRole = ['owner', 'manager', 'dispatcher'].includes(user.role)
  const propLabel = addr?.nickname || (isAdminRole ? client?.full_name : addr?.street)
  // Dispatcher-suggested driving order → "Stop k of M" for this crew's day.
  const [routeStop, setRouteStop] = useState<{ k: number; m: number } | null>(null)
  // Laundry-run task: internal shell property, no checklist/photos/supplies —
  // the cash + bags reconciliation form replaces them.
  const isLaundry = job.job_type === 'laundry_run'
  // Any internal task (laundry run, generic task): no property/checklist/photos.
  const isTask = !!job.job_type && job.job_type !== 'clean'
  const dailyMode = user._timeMode === 'daily'
  const isClockedIn = !!activeEntry && !isPaused
  // In daily mode there's no per-job timer, so "started" tracks job status instead.
  const isStarted = timeEntries.length > 0 || !!activeEntry || (dailyMode && (job.status === 'in_progress' || job.status === 'completed'))

  useEffect(() => {
    loadChecklist()
    loadTimeEntries()
    loadPropMeta()
    loadRouteStop()
  }, [])

  // Rank this job among the crew member's own route-ordered jobs for the same
  // day, so the badge is a clean "Stop k of M" (matches the Dashboard).
  async function loadRouteStop() {
    const day = new Date(job.scheduled_start)
    const start = new Date(day); start.setHours(0, 0, 0, 0)
    const end = new Date(day); end.setHours(23, 59, 59, 999)
    const { data } = await supabase.from('jobs')
      .select('id, route_order, job_assignments!inner(user_id)')
      .eq('tenant_id', user.tenant_id)
      .eq('job_assignments.user_id', user.id)
      .not('route_order', 'is', null)
      .gte('scheduled_start', start.toISOString())
      .lte('scheduled_start', end.toISOString())
    if (!data || !data.length) { setRouteStop(null); return }
    const ordered = [...data].sort((a: any, b: any) => a.route_order - b.route_order)
    const idx = ordered.findIndex((j: any) => j.id === job.id)
    setRouteStop(idx === -1 ? null : { k: idx + 1, m: ordered.length })
  }

  // Beds/baths/sqft aren't in the list-screen job payload, so fetch them here —
  // works no matter which screen opened this job.
  async function loadPropMeta() {
    // Time-boxed crew access code (smart lock) lives on the job, not the list
    // payload — same for the laundry flag and the client's type.
    const { data: jr } = await supabase
      .from('jobs')
      .select('seam_access_code, laundry_done_onsite, checkout_time, checkin_time, window_minutes, urgency, clients!jobs_client_id_fkey(client_type), property_reservations(guest_count)')
      .eq('id', job.id)
      .maybeSingle()
    if ((jr as any)?.seam_access_code) setAccessCode((jr as any).seam_access_code)
    if (jr) {
      setLaundryDoneOnsite(!!(jr as any).laundry_done_onsite)
      const ct = (jr as any).clients?.client_type
      if (ct) setClientType(ct)
      if ((jr as any).checkout_time) setTurnover({
        checkout: (jr as any).checkout_time,
        checkin: (jr as any).checkin_time,
        window: (jr as any).window_minutes,
        urgency: (jr as any).urgency,
      })
      const gc = (jr as any).property_reservations?.guest_count
      if (gc) setGuestCount(gc)
    }

    // Full crew roster for this job, lead first.
    const { data: crewRows } = await supabase
      .from('job_assignments')
      .select('is_lead, users!job_assignments_user_id_fkey(full_name)')
      .eq('job_id', job.id)
      .order('is_lead', { ascending: false })
    setCrewOnJob((crewRows ?? []).map((a: any) => ({ name: a.users?.full_name, isLead: !!a.is_lead })).filter((c: any) => c.name))

    const addrId = job.client_addresses?.id || job.address_id
    if (!addrId) return
    const { data } = await supabase
      .from('client_addresses')
      .select('bedrooms, bathrooms, sqft, beds, crew_notes, laundry_bag_color')
      .eq('id', addrId)
      .maybeSingle()
    if (data) {
      setPropMeta(data as any)
      setBagColor((data as any).laundry_bag_color ?? null)
    }
  }

  async function toggleLaundryDoneOnsite() {
    const next = !laundryDoneOnsite
    setLaundryDoneOnsite(next)
    const { error } = await supabase.from('jobs').update({ laundry_done_onsite: next }).eq('id', job.id)
    if (error) { setLaundryDoneOnsite(!next); Alert.alert(t('error'), error.message) }
  }

  // Live timer
  useEffect(() => {
    if (isClockedIn && activeEntry) {
      timerRef.current = setInterval(() => {
        const start = new Date(activeEntry.clocked_in_at).getTime()
        const now = Date.now()
        const mins = (now - start) / 60000
        const prevMins = timeEntries
          .filter(e => e.clocked_out_at)
          .reduce((s, e) => s + (e.duration_minutes || 0), 0)
        setElapsedMinutes(prevMins + mins)
      }, 10000)
    } else {
      clearInterval(timerRef.current)
      const total = timeEntries.filter(e => e.clocked_out_at).reduce((s, e) => s + (e.duration_minutes || 0), 0)
      setElapsedMinutes(total)
    }
    return () => clearInterval(timerRef.current)
  }, [isClockedIn, activeEntry, timeEntries])

  async function loadTimeEntries() {
    const { data } = await supabase
      .from('job_time_entries')
      .select('*')
      .eq('job_id', job.id)
      .eq('user_id', user.id)
      .order('clocked_in_at')
    if (data) {
      setTimeEntries(data)
      const active = data.find(e => !e.clocked_out_at)
      if (active) {
        setActiveEntry(active)
        setIsPaused(false)
      } else {
        // No open entry. If the most recent entry was closed by a PAUSE (has a
        // pause_reason) and the job isn't finished, restore the paused state so
        // the Resume button shows — otherwise a relaunch left it with no action.
        setActiveEntry(null)
        const last = data.length ? data[data.length - 1] : null
        setIsPaused(!!last?.pause_reason && job.status !== 'completed')
      }
      const total = data.filter(e => e.clocked_out_at).reduce((s, e) => s + (e.duration_minutes || 0), 0)
      setElapsedMinutes(total)
    }
  }

  async function loadChecklist() {
    const addrId = job.client_addresses?.id || job.address_id
    if (!addrId) {
      // Fallback: lookup by street
      const street = job.client_addresses?.street
      if (!street) return loadChecklistForAddress(null)
      setLoadingChecklist(true)
      const { data: addrData } = await supabase
        .from('client_addresses').select('id')
        .eq('street', street).eq('tenant_id', user.tenant_id).maybeSingle()
      return loadChecklistForAddress(addrData?.id || null)
    }
    setLoadingChecklist(true)
    return loadChecklistForAddress(addrId)
  }

  // The job's own checklist rows (seeded at job creation) are the shared
  // source of truth with the owner dashboard — both sides must read the same
  // rows and the same `completed` flags, or the crew and the owner see
  // different checklists. A row EXISTING does not mean it's done; only
  // `completed = true` does. Templates are a fallback for jobs that were
  // never seeded; the built-in default list covers properties with no
  // template at all.
  async function loadChecklistForAddress(addressId: string | null) {
    setLoadingChecklist(true)
    const [tmplRes, rowsRes] = await Promise.all([
      addressId
        ? supabase.from('address_checklist_templates')
            .select('id, room, title, sort_order, requires_photo')
            .eq('address_id', addressId)
            .order('room').order('sort_order')
        : Promise.resolve({ data: [] as any[] }),
      supabase.from('job_checklist_items')
        .select('id, room, task, sort_order, completed, photo_required')
        .eq('job_id', job.id)
        .order('room').order('sort_order'),
    ])
    const tmpl = tmplRes.data || []
    const rows = rowsRes.data || []
    let items: any[]
    const checkedMap: Record<string, boolean> = {}
    if (rows.length > 0 && tmpl.length > 0) {
      items = rows.map(r => ({ id: r.id, jobItemId: r.id, label: `${r.room} — ${r.task}`, room: r.room, title: r.task, requires_photo: r.photo_required || false }))
      rows.forEach(r => { if (r.completed) checkedMap[r.id] = true })
    } else if (tmpl.length > 0) {
      // Template exists but this job was never seeded — ticks upsert rows.
      items = tmpl.map(item => ({ id: item.id, label: `${item.room} — ${item.title}`, room: item.room, title: item.title, requires_photo: item.requires_photo || false }))
    } else {
      // No template: default list, merged with any rows the crew already
      // created so re-opening the job keeps the ticks.
      const byKey = new Map(rows.map(r => [`${r.room}|${r.task}`, r]))
      items = DEFAULT_CHECKLIST.map(d => {
        const r = byKey.get(`${d.room}|${d.title}`)
        if (r?.completed) checkedMap[d.id] = true
        return { ...d, jobItemId: r?.id, requires_photo: r?.photo_required || false }
      })
      // Rows outside the default list (seeded from a since-deleted template)
      // still show — the owner sees them too.
      rows.filter(r => !DEFAULT_CHECKLIST.some(d => d.room === r.room && d.title === r.task)).forEach(r => {
        items.push({ id: r.id, jobItemId: r.id, label: `${r.room} — ${r.task}`, room: r.room, title: r.task, requires_photo: r.photo_required || false })
        if (r.completed) checkedMap[r.id] = true
      })
    }
    setChecklist(items)
    setChecked(checkedMap)
    const { data: photos } = await supabase.from('job_photos').select('caption').eq('job_id', job.id)
    if (photos) {
      const counts: Record<string, number> = {}
      items.forEach(item => { counts[item.id] = photos.filter(p => p.caption === item.title).length })
      setItemPhotos(counts)
    }
    setLoadingChecklist(false)
  }

  async function saveCheckItem(item: any, isChecked: boolean) {
    // Ticks save optimistically — on failure, revert the box and tell the
    // crew, or they walk away believing the checklist is done when it isn't.
    let error
    if (item.jobItemId) {
      // Seeded row — flip the same flag the owner dashboard reads. Never
      // delete: these rows ARE the owner's checklist.
      ;({ error } = await supabase.from('job_checklist_items').update({
        completed: isChecked,
        completed_at: isChecked ? new Date().toISOString() : null,
        completed_by: isChecked ? user.id : null,
      }).eq('id', item.jobItemId))
    } else if (isChecked) {
      ;({ error } = await supabase.from('job_checklist_items').upsert({
        tenant_id: user.tenant_id, job_id: job.id,
        room: item.room, task: item.title, sort_order: 0,
        completed: true, completed_at: new Date().toISOString(), completed_by: user.id,
      }, { onConflict: 'job_id,task,room' }))
    } else {
      ;({ error } = await supabase.from('job_checklist_items').update({
        completed: false, completed_at: null, completed_by: null,
      }).eq('job_id', job.id).eq('task', item.title).eq('room', item.room))
    }
    if (error) {
      setChecked(prev => ({ ...prev, [item.id]: !isChecked }))
      Alert.alert(t('error'), t('could_not_save'))
    }
  }

  async function handleClockIn() {
    setSaving(true)
    // Create time entry — this row IS the crew member's pay. If the insert
    // fails (dead spot, RLS hiccup) we must NOT mark the job in_progress:
    // that's exactly the "worked all day, no hours on payroll" failure.
    const { data: entry, error: entryErr } = await supabase.from('job_time_entries').insert({
      tenant_id: user.tenant_id, job_id: job.id, user_id: user.id,
      clocked_in_at: new Date().toISOString(), entry_type: 'work',
    }).select().single()
    if (entryErr || !entry) {
      setSaving(false)
      Alert.alert(t('error'), t('clock_in_failed'))
      return
    }
    setActiveEntry(entry)
    setIsPaused(false)
    // Begin broadcasting location now that they're clocked in (don't wait for
    // an app relaunch, and don't require a job_assignment). Clock-in is the
    // user-initiated moment where we escalate to the "Always" location prompt
    // so tracking keeps working with the phone in their pocket.
    startLocationTracking(user, { requestBackground: true }).catch(() => {})
    // Update job status
    await supabase.from('jobs').update({ status: 'in_progress' }).eq('id', job.id)
    onStatusChange(job, 'in_progress')
    loadTimeEntries()
    setSaving(false)
  }

  // Daily mode: start the clean for status + photo proof only — no per-job
  // time entry (hours come from the day's shift on the Dashboard).
  async function startJobDaily() {
    setSaving(true)
    await supabase.from('jobs').update({ status: 'in_progress' }).eq('id', job.id)
    onStatusChange(job, 'in_progress')
    setSaving(false)
  }

  // "On my way" — one tap tells dispatch (and the client portal, which already
  // shows "On the way") the crew is heading to this job, and starts GPS now so
  // they appear moving on the dispatch map BEFORE they arrive. No time entry /
  // no pay yet — that begins at clock-in when they get there.
  async function handleOnMyWay() {
    setSaving(true)
    // Set en_route FIRST, then start tracking — location broadcasting is now
    // gated on being actively working (clocked in OR en_route/in_progress), so
    // the status must be committed before startLocationTracking checks it.
    const { error } = await supabase.from('jobs').update({ status: 'en_route' }).eq('id', job.id)
    if (error) { setSaving(false); Alert.alert(t('error'), t('en_route_failed')); return }
    onStatusChange(job, 'en_route')
    startLocationTracking(user, { requestBackground: true }).catch(() => {})
    setSaving(false)
  }

  async function handlePause() {
    setShowPauseModal(true)
  }

  async function confirmPause() {
    if (!pauseReason) { Alert.alert(t('select_reason')); return }
    setSaving(true)
    const now = new Date()
    const mins = (now.getTime() - new Date(activeEntry.clocked_in_at).getTime()) / 60000
    const { error: pauseErr } = await supabase.from('job_time_entries').update({
      clocked_out_at: now.toISOString(),
      pause_reason: pauseReason,
      duration_minutes: Math.round(mins),
    }).eq('id', activeEntry.id)
    if (pauseErr) {
      setSaving(false)
      Alert.alert(t('error'), t('clock_out_failed'))
      return
    }
    setActiveEntry(null)
    setIsPaused(true)
    setShowPauseModal(false)
    setPauseReason('')
    loadTimeEntries()
    setSaving(false)
  }

  async function handleResume() {
    setSaving(true)
    const { data: entry, error: resumeErr } = await supabase.from('job_time_entries').insert({
      tenant_id: user.tenant_id, job_id: job.id, user_id: user.id,
      clocked_in_at: new Date().toISOString(), entry_type: 'work',
    }).select().single()
    if (resumeErr || !entry) {
      setSaving(false)
      Alert.alert(t('error'), t('clock_in_failed'))
      return
    }
    setActiveEntry(entry)
    setIsPaused(false)
    startLocationTracking(user, { requestBackground: true }).catch(() => {})
    loadTimeEntries()
    setSaving(false)
  }

  async function completeJob() {
    // Enforce at least 1 after photo — cleans only; laundry runs have no
    // property to photograph (their proof is the reconciliation form).
    if (isTask) { await completeJobNoPhotoCheck(); return }
    // Photos taken with no signal wait in the on-device queue; give them a
    // chance to land now so the gate below sees them.
    try { await flushQueue() } catch { /* offline — handled below */ }
    const { data: afterPhotos } = await supabase
      .from('job_photos')
      .select('id')
      .eq('job_id', job.id)
      .in('photo_type', ['after', 'general'])
      .limit(1)

    if (!afterPhotos || afterPhotos.length === 0) {
      const queued = await pendingStatus(job.id).catch((): PendingStatus => ({ count: 0, serverRejected: 0, lastServerError: null }))
      if (queued.count > 0) {
        if (queued.serverRejected > 0) {
          // The server is rejecting the uploads — waiting for signal won't
          // help, so say what's wrong and who can fix it instead.
          Alert.alert(
            `⚠️ ${t('photo_upload_failing_title')}`,
            ti(t('photo_pending_complete_failing_msg'), { error: queued.lastServerError || '?' }),
          )
          return
        }
        // Photos exist but can't reach the server yet — completing needs
        // signal too, so a dead-end "photo required" here reads as a bug.
        Alert.alert(`📥 ${t('photo_pending_complete_title')}`, t('photo_pending_complete_msg'))
        return
      }
      Alert.alert(
        `📸 ${t('photo_required_alert')}`,
        t('add_after_photo_msg'),
        [
          { text: t('add_photo_btn'), onPress: () => { setActivePhotoItem(null); setShowPhotos(true) } },
          { text: t('cancel'), style: 'cancel' }
        ]
      )
      return
    }
    // Per-item photo requirements: every 📷-required checklist task needs a
    // photo before the job can complete (the owner-side panel enforces the
    // same rule, so completing here without them would just bounce later).
    const required = checklist.filter((i: any) => i.requires_photo)
    if (required.length > 0) {
      const { data: photoRows } = await supabase.from('job_photos').select('caption').eq('job_id', job.id)
      const missing = required.filter((i: any) => !(photoRows || []).some(p => p.caption === i.title))
      if (missing.length > 0) {
        const queued = await pendingCount(job.id).catch(() => 0)
        if (queued > 0) {
          Alert.alert(`📥 ${t('photo_pending_complete_title')}`, t('photo_pending_complete_msg'))
          return
        }
        Alert.alert(
          `📸 ${t('photo_required_alert')}`,
          `${t('item_photos_missing_msg')}\n\n• ${missing.map((i: any) => i.labelKey ? t(i.labelKey) : (i.label || i.title)).join('\n• ')}`,
          [
            { text: t('add_photo_btn'), onPress: () => { setActivePhotoItem(missing[0]); setShowPhotos(true) } },
            { text: t('cancel'), style: 'cancel' }
          ]
        )
        return
      }
    }
    await completeJobNoPhotoCheck()
  }

  async function completeJobNoPhotoCheck() {
    setSaving(true)
    // Clock out active entry — the clock-out IS the paid duration. If it
    // fails, bail before marking complete: an open entry on a "completed"
    // job would run forever and corrupt payroll.
    if (activeEntry) {
      const now = new Date()
      const mins = (now.getTime() - new Date(activeEntry.clocked_in_at).getTime()) / 60000
      const { error: outErr } = await supabase.from('job_time_entries').update({
        clocked_out_at: now.toISOString(),
        duration_minutes: Math.round(mins),
      }).eq('id', activeEntry.id)
      if (outErr) {
        setSaving(false)
        Alert.alert(t('error'), t('clock_out_failed'))
        return
      }
    }
    const { error: doneErr } = await supabase.from('jobs').update({ status: 'completed', internal_notes: notes.trim() || null }).eq('id', job.id)
    if (doneErr) {
      setSaving(false)
      Alert.alert(t('error'), doneErr.message)
      return
    }
    // Done working? Stop GPS. (No-op if another entry/shift is still open or
    // more jobs remain today — daily-shift crews keep broadcasting.)
    maybeStopLocationTracking(user).catch(() => {})
    onStatusChange(job, 'completed')
    onBack()
    setSaving(false)
  }

  const completedCount = Object.values(checked).filter(Boolean).length
  const allChecked = checklist.every(i => checked[i.id])
  const progressPct = Math.round((completedCount / checklist.length) * 100)

  if (showMessages) return <MessagesScreen job={job} user={user} onBack={() => setShowMessages(false)} />
  if (showInventory) return <JobInventoryScreen job={job} user={user} onBack={() => setShowInventory(false)} />
  if (showLaundry) return <LaundryRunScreen job={job} user={user} onBack={() => setShowLaundry(false)} />
  if (showPhotos) return <JobPhotosScreen job={job} user={user} preselectedItem={activePhotoItem} onBack={() => { setShowPhotos(false); loadChecklist() }} />

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}><Text style={styles.backText}>← {t('back')}</Text></TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{isLaundry ? `🧺 ${t('laundry_run')}` : job.job_type === 'task' ? `📌 ${(job.internal_notes || t('task')).split('\n')[0]}` : (propLabel || t('job_detail'))}</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Property photo — not for laundry runs (internal shell property) */}
        {isTask ? null : addr?.photo_url ? (
          <TouchableOpacity activeOpacity={0.85} onPress={() => setViewPropertyPhoto(true)}>
            <Image source={{ uri: addr.photo_url }} style={{ width: '100%', height: 180, borderRadius: 12, marginBottom: 12 }} resizeMode="cover" />
          </TouchableOpacity>
        ) : addr?.id && (
          <TouchableOpacity
            style={{ width: '100%', height: 100, borderRadius: 12, marginBottom: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: TEAL + '60', backgroundColor: TEAL + '08', alignItems: 'center', justifyContent: 'center' }}
            onPress={async () => {
              try {
                // Gate on camera permission — launchCameraAsync throws
                // "Missing camera or camera roll permission" if it isn't granted.
                if (await ensureCamera() !== 'granted') return
                const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.8 })
                if (result.canceled || !result.assets?.[0]) return
                const asset = result.assets[0]
                const ext = asset.uri.split('.').pop() || 'jpg'
                const path = `${user.tenant_id}/properties/${addr.id}_${Date.now()}.${ext}`
                const response = await fetch(asset.uri)
                const blob = await response.blob()
                const { error: upErr } = await supabase.storage.from('job-photos').upload(path, blob, { contentType: `image/${ext}`, upsert: true })
                if (upErr) { Alert.alert(t('upload_failed'), upErr.message); return }
                const { data: urlData } = supabase.storage.from('job-photos').getPublicUrl(path)
                await supabase.from('client_addresses').update({ photo_url: urlData.publicUrl }).eq('id', addr.id)
                Alert.alert(t('photo_saved'), t('property_photo_saved'))
              } catch (err: any) { Alert.alert(t('error'), err.message || t('upload_failed')) }
            }}>
            <Text style={{ fontSize: 24, color: TEAL, marginBottom: 4 }}>📷</Text>
            <Text style={{ fontSize: 12, color: TEAL, fontWeight: '600' }}>{t('take_property_photo')}</Text>
          </TouchableOpacity>
        )}

        {/* Job info card */}
        <View style={styles.card}>
          <Text style={styles.clientName}>{isLaundry ? `🧺 ${t('laundry_run')}` : job.job_type === 'task' ? `📌 ${(job.internal_notes || t('task')).split('\n')[0]}` : <>{propLabel}{job.is_turnover ? `  🏠 ${t('turnover')}` : ''}</>}</Text>
          {routeStop && (
            <View style={styles.routeStopBadge}>
              <Text style={styles.routeStopText}>🧭 {ti(t('route_stop_of'), { k: String(routeStop.k), m: String(routeStop.m) })}</Text>
            </View>
          )}
          <Text style={styles.timeRow}>🕐 {fmtTime(job.scheduled_start)} – {fmtTime(job.scheduled_end)}</Text>
          {turnover?.checkout && (
            <View style={{ backgroundColor: turnover.urgency === 'rapid' ? '#FEF2F2' : turnover.urgency === 'tight' ? '#FFFBEB' : '#EFF6FF', borderRadius: 10, padding: 10, marginTop: 8, marginBottom: 4 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827' }}>🧳 {t('guest_checkout')}: {fmtTime(turnover.checkout)}</Text>
              {turnover.checkin && (
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#111827', marginTop: 3 }}>🔑 {t('next_checkin')}: {fmtTime(turnover.checkin)}</Text>
              )}
              {guestCount != null && (
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#374151', marginTop: 3 }}>👥 {ti(t('guests_stayed'), { n: String(guestCount) })}</Text>
              )}
              {turnover.window != null && (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                  <View style={{ backgroundColor: turnover.urgency === 'rapid' ? '#DC2626' : turnover.urgency === 'tight' ? '#D97706' : '#2563EB', borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>↔ {t('back_to_back')}</Text>
                  </View>
                  <Text style={{ fontSize: 12, fontWeight: '700', marginLeft: 8, color: '#374151' }}>{ti(t('turnover_window'), { h: String(Math.round(turnover.window / 60 * 10) / 10) })}</Text>
                </View>
              )}
            </View>
          )}
          {!isTask && (
          <TouchableOpacity onPress={() => {
            const q = addr?.lat ? `${addr.lat},${addr.lng}` : `${addr?.street}, ${addr?.city}`
            Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(q)}`)
          }}>
            <Text style={styles.address}>📍 {addr?.street}, {addr?.city}</Text>
          </TouchableOpacity>
          )}
          {(propMeta?.bedrooms != null || propMeta?.bathrooms != null || propMeta?.sqft != null) && (
            <Text style={styles.propSpecs}>
              🏠 {[
                propMeta?.bedrooms != null ? `${propMeta.bedrooms} ${t('beds_short')}` : null,
                propMeta?.bathrooms != null ? `${propMeta.bathrooms} ${t('baths_short')}` : null,
                propMeta?.beds != null ? `🛏 ${propMeta.beds} ${t('beds_total_short')}` : null,
                propMeta?.sqft != null ? `${propMeta.sqft.toLocaleString()} ${t('sqft_short')}` : null,
              ].filter(Boolean).join('   ·   ')}
            </Text>
          )}
          {accessCode && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>🔑</Text>
              <View><Text style={styles.infoLabel}>{t('crew_door_code')}</Text><Text style={styles.infoValue}>{accessCode}</Text></View>
            </View>
          )}
          {addr?.lockbox_code && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>🔐</Text>
              <View><Text style={styles.infoLabel}>{t('lockbox_code')}</Text><Text style={styles.infoValue}>{addr.lockbox_code}</Text></View>
            </View>
          )}
          {addr?.arrival_instructions && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>📋</Text>
              <View style={{ flex: 1 }}><Text style={styles.infoLabel}>{t('arrival_instructions')}</Text><Text style={styles.infoValue}>{addr.arrival_instructions}</Text></View>
            </View>
          )}
          {!isTask && propMeta?.crew_notes && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>📄</Text>
              <View style={{ flex: 1 }}><Text style={styles.infoLabel}>{t('property_notes')}</Text><Text style={styles.infoValue}>{propMeta.crew_notes}</Text></View>
            </View>
          )}
          {!isTask && bagColor && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>🧺</Text>
              <View style={{ flex: 1 }}><Text style={styles.infoLabel}>{t('laundry_bags_label')}</Text><Text style={styles.infoValue}>{bagColor}</Text></View>
            </View>
          )}
          {!isTask && job.internal_notes && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>📝</Text>
              <View style={{ flex: 1 }}><Text style={styles.infoLabel}>{t('job_notes')}</Text><Text style={styles.infoValue}>{job.internal_notes}</Text></View>
            </View>
          )}
          {!isTask && crewOnJob.length > 0 && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>👥</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.infoLabel}>{t('crew_on_job')}</Text>
                <Text style={styles.infoValue}>
                  {crewOnJob.map(c => c.isLead ? `${c.name} (${t('lead_tag')})` : c.name).join(' · ')}
                </Text>
              </View>
            </View>
          )}
          {/* Direct host contact only if the owner allows it; otherwise crew
              reach dispatch (the office), keeping the company as the single
              point of contact with the host. */}
          {user._contact?.crewCanContactClient && client?.phone ? (
            <TouchableOpacity style={styles.callBtn} onPress={() => Linking.openURL(`tel:${client.phone}`)}>
              <Text style={styles.callBtnText}>📞 {t('call_client')} {client.full_name?.split(' ')[0]}</Text>
            </TouchableOpacity>
          ) : user._contact?.dispatchPhone ? (
            <TouchableOpacity style={styles.callBtn} onPress={() => Linking.openURL(`tel:${user._contact.dispatchPhone}`)}>
              <Text style={styles.callBtnText}>📞 {t('call_dispatch')}</Text>
            </TouchableOpacity>
          ) : null}
          {isLaundry ? (
            <TouchableOpacity style={[styles.suppliesBtn, { borderColor: TEAL }]} onPress={() => setShowLaundry(true)}>
              <Text style={[styles.suppliesBtnText, { color: TEAL }]}>🧺 {t('laundry_form')}</Text>
            </TouchableOpacity>
          ) : !isTask ? (<>
          <TouchableOpacity style={styles.photosBtn} onPress={() => { setActivePhotoItem(null); setShowPhotos(true) }}>
            <Text style={styles.photosBtnText}>📸 {t('job_photos')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.suppliesBtn} onPress={() => setShowInventory(true)}>
            <Text style={styles.suppliesBtnText}>📦 {t('supplies')}</Text>
          </TouchableOpacity>
          </>) : null}
          <TouchableOpacity style={styles.messagesBtn} onPress={() => setShowMessages(true)}>
            <Text style={styles.messagesBtnText}>💬 {t('messages')}</Text>
          </TouchableOpacity>
        </View>

        {/* Time tracker card */}
        <View style={[styles.card, isClockedIn && { borderColor: TEAL, borderWidth: 2 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={styles.sectionTitle}>{dailyMode ? '🧹 ' + t('this_job') : '⏱ ' + t('time_tracker')}</Text>
            {!dailyMode && elapsedMinutes > 0 && (
              <Text style={{ fontSize: 18, fontWeight: '900', color: TEAL }}>{fmtDuration(elapsedMinutes)}</Text>
            )}
          </View>

          {/* Time entries history */}
          {!dailyMode && timeEntries.filter(e => e.clocked_out_at).map((entry, i) => (
            <View key={entry.id} style={styles.timeEntry}>
              <Text style={styles.timeEntryText}>
                {t('session')} {i + 1}: {fmtTime(entry.clocked_in_at)} – {fmtTime(entry.clocked_out_at)}
              </Text>
              <Text style={styles.timeEntryDuration}>{fmtDuration(entry.duration_minutes || 0)}</Text>
              {entry.pause_reason && <Text style={styles.timeEntryReason}>⏸ {entry.pause_reason}</Text>}
            </View>
          ))}

          {/* Active session */}
          {!dailyMode && isClockedIn && (
            <View style={[styles.timeEntry, { backgroundColor: '#ECFDF5', borderColor: TEAL }]}>
              <Text style={[styles.timeEntryText, { color: '#065F46' }]}>
                🟢 {t('active_since')} {fmtTime(activeEntry.clocked_in_at)}
              </Text>
            </View>
          )}

          {!dailyMode && isPaused && (
            <View style={[styles.timeEntry, { backgroundColor: '#FEF9C3', borderColor: '#FCD34D' }]}>
              <Text style={[styles.timeEntryText, { color: '#854D0E' }]}>⏸ {t('paused')}</Text>
            </View>
          )}

          {/* On my way — tell dispatch you're heading out (starts GPS early).
              Mode-agnostic: shows before the clean is started. */}
          {job.status === 'scheduled' && (
            <TouchableOpacity style={[styles.clockBtn, { backgroundColor: '#8B5CF6', marginTop: 12 }]} onPress={handleOnMyWay} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.clockBtnText}>🚗 {t('on_my_way')}</Text>}
            </TouchableOpacity>
          )}
          {job.status === 'en_route' && (
            <View style={[styles.timeEntry, { backgroundColor: '#F5F3FF', borderColor: '#DDD6FE', marginTop: 12 }]}>
              <Text style={[styles.timeEntryText, { color: '#6D28D9' }]}>🚗 {t('on_the_way_banner')}</Text>
            </View>
          )}

          {/* Daily mode: Start / Complete only — no per-job timer. */}
          {dailyMode && job.status !== 'completed' && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              {job.status !== 'in_progress' ? (
                <TouchableOpacity style={[styles.clockBtn, { backgroundColor: TEAL }]} onPress={startJobDaily} disabled={saving}>
                  {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.clockBtnText}>{t('start_job')}</Text>}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={[styles.clockBtn, { backgroundColor: '#10B981' }]} onPress={() => {
                  Alert.alert(t('complete_job_confirm'), '', [
                    { text: t('cancel'), style: 'cancel' },
                    { text: t('complete_job'), onPress: completeJob },
                  ])
                }} disabled={saving}>
                  <Text style={styles.clockBtnText}>✓ {t('complete_job')}</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Action buttons */}
          {!dailyMode && job.status !== 'completed' && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              {!isStarted && (
                <TouchableOpacity style={[styles.clockBtn, { backgroundColor: TEAL }]} onPress={handleClockIn} disabled={saving}>
                  {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.clockBtnText}>{t('clock_in_short')}</Text>}
                </TouchableOpacity>
              )}
              {isClockedIn && (
                <>
                  <TouchableOpacity style={[styles.clockBtn, { backgroundColor: '#F59E0B', flex: 1 }]} onPress={handlePause} disabled={saving}>
                    <Text style={styles.clockBtnText}>⏸ {t('pause')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.clockBtn, { backgroundColor: '#10B981', flex: 1 }]} onPress={() => {
                    Alert.alert(t('complete_job_confirm'), `${t('total_time')}: ${fmtDuration(elapsedMinutes)}`, [
                      { text: t('cancel'), style: 'cancel' },
                      { text: t('complete_job'), onPress: completeJob }
                    ])
                  }} disabled={saving}>
                    <Text style={styles.clockBtnText}>✓ Complete</Text>
                  </TouchableOpacity>
                </>
              )}
              {isPaused && (
                <TouchableOpacity style={[styles.clockBtn, { backgroundColor: TEAL }]} onPress={handleResume} disabled={saving}>
                  {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.clockBtnText}>{t('resume')}</Text>}
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        {/* Checklist — cleans only; laundry runs use the reconciliation form */}
        {isStarted && !isTask && (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={styles.sectionTitle}>{t('cleaning_checklist')}</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: TEAL }}>{completedCount}/{checklist.length}</Text>
            </View>
            <View style={styles.progressBg}><View style={[styles.progressFill, { width: `${progressPct}%` as any }]} /></View>
            {loadingChecklist ? (
              <ActivityIndicator color={TEAL} style={{ marginVertical: 20 }} />
            ) : checklist.map((item: any) => (
              <View key={item.id} style={styles.checkItem}>
                <TouchableOpacity onPress={() => {
                  const newVal = !checked[item.id]
                  if (newVal && item.requires_photo && !itemPhotos[item.id]) {
                    // Photo-required task: proof first, then the tick.
                    Alert.alert(`📸 ${t('photo_required_alert')}`, t('item_photo_before_check_msg'), [
                      { text: t('add_photo_btn'), onPress: () => { setActivePhotoItem(item); setShowPhotos(true) } },
                      { text: t('cancel'), style: 'cancel' },
                    ])
                    return
                  }
                  setChecked(prev => ({ ...prev, [item.id]: newVal }))
                  saveCheckItem(item, newVal)
                }} style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 }}>
                  <View style={[styles.checkbox, checked[item.id] && styles.checkboxDone]}>
                    {checked[item.id] && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>✓</Text>}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.checkLabel, checked[item.id] && { color: '#9CA3AF', textDecorationLine: 'line-through' }]}>{item.labelKey ? t(item.labelKey) : item.label}</Text>
                    {item.requires_photo && !itemPhotos[item.id] && (
                      <Text style={{ fontSize: 9, color: TEAL, fontWeight: '700', marginTop: 2 }}>{t('photo_required_short')}</Text>
                    )}
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.itemPhotoBtn, itemPhotos[item.id] > 0 && styles.itemPhotoBtnDone, item.requires_photo && !itemPhotos[item.id] && { borderColor: TEAL, borderWidth: 1.5 }]}
                  onPress={() => { setActivePhotoItem(item); setShowPhotos(true) }}
                >
                  <Text style={styles.itemPhotoBtnText}>{itemPhotos[item.id] > 0 ? `📷 ${itemPhotos[item.id]}` : item.requires_photo ? '📷!' : '📷'}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Take-home laundry — cleaner bags laundry on a clean and washes it at
            home for the per-bag bonus. Only shows when the tenant pays one. */}
        {isStarted && !isTask && !isResidential && user._laundryBonus > 0 && <TakeHomeLaundryCard job={job} user={user} bagColor={bagColor} />}

        {/* All laundry done on-site — one-tap flag, counted per crew on Payroll */}
        {isStarted && !isTask && !isResidential && (
          <View style={styles.card}>
            <TouchableOpacity onPress={toggleLaundryDoneOnsite} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={[styles.checkbox, laundryDoneOnsite && styles.checkboxDone]}>
                {laundryDoneOnsite && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkLabel}>🧺 {t('laundry_done_onsite')}</Text>
                <Text style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{t('laundry_done_onsite_hint')}</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* Stay condition rating — how the guests left it (host sees it with photos) */}
        {isStarted && !isTask && !isResidential && <StayRatingCard job={job} user={user} />}

        {/* Lost & found — log a guest belonging left behind (manager reviews before host is told) */}
        {isStarted && !isTask && <LostFoundCard job={job} user={user} />}

        {/* Notes */}
        {isStarted && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t('notes_optional')}</Text>
            <TextInput style={styles.notesInput} value={notes} onChangeText={setNotes} placeholder={t('notes_placeholder')} placeholderTextColor="#9CA3AF" multiline numberOfLines={3} />
          </View>
        )}

        {job.status === 'completed' && (
          <View style={styles.completedBanner}>
            <Text style={{ color: '#065F46', fontSize: 16, fontWeight: '800' }}>✓ {t('job_completed')}</Text>
            {elapsedMinutes > 0 && <Text style={{ color: '#065F46', fontSize: 13, marginTop: 4 }}>{t('total_time')}: {fmtDuration(elapsedMinutes)}</Text>}
          </View>
        )}
      </ScrollView>

      {viewPropertyPhoto && addr?.photo_url && (
        <PhotoViewer
          photos={[{ url: addr.photo_url, caption: propLabel || null, meta: t('property_photo') }]}
          onClose={() => setViewPropertyPhoto(false)}
        />
      )}

      {/* Pause modal */}
      <Modal visible={showPauseModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>⏸ {t('pause_title')}</Text>
            <Text style={styles.modalSub}>{t('pause_subtitle')}</Text>
            {PAUSE_REASONS.map(({ value, key }) => (
              <TouchableOpacity
                key={value}
                style={[styles.reasonBtn, pauseReason === value && styles.reasonBtnActive]}
                onPress={() => setPauseReason(value)}
              >
                <Text style={[styles.reasonBtnText, pauseReason === value && { color: '#fff' }]}>{t(key)}</Text>
              </TouchableOpacity>
            ))}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => { setShowPauseModal(false); setPauseReason('') }}>
                <Text style={{ color: '#6B7280', fontWeight: '600' }}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalConfirmBtn, !pauseReason && { opacity: 0.4 }]} onPress={confirmPause} disabled={!pauseReason || saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>{t('pause_job')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  backBtn: { padding: 4 },
  backText: { color: TEAL, fontSize: 14, fontWeight: '600' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center', marginHorizontal: 8 },
  scroll: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, borderWidth: 1, borderColor: '#F3F4F6' },
  clientName: { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 6 },
  routeStopBadge: { alignSelf: 'flex-start', backgroundColor: '#F5F3FF', borderColor: '#DDD6FE', borderWidth: 1, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 4, marginBottom: 8 },
  routeStopText: { fontSize: 12, fontWeight: '800', color: '#6D28D9' },
  timeRow: { fontSize: 14, color: '#374151', marginBottom: 6, fontWeight: '500' },
  address: { fontSize: 13, color: TEAL, marginBottom: 14, fontWeight: '500' },
  propSpecs: { fontSize: 14, color: '#374151', fontWeight: '700', marginTop: -8, marginBottom: 14 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: 10, backgroundColor: '#F9FAFB', borderRadius: 10 },
  infoIcon: { fontSize: 18 },
  infoLabel: { fontSize: 10, color: '#9CA3AF', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  infoValue: { fontSize: 14, color: '#111827', fontWeight: '600', marginTop: 2 },
  callBtn: { marginTop: 4, backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#BBF7D0', borderRadius: 10, padding: 12, alignItems: 'center' },
  callBtnText: { color: '#15803D', fontSize: 13, fontWeight: '700' },
  messagesBtn: { marginTop: 8, backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#6EE7B7', borderRadius: 10, padding: 12, alignItems: 'center' },
  messagesBtnText: { color: '#065F46', fontSize: 13, fontWeight: '700' },
  photosBtn: { marginTop: 8, backgroundColor: '#F5F3FF', borderWidth: 1, borderColor: '#DDD6FE', borderRadius: 10, padding: 12, alignItems: 'center' },
  photosBtnText: { color: '#7C3AED', fontSize: 13, fontWeight: '700' },
  suppliesBtn: { marginTop: 8, backgroundColor: '#FFFBEB', borderWidth: 1, borderColor: '#FCD34D', borderRadius: 10, padding: 12, alignItems: 'center' },
  suppliesBtnText: { color: '#92400E', fontSize: 13, fontWeight: '700' },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#111827' },
  timeEntry: { backgroundColor: '#F9FAFB', borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: '#E5E7EB' },
  timeEntryText: { fontSize: 12, color: '#374151', fontWeight: '600' },
  timeEntryDuration: { fontSize: 12, color: TEAL, fontWeight: '700', marginTop: 2 },
  timeEntryReason: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  clockBtn: { flex: 1, borderRadius: 12, padding: 14, alignItems: 'center', justifyContent: 'center' },
  clockBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  progressBg: { height: 6, backgroundColor: '#F3F4F6', borderRadius: 3, marginBottom: 14, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: TEAL, borderRadius: 3 },
  checkItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F9FAFB', gap: 12 },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center' },
  checkboxDone: { backgroundColor: TEAL, borderColor: TEAL },
  checkLabel: { fontSize: 13, color: '#374151', flex: 1 },
  itemPhotoBtn: { padding: 8, borderRadius: 8, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: '#E5E7EB' },
  itemPhotoBtnDone: { backgroundColor: '#ECFDF5', borderColor: '#6EE7B7' },
  itemPhotoBtnText: { fontSize: 14 },
  notesInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, padding: 12, fontSize: 13, color: '#111827', minHeight: 80, textAlignVertical: 'top', marginTop: 8 },
  completedBanner: { backgroundColor: '#D1FAE5', borderRadius: 14, padding: 18, alignItems: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#111827', marginBottom: 6 },
  modalSub: { fontSize: 13, color: '#9CA3AF', marginBottom: 16 },
  reasonBtn: { padding: 14, borderRadius: 12, borderWidth: 1.5, borderColor: '#E5E7EB', marginBottom: 8, backgroundColor: '#F9FAFB' },
  reasonBtnActive: { backgroundColor: NAVY, borderColor: NAVY },
  reasonBtnText: { fontSize: 14, fontWeight: '600', color: '#374151' },
  modalCancelBtn: { flex: 1, padding: 14, borderRadius: 12, alignItems: 'center', backgroundColor: '#F3F4F6' },
  modalConfirmBtn: { flex: 1, padding: 14, borderRadius: 12, alignItems: 'center', backgroundColor: '#EF4444' },
})
