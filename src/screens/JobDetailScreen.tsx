import React, { useState, useEffect, useRef } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert, Linking, ActivityIndicator, Modal, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { ensureCameraCapture } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { JobPhotosScreen } from './JobPhotosScreen'
import { JobInventoryScreen } from './JobInventoryScreen'
import { LaundryRunScreen } from './LaundryRunScreen'
import { JobInspectionScreen } from './JobInspectionScreen'
import { MessagesScreen } from './MessagesScreen'
import { StayRatingCard } from '../components/StayRatingCard'
import { PhotoViewer } from '../components/PhotoViewer'
import { IncidentReportCard } from '../components/IncidentReportCard'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'

import { SLATE_DARK, GOLD } from '../lib/theme'
import { startLocationTracking, maybeStopLocationTracking } from '../lib/locationTracker'
import { getPendingArrival, clearPendingArrival, quickGpsStamp } from '../lib/arrivalGeofence'
import { flushQueue, pendingStatus, PendingStatus } from '../lib/photoQueue'
import { cachedQuery } from '../lib/dataCache'
import { writeThrough, overlayPending, flushOutbox, uuid4 } from '../lib/outbox'
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
  const [showInspection, setShowInspection] = useState(false)
  const [checklist, setChecklist] = useState(DEFAULT_CHECKLIST as any[])
  const [loadingChecklist, setLoadingChecklist] = useState(false)
  const [itemPhotos, setItemPhotos] = useState<Record<string, number>>({})
  const [activePhotoItem, setActivePhotoItem] = useState<any>(null)
  // Turnover rooms (phase 2): the checklist renders as a room accordion.
  // roomsMeta comes from property_rooms; items carry room_id/item_kind/level/
  // result from the seeded job rows. signoffs = job_room_signoffs for this job.
  const [roomsMeta, setRoomsMeta] = useState<any[]>([])
  const [signoffs, setSignoffs] = useState<Record<string, string>>({})
  const [reqByRoom, setReqByRoom] = useState<Record<string, { total: number; done: number }>>({})
  const [openRooms, setOpenRooms] = useState<Record<string, boolean>>({})
  const [defaultMode, setDefaultMode] = useState<'detailed' | 'room_complete'>('detailed')
  const [issueForId, setIssueForId] = useState<string | null>(null)
  const [issueText, setIssueText] = useState('')
  const [viewPropertyPhoto, setViewPropertyPhoto] = useState(false)

  // Required property shots, surfaced BEFORE the work instead of at completion.
  // These live in property_photo_requirements and were previously visible only
  // inside the Photos screen — so a crew member could clean for three hours and
  // first hear about 19 required photos when they pressed Complete, by which
  // point they had left. Counted here so the button can carry the obligation
  // the whole time. Zero unless the tenant actually enforces (the rows are
  // auto-seeded into every STR property, so an unenforced count is noise).
  const [reqTotal, setReqTotal] = useState(0)
  const [reqDone, setReqDone] = useState(0)
  const [reqAnnounced, setReqAnnounced] = useState(false)

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
  // Owner-uploaded staging/reference photos (how the property should look when
  // done) — crew view them here; tap to open the fullscreen viewer.
  const [stagingPhotos, setStagingPhotos] = useState<{ url: string; caption?: string | null }[]>([])
  const [stagingViewerIndex, setStagingViewerIndex] = useState<number | null>(null)
  // Pet flag — crew mark a clean as having pets → the property's pet_fee lands on
  // this clean's invoice (createJobInvoice / auto-invoice read jobs.pet_fee_applied).
  const [petFeeApplied, setPetFeeApplied] = useState<boolean>(!!job.pet_fee_applied)
  const [petFriendly, setPetFriendly] = useState<boolean>(false)
  const [petFee, setPetFee] = useState<number>(0)
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
  // A quality inspection (Ch.7 §7.8) — a separate visit that verifies somebody
  // else's clean. It is an `isTask` job (no checklist, no supplies, no incident
  // report) but it KEEPS photos: §7.10 makes photographic evidence part of the
  // layer, and it is the only job type with an inspection form. Same tab set the
  // web JobPanel gives it.
  const isInspection = job.job_type === 'inspection'
  // Any internal task (laundry run, generic task): no property/checklist/photos.
  const isTask = !!job.job_type && job.job_type !== 'clean'
  // A task pointed at a REAL property (e.g. a property inspection) — the owner
  // attached a client_addresses row instead of the internal shell (whose street
  // is the sentinel 'Internal task'). Show its address/lockbox/map/photo so the
  // crew know where to go; still no checklist/photos/laundry UI.
  const hasTaskLocation = isTask && !!addr?.street && addr.street !== 'Internal task'
  // The owner's note to crew. On a 📌 task the first line of internal_notes is
  // the task's title (already shown in the header), so only the rest is the
  // note; laundry runs and cleans use the whole field. Shown for ALL job
  // types — the owner uses it to tell crew things like which bags to take.
  const jobNote = (job.job_type === 'task'
    ? String(job.internal_notes || '').split('\n').slice(1).join('\n')
    : String(job.internal_notes || '')).trim()
  const dailyMode = user._timeMode === 'daily'
  const isClockedIn = !!activeEntry && !isPaused
  // In daily mode there's no per-job timer, so "started" tracks job status instead.
  const isStarted = timeEntries.length > 0 || !!activeEntry || (dailyMode && (job.status === 'in_progress' || job.status === 'completed'))

  useEffect(() => {
    // Drain queued offline writes first chance we get (same trigger set as the
    // photo queue: screen mount, app foreground, next write).
    flushOutbox().catch(() => {})
    loadChecklist()
    loadTimeEntries()
    loadPropMeta()
    loadRouteStop()
    loadPhotoRequirements()
  }, [])

  // Live mirror of teammates' phones + the owner dashboard: stream checklist
  // ticks and photo uploads for this job so paired cleaners see each other's
  // progress without reopening the screen. Reloads are quiet (no spinner
  // flash) and debounced to coalesce event bursts. Events fire post-commit,
  // so a refetch always reads the teammate's saved state — our own optimistic
  // ticks are simply confirmed, never reverted.
  useEffect(() => {
    if (isTask) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => loadChecklist(true), 300)
    }
    const channel = supabase
      .channel(`job-detail-${job.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_checklist_items', filter: `job_id=eq.${job.id}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_photos', filter: `job_id=eq.${job.id}` }, reload)
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [job.id])

  // Rank this job among the crew member's own route-ordered jobs for the same
  // day, so the badge is a clean "Stop k of M" (matches the Dashboard).
  async function loadRouteStop() {
    const day = new Date(job.scheduled_start)
    const start = new Date(day); start.setHours(0, 0, 0, 0)
    const end = new Date(day); end.setHours(23, 59, 59, 999)
    const { data } = await cachedQuery(`route:${job.id}:${user.id}`, supabase.from('jobs')
      .select('id, route_order, job_assignments!inner(user_id)')
      .eq('tenant_id', user.tenant_id)
      .eq('job_assignments.user_id', user.id)
      .not('route_order', 'is', null)
      .gte('scheduled_start', start.toISOString())
      .lte('scheduled_start', end.toISOString()))
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
    const { data: jr } = await cachedQuery(`jobmeta:${job.id}`, supabase
      .from('jobs')
      .select('seam_access_code, laundry_done_onsite, pet_fee_applied, checkout_time, checkin_time, window_minutes, urgency, clients!jobs_client_id_fkey(client_type), property_reservations(guest_count)')
      .eq('id', job.id)
      .maybeSingle())
    if ((jr as any)?.seam_access_code) setAccessCode((jr as any).seam_access_code)
    if (jr) {
      setLaundryDoneOnsite(!!(jr as any).laundry_done_onsite)
      setPetFeeApplied(!!(jr as any).pet_fee_applied)
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
    const { data: crewRows } = await cachedQuery(`crew:${job.id}`, supabase
      .from('job_assignments')
      .select('is_lead, users!job_assignments_user_id_fkey(full_name)')
      .eq('job_id', job.id)
      .order('is_lead', { ascending: false }))
    setCrewOnJob((crewRows ?? []).map((a: any) => ({ name: a.users?.full_name, isLead: !!a.is_lead })).filter((c: any) => c.name))

    const addrId = job.client_addresses?.id || job.address_id
    if (!addrId) return
    const { data } = await cachedQuery(`propmeta:${addrId}`, supabase
      .from('client_addresses')
      .select('bedrooms, bathrooms, sqft, beds, crew_notes, laundry_bag_color, staging_photos, pet_friendly, pet_fee')
      .eq('id', addrId)
      .maybeSingle())
    if (data) {
      setPropMeta(data as any)
      setBagColor((data as any).laundry_bag_color ?? null)
      setStagingPhotos(Array.isArray((data as any).staging_photos) ? (data as any).staging_photos : [])
      setPetFriendly(!!(data as any).pet_friendly)
      setPetFee(Number((data as any).pet_fee) || 0)
    }
  }

  async function toggleLaundryDoneOnsite() {
    const next = !laundryDoneOnsite
    setLaundryDoneOnsite(next)
    const { error } = await writeThrough({ table: 'jobs', op: 'update', match: { id: job.id }, values: { laundry_done_onsite: next } })
    if (error) { setLaundryDoneOnsite(!next); Alert.alert(t('error'), error.message) }
  }

  async function togglePetFee() {
    const next = !petFeeApplied
    setPetFeeApplied(next)
    const { error } = await writeThrough({ table: 'jobs', op: 'update', match: { id: job.id }, values: { pet_fee_applied: next } })
    if (error) { setPetFeeApplied(!next); Alert.alert(t('error'), error.message) }
  }

  /**
   * Ask, at completion, whether the stay that just ended had pets.
   *
   * pet_friendly on a property means pets are ALLOWED there — not that this
   * guest brought one, and nothing in the booking tells us (property_reservations
   * carries guest_count but no pet data from any PMS today). So the crew who just
   * cleaned the place is the only source of that fact, and until now the only way
   * to record it was a checkbox they had to notice mid-clean. On a fee this size
   * that is revenue leaking through an unprompted control.
   *
   * Deliberately NOT a gate: both answers complete the clean. A crew member who
   * cannot finish a job because of a billing question will learn to work around
   * the prompt, and a forced answer is worth less than an honest one.
   */
  function askPetFee(): Promise<'yes' | 'no'> {
    return new Promise(resolve => {
      Alert.alert(
        `🐾 ${t('pet_prompt_title')}`,
        t('pet_prompt_msg'),
        [
          { text: t('pet_prompt_no'), onPress: () => resolve('no') },
          {
            text: petFee > 0 ? ti(t('pet_prompt_yes_fee'), { fee: `$${petFee}` }) : t('pet_prompt_yes'),
            onPress: () => resolve('yes'),
          },
        ],
        // Not dismissable: on Android a tap outside would resolve nothing and
        // leave completion hanging forever on an unresolved promise.
        { cancelable: false },
      )
    })
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
    const { data: fetched } = await cachedQuery(`time:${job.id}:${user.id}`, supabase
      .from('job_time_entries')
      .select('*')
      .eq('job_id', job.id)
      .eq('user_id', user.id)
      .order('clocked_in_at'))
    // Queued offline punches overlay the cached/live rows, so a relaunch in a
    // dead zone still shows the running timer (and can pause/clock out).
    const data = (await overlayPending('job_time_entries', fetched ?? [],
      v => v.job_id === job.id && v.user_id === user.id))
      .sort((a: any, b: any) => String(a.clocked_in_at).localeCompare(String(b.clocked_in_at)))
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

  /**
   * How many named property shots this job still owes.
   *
   * Gated on tenants.enforce_photo_requirements: ~18 required rows are
   * auto-seeded into every STR property, so counting them for a tenant that
   * does not enforce would put a scary "0/19" on thousands of jobs that are
   * free to complete. Mirrors the server gate, which joins the same flag.
   */
  async function loadPhotoRequirements() {
    const addrId = job.client_addresses?.id || job.address_id
    if (!addrId || isTask || isLaundry) { setReqTotal(0); return }
    const { data: tenant } = await supabase
      .from('tenants').select('enforce_photo_requirements')
      .eq('id', user.tenant_id).maybeSingle()
    if (!tenant?.enforce_photo_requirements) { setReqTotal(0); return }

    const [{ count: total }, { data: shot }] = await Promise.all([
      supabase.from('property_photo_requirements')
        .select('id', { count: 'exact', head: true })
        .eq('address_id', addrId).eq('required', true),
      supabase.from('job_photos')
        .select('photo_requirement_id')
        .eq('job_id', job.id).not('photo_requirement_id', 'is', null),
    ])
    // Distinct requirements satisfied — two shots of the same area is still one.
    const done = new Set((shot ?? []).map((p: any) => p.photo_requirement_id)).size
    setReqTotal(total ?? 0)
    setReqDone(done)
  }

  // quiet = refresh in place (realtime teammate updates) — no spinner flash.
  async function loadChecklist(quiet = false) {
    const addrId = job.client_addresses?.id || job.address_id
    if (!addrId) {
      // Fallback: lookup by street
      const street = job.client_addresses?.street
      if (!street) return loadChecklistForAddress(null, quiet)
      if (!quiet) setLoadingChecklist(true)
      const { data: addrData } = await supabase
        .from('client_addresses').select('id')
        .eq('street', street).eq('tenant_id', user.tenant_id).maybeSingle()
      return loadChecklistForAddress(addrData?.id || null, quiet)
    }
    if (!quiet) setLoadingChecklist(true)
    return loadChecklistForAddress(addrId, quiet)
  }

  // The job's own checklist rows (seeded at job creation) are the shared
  // source of truth with the owner dashboard — both sides must read the same
  // rows and the same `completed` flags, or the crew and the owner see
  // different checklists. A row EXISTING does not mean it's done; only
  // `completed = true` does. Templates are a fallback for jobs that were
  // never seeded; the built-in default list covers properties with no
  // template at all.
  async function loadChecklistForAddress(addressId: string | null, quiet = false) {
    if (!quiet) setLoadingChecklist(true)
    const [tmplRes, rowsRes] = await Promise.all([
      addressId
        ? cachedQuery(`tmpl:${addressId}`, supabase.from('address_checklist_templates')
            .select('id, room, title, sort_order, requires_photo')
            .eq('address_id', addressId)
            .order('room').order('sort_order'))
        : Promise.resolve({ data: [] as any[] }),
      cachedQuery(`chkrows:${job.id}`, supabase.from('job_checklist_items')
        .select('id, room, task, sort_order, completed, photo_required, room_id, item_kind, level, result, issue_note')
        .eq('job_id', job.id)
        .order('room').order('sort_order')),
    ])
    const tmpl = tmplRes.data || []
    // Queued offline ticks overlay the cached/live rows (rows are already
    // scoped to this job, matching the ops' job_id filter).
    const rows = await overlayPending('job_checklist_items', rowsRes.data || [],
      v => v.job_id === job.id)
    let items: any[]
    const checkedMap: Record<string, boolean> = {}
    if (rows.length > 0 && tmpl.length > 0) {
      items = rows.map(r => ({ id: r.id, jobItemId: r.id, label: `${r.room} — ${r.task}`, room: r.room, title: r.task, requires_photo: r.photo_required || false, room_uid: r.room_id, item_kind: r.item_kind || 'task', level: r.level || 'guidance', result: r.result ?? null, issue_note: r.issue_note ?? null }))
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
    // Rooms, sign-offs, mode and per-room photo counts — best-effort; an error
    // just leaves the flat 'Other' grouping.
    if (addressId) {
      try {
        const [roomsRes, signRes, addrRes, tenRes, reqRes, shotRes] = await Promise.all([
          cachedQuery(`rooms:${addressId}`, supabase.from('property_rooms')
            .select('id, room_type, instance_no, name, sort_order, execution_mode')
            .eq('address_id', addressId).is('archived_at', null).order('sort_order')),
          cachedQuery(`signoffs:${job.id}`, supabase.from('job_room_signoffs')
            .select('id, room_id, completed_at, job_id').eq('job_id', job.id)),
          cachedQuery(`addrmode:${addressId}`, supabase.from('client_addresses')
            .select('checklist_execution_mode').eq('id', addressId)),
          cachedQuery(`tenmode:${user.tenant_id}`, supabase.from('tenants')
            .select('checklist_execution_mode').eq('id', user.tenant_id)),
          cachedQuery(`preq:${addressId}`, supabase.from('property_photo_requirements')
            .select('id, room_id, required').eq('address_id', addressId).eq('required', true)),
          cachedQuery(`pshot:${job.id}`, supabase.from('job_photos')
            .select('photo_requirement_id').eq('job_id', job.id).not('photo_requirement_id', 'is', null)),
        ])
        setRoomsMeta(roomsRes.data || [])
        const signRows = await overlayPending('job_room_signoffs', signRes.data || [], v => v.job_id === job.id)
        const sMap: Record<string, string> = {}
        for (const r of signRows) if (r.room_id) sMap[r.room_id] = r.completed_at
        setSignoffs(sMap)
        const addrMode = (addrRes.data as any[])?.[0]?.checklist_execution_mode
        const tenMode = (tenRes.data as any[])?.[0]?.checklist_execution_mode
        setDefaultMode((addrMode || tenMode || 'detailed') as any)
        const shotSet = new Set(((shotRes.data as any[]) || []).map(pp => pp.photo_requirement_id))
        const rb: Record<string, { total: number; done: number }> = {}
        for (const rq of ((reqRes.data as any[]) || [])) {
          const k = rq.room_id || '__other__'
          rb[k] = rb[k] || { total: 0, done: 0 }
          rb[k].total += 1
          if (shotSet.has(rq.id)) rb[k].done += 1
        }
        setReqByRoom(rb)
      } catch { /* accordion still renders from item.room text */ }
    }
    // A photo counts for an item via the canonical checklist_item_id link, or
    // by the legacy caption == task-title match (photos from older bundles /
    // web uploads before the link existed).
    const { data: photos } = await cachedQuery(`photos:${job.id}`, supabase.from('job_photos').select('caption, checklist_item_id').eq('job_id', job.id))
    if (photos) {
      const counts: Record<string, number> = {}
      items.forEach(item => {
        counts[item.id] = photos.filter(p =>
          (item.jobItemId && p.checklist_item_id === item.jobItemId) ||
          (!p.checklist_item_id && p.caption === item.title)
        ).length
      })
      setItemPhotos(counts)
    }
    setLoadingChecklist(false)
  }

  // VERIFY answer (phase 2). result: 'ok' | 'issue' | 'na' | null. The DB
  // trigger syncs `completed` from result, so we don't write it here.
  async function saveVerify(item: any, result: 'ok' | 'issue' | 'na' | null, note?: string) {
    if (!item.jobItemId) return
    const { error } = await writeThrough({
      table: 'job_checklist_items', op: 'update', match: { id: item.jobItemId },
      values: {
        result,
        issue_note: result === 'issue' ? (note || '').trim() || null : null,
        completed_at: result ? new Date().toISOString() : null,
        completed_by: result ? user.id : null,
      },
    })
    if (error) { Alert.alert(t('error'), t('could_not_save')); return }
    setChecklist(prev => prev.map(i => i.id === item.id ? { ...i, result, issue_note: result === 'issue' ? note || null : null } : i))
    setChecked(prev => ({ ...prev, [item.id]: result === 'ok' || result === 'na' }))
    setIssueForId(null); setIssueText('')
  }

  // "Complete room" — one honest sign-off row, never bulk ticks. Photos for the
  // room must exist first; the button says how many are left.
  async function signOffRoom(roomId: string) {
    const { error } = await writeThrough({
      table: 'job_room_signoffs', op: 'upsert', onConflict: 'job_id,room_id',
      values: { tenant_id: user.tenant_id, job_id: job.id, room_id: roomId, completed_at: new Date().toISOString(), completed_by: user.id },
    })
    if (error) { Alert.alert(t('error'), t('could_not_save')); return }
    setSignoffs(prev => ({ ...prev, [roomId]: new Date().toISOString() }))
  }

  async function saveCheckItem(item: any, isChecked: boolean) {
    // Ticks save optimistically. Offline they queue in the outbox (the box
    // stays ticked); only a real server rejection reverts the box and tells
    // the crew, or they walk away believing the checklist is done when it isn't.
    let error
    if (item.jobItemId) {
      // Seeded row — flip the same flag the owner dashboard reads. Never
      // delete: these rows ARE the owner's checklist.
      ;({ error } = await writeThrough({
        table: 'job_checklist_items', op: 'update', match: { id: item.jobItemId },
        values: {
          completed: isChecked,
          completed_at: isChecked ? new Date().toISOString() : null,
          completed_by: isChecked ? user.id : null,
        },
      }))
    } else if (isChecked) {
      ;({ error } = await writeThrough({
        table: 'job_checklist_items', op: 'upsert', onConflict: 'job_id,task,room',
        values: {
          tenant_id: user.tenant_id, job_id: job.id,
          room: item.room, task: item.title, sort_order: 0,
          completed: true, completed_at: new Date().toISOString(), completed_by: user.id,
        },
      }))
    } else {
      ;({ error } = await writeThrough({
        table: 'job_checklist_items', op: 'update',
        match: { job_id: job.id, task: item.title, room: item.room },
        values: { completed: false, completed_at: null, completed_by: null },
      }))
    }
    if (error) {
      setChecked(prev => ({ ...prev, [item.id]: !isChecked }))
      Alert.alert(t('error'), t('could_not_save'))
    }
  }

  async function handleClockIn() {
    setSaving(true)
    // GPS-verified time tracking: if the arrival geofence recorded a fence
    // entry for this job, backdate the punch to that instant (QB Time
    // pattern — human confirms, no minutes lost), floored at 30min before the
    // scheduled start so early sitting-in-the-car isn't billable. Otherwise a
    // best-effort quick GPS fix stamps the manual punch. Neither may block or
    // fail the punch itself.
    const arrival = await getPendingArrival(job.id)
    let clockedInAt = new Date()
    let stamp: { lat: number; lng: number } | null = null
    if (arrival) {
      const floor = new Date(new Date(job.scheduled_start).getTime() - 30 * 60000)
      const arrivedAt = new Date(arrival.at)
      clockedInAt = arrivedAt > floor ? arrivedAt : floor
      if (clockedInAt > new Date()) clockedInAt = new Date() // never in the future
      stamp = { lat: arrival.lat, lng: arrival.lng }
    } else {
      stamp = await quickGpsStamp()
    }

    // Create time entry — this row IS the crew member's pay. The id is minted
    // client-side so the write is an idempotent upsert: offline it queues in
    // the outbox (dead spot ≠ lost hours), and a replay whose ack was lost
    // can't double-insert. A real server rejection (RLS) still must NOT mark
    // the job in_progress: that's the "worked all day, no hours on payroll"
    // failure.
    const entry = {
      id: uuid4(),
      tenant_id: user.tenant_id, job_id: job.id, user_id: user.id,
      clocked_in_at: clockedInAt.toISOString(), entry_type: 'work',
      source: arrival ? 'prompted' : 'manual',
      arrived_at: arrival?.at ?? null,
      clock_in_lat: stamp?.lat ?? null,
      clock_in_lng: stamp?.lng ?? null,
    }
    const { error: entryErr, queued } = await writeThrough({
      table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: entry,
    })
    if (entryErr) {
      setSaving(false)
      Alert.alert(t('error'), t('clock_in_failed'))
      return
    }
    if (queued) Alert.alert('📡', t('queued_offline'))
    if (arrival) {
      clearPendingArrival(job.id)
      // Tell them the backdate happened — the timer starting "in the past"
      // without explanation reads as a bug.
      if (Date.now() - clockedInAt.getTime() > 90_000) {
        Alert.alert('📍', ti(t('clocked_in_from_arrival'), {
          time: clockedInAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        }))
      }
    }
    setActiveEntry(entry)
    setIsPaused(false)
    // Begin broadcasting location now that they're clocked in (don't wait for
    // an app relaunch, and don't require a job_assignment). Clock-in is the
    // user-initiated moment where we escalate to the "Always" location prompt
    // so tracking keeps working with the phone in their pocket.
    startLocationTracking(user, { requestBackground: true }).catch(() => {})
    // Update job status
    await writeThrough({ table: 'jobs', op: 'update', match: { id: job.id }, values: { status: 'in_progress' } })
    onStatusChange(job, 'in_progress')
    loadTimeEntries()
    setSaving(false)
    announceRequiredPhotos()
  }

  /**
   * Tell the crew what this property owes in photos, at the moment they start.
   *
   * Clock-in is the one instant we know they have arrived and not yet worked —
   * the only time "19 photos are needed" is actionable. The same list used to
   * appear only at completion, after the clean was done and the crew had often
   * left, which is how jobs ended up stranded mid-clean for days.
   * Fires once per screen mount so a pause/resume does not nag.
   */
  function announceRequiredPhotos() {
    if (reqAnnounced || reqTotal === 0 || reqDone >= reqTotal) return
    setReqAnnounced(true)
    Alert.alert(
      `📸 ${t('required_photos_title')}`,
      ti(t('required_photos_on_start'), { n: String(reqTotal - reqDone) }),
      [
        { text: t('add_photo_btn'), onPress: () => { setActivePhotoItem(null); setShowPhotos(true) } },
        { text: t('ok') },
      ]
    )
  }

  // Daily mode: start the clean for status + photo proof only — no per-job
  // time entry (hours come from the day's shift on the Dashboard).
  async function startJobDaily() {
    setSaving(true)
    await writeThrough({ table: 'jobs', op: 'update', match: { id: job.id }, values: { status: 'in_progress' } })
    onStatusChange(job, 'in_progress')
    setSaving(false)
    announceRequiredPhotos()
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
    const { error } = await writeThrough({ table: 'jobs', op: 'update', match: { id: job.id }, values: { status: 'en_route' } })
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
    const { error: pauseErr } = await writeThrough({
      table: 'job_time_entries', op: 'update', match: { id: activeEntry.id },
      values: {
        clocked_out_at: now.toISOString(),
        pause_reason: pauseReason,
        duration_minutes: Math.round(mins),
      },
    })
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
    // Client-minted id, same as clock-in: offline the resume queues instead of
    // failing, and replays idempotently.
    const entry = {
      id: uuid4(),
      tenant_id: user.tenant_id, job_id: job.id, user_id: user.id,
      clocked_in_at: new Date().toISOString(), entry_type: 'work',
    }
    const { error: resumeErr } = await writeThrough({
      table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: entry,
    })
    if (resumeErr) {
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

  // Lead-owned sign-off: only the job's flagged lead completes; owner/manager
  // always can; solo crew or a roster with no lead flagged falls back to any
  // assignee (a job must never be stuck waiting on a lead that was never set).
  // Fails OPEN on lookup errors — flaky signal must not strand a crew, and the
  // DB gate remains the source of truth for the photo requirements.
  async function canSignOffAsViewer(): Promise<boolean> {
    if (user?.role === 'owner' || user?.role === 'manager') return true
    const { data: roster, error } = await supabase
      .from('job_assignments')
      .select('user_id, is_lead')
      .eq('job_id', job.id)
    if (error || !roster || roster.length === 0) return true
    const mine = roster.find((a: any) => a.user_id === user?.id)
    if (!mine) return true
    const hasLead = roster.some((a: any) => a.is_lead)
    if (!hasLead || roster.length === 1) return true
    return !!mine.is_lead
  }

  async function completeJob() {
    // An inspection is closed by FILING ITS RESULT, not by a generic Complete.
    // Marking it done with no result would produce a visit that counts for
    // nothing: QualityReport only counts inspections with a recorded result, so
    // it would vanish from first-pass yield instead of quietly passing.
    if (isInspection) {
      Alert.alert(t('insp_result_first'), t('insp_result_first_msg'), [
        { text: t('cancel'), style: 'cancel' },
        { text: t('insp_open_form'), onPress: () => setShowInspection(true) },
      ])
      return
    }
    // Photo requirements — cleans only; laundry runs have no property to
    // photograph (their proof is the reconciliation form).
    if (isTask) { await completeJobNoPhotoCheck(); return }

    if (!(await canSignOffAsViewer())) {
      Alert.alert(`🔒 ${t('lead_signoff_title')}`, t('lead_signoff_msg'))
      return
    }

    // Photos taken with no signal wait in the on-device queue; give them a
    // chance to land now so the gate below sees them.
    try { await flushQueue() } catch { /* offline — handled below */ }

    // Canonical completion gate — the same job_completion_blockers() the web
    // panel calls, so web and mobile can never disagree on what completion
    // requires. RPC error → fail open: the status update below needs signal
    // anyway, and the DB-side backstop enforces once it ships.
    const { data: blockers, error: gateErr } = await supabase.rpc('job_completion_blockers', { p_job_id: job.id })
    if (!gateErr && blockers && blockers.length > 0) {
      // Queued-but-unuploaded photos would clear these blockers the moment
      // they land — keep the offline-aware messaging instead of a dead-end
      // "photo required" that reads as a bug.
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
        Alert.alert(`📥 ${t('photo_pending_complete_title')}`, t('photo_pending_complete_msg'))
        return
      }

      if (blockers.some((b: any) => b.code === 'no_after_photo')) {
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

      const missingBlockers = blockers.filter((b: any) => b.code === 'missing_required_photo')
      if (missingBlockers.length > 0) {
        // Prefer the local checklist item for localized labels; fall back to
        // the room/task the gate returned.
        const missingItems = missingBlockers
          .map((b: any) => checklist.find((i: any) => i.jobItemId === b.checklist_item_id))
        const lines = missingBlockers.map((b: any, idx: number) => {
          const item = missingItems[idx]
          return item ? (item.labelKey ? t(item.labelKey) : (item.label || item.title)) : (b.room ? `${b.room} — ${b.task}` : b.task)
        })
        const firstItem = missingItems.find(Boolean)
        Alert.alert(
          `📸 ${t('photo_required_alert')}`,
          `${t('item_photos_missing_msg')}\n\n• ${lines.join('\n• ')}`,
          [
            { text: t('add_photo_btn'), onPress: () => { setActivePhotoItem(firstItem ?? null); setShowPhotos(true) } },
            { text: t('cancel'), style: 'cancel' }
          ]
        )
        return
      }

      // Named property shots (Photos screen → Required photos). Listed by area
      // so the crew knows which rooms to go back to, and the button drops them
      // straight into the shot list rather than a generic photo screen.
      const missingAreas = blockers.filter((b: any) => b.code === 'missing_required_area_photo')
      if (missingAreas.length > 0) {
        const lines = missingAreas.map((b: any) => (b.room ? `${b.room} — ${b.task}` : b.task))
        Alert.alert(
          `📸 ${t('photo_required_alert')}`,
          `${t('required_area_photos_missing_msg')}\n\n• ${lines.join('\n• ')}`,
          [
            { text: t('add_photo_btn'), onPress: () => { setActivePhotoItem(null); setShowPhotos(true) } },
            { text: t('cancel'), style: 'cancel' }
          ]
        )
        return
      }

      // Phase 3 (opt-in per tenant): items marked Required on the turnover
      // checklist must be ticked (or their room signed off, or answered as an
      // issue). List the rooms and pop them open — the work is on this screen.
      const requiredLeft = blockers.filter((b: any) => b.code === 'unchecked_required_item')
      if (requiredLeft.length > 0) {
        const roomsLeft = [...new Set(requiredLeft.map((b: any) => b.room).filter(Boolean))] as string[]
        const affected = checklist.filter((i: any) => requiredLeft.some((b: any) => b.checklist_item_id === i.jobItemId))
        Alert.alert(
          `☑️ ${t('required_items_missing_title')}`,
          `${t('required_items_missing_msg')}\n\n• ${roomsLeft.join('\n• ')}`,
          [{ text: t('ok'), onPress: () => {
            const opens: Record<string, boolean> = {}
            for (const i of affected) if (i.room_uid) opens[i.room_uid] = true
            setOpenRooms(prev => ({ ...prev, ...opens }))
          } }]
        )
        return
      }

      // Laundry runs: cash reconciliation is required (and must tie out)
      // before the run can be completed — offer to open the laundry form.
      if (blockers.some((b: any) => b.code === 'laundry_cash_missing' || b.code === 'laundry_cash_mismatch')) {
        const mismatch = blockers.some((b: any) => b.code === 'laundry_cash_mismatch')
        Alert.alert(
          `💵 ${t('laundry_cash_required_title')}`,
          mismatch ? t('laundry_cash_mismatch_block_msg') : t('laundry_cash_required_msg'),
          [
            { text: t('laundry_open_form'), onPress: () => setShowLaundry(true) },
            { text: t('cancel'), style: 'cancel' }
          ]
        )
        return
      }

      // Any other blocker code (future gate rules): block instead of silently
      // falling through — web and mobile must never disagree on completion.
      Alert.alert(t('error'), t('completion_blocked_generic'))
      return
    }

    // Pets — asked last, once every blocker has cleared, so nobody answers a
    // billing question on a clean they are about to be sent back to finish.
    // Skipped when they already ticked the toggle mid-clean: they have answered.
    if (!petFeeApplied && (petFriendly || petFee > 0)) {
      if (await askPetFee() === 'yes') {
        setPetFeeApplied(true)
        // ORDER MATTERS. auto-invoice fires from a DB trigger on the status
        // change to 'completed' and reads jobs.pet_fee_applied at that moment,
        // so this write has to land first or the fee misses the invoice
        // entirely. Offline the outbox replays strictly FIFO, which preserves
        // the same ordering on reconnect.
        const { error } = await writeThrough({
          table: 'jobs', op: 'update', match: { id: job.id }, values: { pet_fee_applied: true },
        })
        if (error) {
          setPetFeeApplied(false)
          // Don't complete on a failed pet write: completing now would bill the
          // clean without the fee, and the fee cannot be added afterwards
          // without editing an already-issued invoice.
          Alert.alert(t('error'), error.message)
          return
        }
      }
    }

    await completeJobNoPhotoCheck()
  }

  // Clock out the active entry — the clock-out IS the paid duration. Offline it
  // queues (never lost); only a real server rejection is fatal: an open entry on
  // a "completed" job would run forever and corrupt payroll.
  //
  // Extracted from completeJobNoPhotoCheck so JobInspectionScreen can run it
  // BEFORE it files a record — filing stamps job_inspections.completed_at, whose
  // trigger completes the visit job, and that ordering is what keeps a completed
  // job from ever carrying an open entry.
  //
  // Returns false only on a hard rejection (the alert is already shown);
  // `queued` is reported through the ref so the caller can still say so.
  const clockOutQueuedRef = useRef(false)
  async function clockOutActive(): Promise<boolean> {
    clockOutQueuedRef.current = false
    if (!activeEntry) return true
    const now = new Date()
    const mins = (now.getTime() - new Date(activeEntry.clocked_in_at).getTime()) / 60000
    // GPS-stamp the punch-out too (best-effort — never blocks the clock-out).
    const outStamp = await quickGpsStamp()
    const { error: outErr, queued: outQueued } = await writeThrough({
      table: 'job_time_entries', op: 'update', match: { id: activeEntry.id },
      values: {
        clocked_out_at: now.toISOString(),
        duration_minutes: Math.round(mins),
        clock_out_lat: outStamp?.lat ?? null,
        clock_out_lng: outStamp?.lng ?? null,
      },
    })
    if (outErr) {
      Alert.alert(t('error'), t('clock_out_failed'))
      return false
    }
    if (outQueued) clockOutQueuedRef.current = true
    return true
  }

  // The inspection form already clocked out and filed the record; the DB trigger
  // trg_complete_inspection_job has completed the visit job. Nothing left to
  // write — just tear down and tell the list.
  function finishFiledInspection() {
    if (clockOutQueuedRef.current) Alert.alert('📡', t('queued_offline'))
    maybeStopLocationTracking(user).catch(() => {})
    onStatusChange(job, 'completed')
    setShowInspection(false)
    onBack()
  }

  async function completeJobNoPhotoCheck() {
    setSaving(true)
    if (!(await clockOutActive())) { setSaving(false); return }
    const queuedOffline = clockOutQueuedRef.current
    // Append the crew's completion note to internal_notes instead of replacing
    // it — the field also carries the owner's note to crew (and a task's title),
    // which a plain overwrite used to erase.
    const crewNote = notes.trim()
    const mergedNotes = crewNote
      ? (job.internal_notes ? `${job.internal_notes}\n— ${crewNote}` : crewNote)
      : (job.internal_notes ?? null)
    const { error: doneErr, queued: doneQueued } = await writeThrough({
      table: 'jobs', op: 'update', match: { id: job.id },
      values: {
        status: 'completed',
        internal_notes: mergedNotes,
        // Sign-off attribution (distinct from per-item completed_by = last ticker).
        ...(user?.id ? { completed_by_user_id: user.id } : {}),
      },
    })
    if (doneErr) {
      setSaving(false)
      Alert.alert(t('error'), doneErr.message)
      return
    }
    if (queuedOffline || doneQueued) Alert.alert('📡', t('queued_offline'))
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
  if (showInspection) return (
    <JobInspectionScreen
      job={job} user={user}
      onBack={() => setShowInspection(false)}
      clockOut={clockOutActive}
      onFiled={finishFiledInspection}
    />
  )
  if (showPhotos) return <JobPhotosScreen job={job} user={user} preselectedItem={activePhotoItem} onBack={() => { setShowPhotos(false); loadChecklist(); loadPhotoRequirements() }} />

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}><Text style={styles.backText}>← {t('back')}</Text></TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{isLaundry ? `🧺 ${t('laundry_run')}` : isInspection ? `🔍 ${t('inspection')}` : job.job_type === 'task' ? `📌 ${(job.internal_notes || t('task')).split('\n')[0]}` : (propLabel || t('job_detail'))}</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Property photo — not for location-less tasks (internal shell property) */}
        {(isTask && !hasTaskLocation) ? null : addr?.photo_url ? (
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
                if (await ensureCameraCapture() !== 'granted') return
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
          <Text style={styles.clientName}>{isLaundry ? `🧺 ${t('laundry_run')}` : isInspection ? <>🔍 {t('inspection')} · {propLabel}</> : job.job_type === 'task' ? `📌 ${(job.internal_notes || t('task')).split('\n')[0]}` : <>{propLabel}{job.is_turnover ? `  🏠 ${t('turnover')}` : ''}</>}</Text>
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
          {(!isTask || hasTaskLocation) && (
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
          {(!isTask || hasTaskLocation) && propMeta?.crew_notes && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>📄</Text>
              <View style={{ flex: 1 }}><Text style={styles.infoLabel}>{t('property_notes')}</Text><Text style={styles.infoValue}>{propMeta.crew_notes}</Text></View>
            </View>
          )}
          {!isTask && stagingPhotos.length > 0 && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>📸</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.infoLabel}>{t('staging_photos')}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
                  {stagingPhotos.map((p, i) => (
                    <TouchableOpacity key={i} onPress={() => setStagingViewerIndex(i)} style={{ marginRight: 8 }}>
                      <Image source={{ uri: p.url }} style={{ width: 110, height: 110, borderRadius: 10 }} resizeMode="cover" />
                      {!!p.caption && <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 3, width: 110 }} numberOfLines={2}>{p.caption}</Text>}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>
          )}
          {!isTask && bagColor && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>🧺</Text>
              <View style={{ flex: 1 }}><Text style={styles.infoLabel}>{t('laundry_bags_label')}</Text><Text style={styles.infoValue}>{bagColor}</Text></View>
            </View>
          )}
          {!!jobNote && (
            <View style={styles.infoRow}>
              <Text style={styles.infoIcon}>📝</Text>
              <View style={{ flex: 1 }}><Text style={styles.infoLabel}>{t('job_notes')}</Text><Text style={styles.infoValue}>{jobNote}</Text></View>
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
          ) : isInspection ? (<>
          <TouchableOpacity style={[styles.suppliesBtn, { borderColor: GOLD }]} onPress={() => setShowInspection(true)}>
            <Text style={[styles.suppliesBtnText, { color: GOLD }]}>🔍 {t('insp_open')}</Text>
          </TouchableOpacity>
          {/* §7.10 — an inspection's evidence is photographic, so the crew needs
              the camera here even though every other task type hides it. */}
          <TouchableOpacity style={styles.photosBtn} onPress={() => { setActivePhotoItem(null); setShowPhotos(true) }}>
            <Text style={styles.photosBtnText}>📸 {t('job_photos')}</Text>
          </TouchableOpacity>
          </>) : !isTask ? (<>
          {/* Carries the required-shot count so the obligation is visible for
              the whole clean, not sprung at completion. Amber while outstanding. */}
          <TouchableOpacity
            style={[styles.photosBtn, reqTotal > 0 && reqDone < reqTotal && { borderColor: '#F59E0B' }]}
            onPress={() => { setActivePhotoItem(null); setShowPhotos(true) }}>
            <Text style={[styles.photosBtnText, reqTotal > 0 && reqDone < reqTotal && { color: '#B45309' }]}>
              📸 {t('job_photos')}{reqTotal > 0 ? ` (${reqDone}/${reqTotal})` : ''}
            </Text>
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
                  // An inspection is closed by filing its result — go straight
                  // to the form rather than stacking a confirm on top of it.
                  if (isInspection) { setShowInspection(true); return }
                  Alert.alert(t('complete_job_confirm'), '', [
                    { text: t('cancel'), style: 'cancel' },
                    { text: t('complete_job'), onPress: completeJob },
                  ])
                }} disabled={saving}>
                  <Text style={styles.clockBtnText}>✓ {isInspection ? t('insp_complete') : t('complete_job')}</Text>
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
                    if (isInspection) { setShowInspection(true); return }
                    Alert.alert(t('complete_job_confirm'), `${t('total_time')}: ${fmtDuration(elapsedMinutes)}`, [
                      { text: t('cancel'), style: 'cancel' },
                      { text: t('complete_job'), onPress: completeJob }
                    ])
                  }} disabled={saving}>
                    <Text style={styles.clockBtnText}>✓ {isInspection ? t('insp_complete') : t('complete_job')}</Text>
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

        {/* Turnover checklist — cleans only; laundry runs use the reconciliation
            form. Phase 2: rooms accordion in the order the cleaner walks the
            house; DO ☐ / VERIFY ◇ / photos per room. Items with no room (old
            jobs, template-less properties) group under "Other". */}
        {isStarted && !isTask && (
          <View style={styles.card}>
            {(() => {
              const groups: any[] = []
              const byId = new Map<string, any>()
              for (const rm of roomsMeta) {
                const name = (rm.name || '').trim() || (
                  rm.room_type === 'bedroom' ? (rm.instance_no === 1 ? 'Primary Bedroom' : `Bedroom ${rm.instance_no}`)
                  : rm.room_type === 'bathroom' ? `Bathroom ${rm.instance_no}`
                  : rm.room_type === 'final' ? 'Final Guest-Ready Check'
                  : rm.room_type === 'living' ? 'Living Room'
                  : rm.room_type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) + (rm.instance_no > 1 ? ` ${rm.instance_no}` : ''))
                const g = { key: rm.id, name, mode: rm.execution_mode || defaultMode, items: [] as any[] }
                byId.set(rm.id, g); groups.push(g)
              }
              const other = { key: '__other__', name: 'Other', mode: 'detailed', items: [] as any[] }
              for (const item of checklist) {
                const g = item.room_uid ? byId.get(item.room_uid) : null
                ;(g || other).items.push(item)
              }
              if (other.items.length > 0) groups.push(other)
              const shown = groups.filter(g => g.items.length > 0 || (reqByRoom[g.key]?.total ?? 0) > 0)

              const stateOf = (g: any) => {
                const tasks = g.items.filter((i: any) => i.item_kind !== 'verify')
                const verifies = g.items.filter((i: any) => i.item_kind === 'verify')
                const doneTasks = tasks.filter((i: any) => checked[i.id]).length
                const answered = verifies.filter((i: any) => i.result != null || checked[i.id]).length
                const issues = verifies.filter((i: any) => i.result === 'issue').length
                const req = reqByRoom[g.key] || { total: 0, done: 0 }
                const signed = !!signoffs[g.key]
                const workDone = g.mode === 'room_complete'
                  ? signed
                  : doneTasks === tasks.length && answered === verifies.length
                return { tasks, verifies, doneTasks, answered, issues, req, signed,
                  complete: g.items.length > 0 && workDone && req.done >= req.total }
              }

              const firstOpen = (shown.find(g => !stateOf(g).complete) || shown[0])?.key
              const roomsDone = shown.filter(g => stateOf(g).complete).length

              return (
                <View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <Text style={styles.sectionTitle}>{t('cleaning_checklist')}</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: TEAL }}>
                      {shown.length > 1 ? `${t('turnover_rooms_done')} ${roomsDone}/${shown.length}` : `${completedCount}/${checklist.length}`}
                    </Text>
                  </View>
                  <View style={styles.progressBg}><View style={[styles.progressFill, { width: `${progressPct}%` as any }]} /></View>
                  {loadingChecklist ? (
                    <ActivityIndicator color={TEAL} style={{ marginVertical: 20 }} />
                  ) : shown.map(g => {
                    const st = stateOf(g)
                    const isOpen = openRooms[g.key] ?? (g.key === firstOpen)
                    return (
                      <View key={g.key} style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, marginBottom: 6, overflow: 'hidden' }}>
                        <TouchableOpacity onPress={() => setOpenRooms(prev => ({ ...prev, [g.key]: !isOpen }))}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: st.complete ? '#ECFDF5' : '#F9FAFB' }}>
                          <Text style={{ flex: 1, fontSize: 14, fontWeight: '800', color: '#111827' }} numberOfLines={1}>
                            {st.complete ? '✓ ' : ''}{g.name}
                          </Text>
                          {st.issues > 0 && <Text style={{ fontSize: 11, fontWeight: '800', color: '#DC2626' }}>⚠ {st.issues}</Text>}
                          <Text style={{ fontSize: 11, color: '#6B7280' }}>
                            {g.mode === 'room_complete'
                              ? (st.signed ? '✓' : '…')
                              : `${st.doneTasks + st.answered}/${g.items.length}`}
                            {st.req.total > 0 ? `  📷 ${st.req.done}/${st.req.total}` : ''}
                          </Text>
                          <Text style={{ color: '#9CA3AF' }}>{isOpen ? '▾' : '▸'}</Text>
                        </TouchableOpacity>
                        {isOpen && (
                          <View style={{ padding: 10, paddingTop: 4 }}>
                            {g.mode === 'room_complete' && (
                              <Text style={{ fontSize: 11, color: '#6B7280', marginBottom: 6 }}>{t('room_standards_hint')}</Text>
                            )}
                            {g.items.map((item: any) => {
                              if (item.item_kind === 'verify' && item.jobItemId) {
                                return (
                                  <View key={item.id} style={{ paddingVertical: 5 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                      <Text style={{ color: '#B45309', width: 16, textAlign: 'center' }}>◇</Text>
                                      <View style={{ flex: 1 }}>
                                        <Text style={styles.checkLabel}>{item.title}</Text>
                                        {item.result === 'issue' && item.issue_note && issueForId !== item.id && (
                                          <Text style={{ fontSize: 11, color: '#DC2626', marginTop: 1 }}>⚠ {item.issue_note}</Text>
                                        )}
                                      </View>
                                      {(['ok', 'issue', 'na'] as const).map(v => {
                                        const on = item.result === v
                                        const col = v === 'ok' ? '#16A34A' : v === 'issue' ? '#DC2626' : '#9CA3AF'
                                        return (
                                          <TouchableOpacity key={v}
                                            onPress={() => {
                                              if (v === 'issue' && !on) { setIssueForId(item.id); setIssueText(item.issue_note || ''); return }
                                              saveVerify(item, on ? null : v)
                                            }}
                                            style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1,
                                              borderColor: on ? col : '#E5E7EB', backgroundColor: on ? col : '#fff' }}>
                                            <Text style={{ fontSize: 10, fontWeight: '800', color: on ? '#fff' : '#6B7280' }}>
                                              {v === 'ok' ? `✓ ${t('verify_ok')}` : v === 'issue' ? `⚠ ${t('verify_issue')}` : t('verify_na')}
                                            </Text>
                                          </TouchableOpacity>
                                        )
                                      })}
                                    </View>
                                    {issueForId === item.id && (
                                      <View style={{ flexDirection: 'row', gap: 6, marginTop: 5, marginLeft: 24 }}>
                                        <TextInput value={issueText} onChangeText={setIssueText} placeholder={t('issue_note_ph')} autoFocus
                                          style={{ flex: 1, borderWidth: 1, borderColor: '#FECACA', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 12 }} />
                                        <TouchableOpacity disabled={!issueText.trim()} onPress={() => saveVerify(item, 'issue', issueText)}
                                          style={{ backgroundColor: issueText.trim() ? '#DC2626' : '#FCA5A5', borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center' }}>
                                          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{t('report_issue_btn')}</Text>
                                        </TouchableOpacity>
                                      </View>
                                    )}
                                  </View>
                                )
                              }
                              // task row (also verify rows on unseeded legacy jobs)
                              if (g.mode === 'room_complete') {
                                return (
                                  <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                                    <Text style={{ color: '#9CA3AF', width: 16, textAlign: 'center' }}>•</Text>
                                    <Text style={[styles.checkLabel, { flex: 1 }]}>{item.labelKey ? t(item.labelKey) : item.title}</Text>
                                  </View>
                                )
                              }
                              return (
                                <View key={item.id} style={styles.checkItem}>
                                  <TouchableOpacity onPress={() => {
                                    const newVal = !checked[item.id]
                                    if (newVal && item.requires_photo && !itemPhotos[item.id]) {
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
                                      <Text style={[styles.checkLabel, checked[item.id] && { color: '#9CA3AF', textDecorationLine: 'line-through' }]}>{item.labelKey ? t(item.labelKey) : item.title}</Text>
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
                              )
                            })}
                            {st.req.total > 0 && st.req.done < st.req.total && (
                              <TouchableOpacity onPress={() => setShowPhotos(true)} style={{ marginTop: 4 }}>
                                <Text style={{ fontSize: 11, color: '#7C3AED', fontWeight: '700' }}>
                                  📷 {ti(t('room_photos_to_go'), { n: String(st.req.total - st.req.done) })} →
                                </Text>
                              </TouchableOpacity>
                            )}
                            {g.mode === 'room_complete' && g.key !== '__other__' && (
                              st.signed ? (
                                <Text style={{ fontSize: 12, color: '#059669', fontWeight: '800', marginTop: 6 }}>✓ {t('room_signed_off')}</Text>
                              ) : (
                                <TouchableOpacity disabled={st.req.done < st.req.total} onPress={() => signOffRoom(g.key)}
                                  style={{ marginTop: 6, borderRadius: 10, paddingVertical: 9, alignItems: 'center',
                                    backgroundColor: st.req.done < st.req.total ? '#E5E7EB' : '#10B981' }}>
                                  <Text style={{ color: st.req.done < st.req.total ? '#6B7280' : '#fff', fontSize: 13, fontWeight: '800' }}>
                                    {st.req.done < st.req.total
                                      ? `📷 ${ti(t('room_photos_to_go'), { n: String(st.req.total - st.req.done) })}`
                                      : `✓ ${t('complete_room_btn')}`}
                                  </Text>
                                </TouchableOpacity>
                              )
                            )}
                          </View>
                        )}
                      </View>
                    )
                  })}
                  {checklist.some((i: any) => i.result === 'issue') && (
                    <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 4 }}>{t('issue_blocks_note')}</Text>
                  )}
                </View>
              )
            })()}
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

        {/* Pets at this clean — one-tap flag; adds the property pet fee to the invoice.
            Only shows when the property is pet-friendly or has a fee configured. */}
        {isStarted && !isTask && (petFriendly || petFee > 0) && (
          <View style={styles.card}>
            <TouchableOpacity onPress={togglePetFee} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={[styles.checkbox, petFeeApplied && styles.checkboxDone]}>
                {petFeeApplied && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkLabel}>🐾 {t('pet_at_clean')}{petFee > 0 ? ` — $${petFee}` : ''}</Text>
                <Text style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{t('pet_at_clean_hint')}</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* Stay condition rating — how the guests left it (host sees it with photos) */}
        {isStarted && !isTask && !isResidential && <StayRatingCard job={job} user={user} />}

        {/* Property incident report — damage / missing / maintenance / pest /
            safety / lost & found (manager reviews before the host is told) */}
        {isStarted && !isTask && <IncidentReportCard job={job} user={user} />}

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

      {stagingViewerIndex != null && stagingPhotos.length > 0 && (
        <PhotoViewer
          photos={stagingPhotos.map(p => ({ url: p.url, caption: p.caption || null, meta: t('staging_photos') }))}
          startIndex={stagingViewerIndex}
          onClose={() => setStagingViewerIndex(null)}
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
