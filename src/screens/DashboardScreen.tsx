import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { CrewLine } from '../components/CrewLine'
import { kindParts } from '../lib/cleanKind'
import { JobScopeToggle } from '../components/JobScopeToggle'
import { CrewGroupHeader } from '../components/CrewGroupHeader'
import { useJobScope } from '../lib/useJobScope'
import { isOfficeRole, isMyJob, jobsInScope, dayView, type JobScope } from '../lib/jobScope'
import { crewGroups, listItems } from '../lib/crewGroups'
import { ti, localeFor, capFirst } from '../lib/i18n'
import { SLATE, SLATE_DARK, GOLD } from '../lib/theme'
import { startLocationTracking, stopLocationTracking } from '../lib/locationTracker'
import { refreshArrivalGeofences, quickGpsStamp } from '../lib/arrivalGeofence'
import { arrivalForStart } from '../lib/siteVisits'
import { cachedQuery, cachedRead, readSoon, writeCacheEntry, cacheEpoch } from '../lib/dataCache'
import { lastTripFailed } from '../lib/netFetch'
import { dashTodayRead, dashShiftRead, homeDayRows } from '../lib/jobReads'
import { prefetchDays, loadDayPack, onDayPackChange, stopsAhead, type DayPack } from '../lib/offlinePrefetch'
import { writeThrough, overlayPending, flushOutbox, onOutboxDrained, uuid4, isQueued } from '../lib/outbox'
import { byCrewDayOrder } from '../lib/jobOrder'
import { PrepCard } from '../components/PrepCard'
import { JobClock } from '../components/JobClock'
// Job times and the day bucket render in the TENANT's zone, not the phone's,
// so the crew and the owner read the same clock for the same clean. See
// src/lib/timezone.ts.
import { fmtTime, fmtDate, fmtDateTime, dayKey, todayKey, startOfDayInTz, startOfMonthInTz } from '../lib/timezone'
import { shiftYmd } from '../lib/nextArrival'

// How long the shift card waits for the live read on a weak signal before it
// answers from the saved copy (as the checklist does: lib/checklistCard).
const SHIFT_WAIT_MS = 3_000

export function DashboardScreen({ user, onJobPress, onNavigate, onSOS }: { user: any; onJobPress: (job: any) => void; onNavigate: (screen: string) => void; onSOS: () => void }) {
  const { t, lang } = useLang()
  // What kind of clean each card is: see lib/cleanKind.
  const kindLabels = { turnover: t('turnover'), backToBack: t('back_to_back') }
  // The day as loaded (cancelled included, in working order). What renders —
  // list, counts, active/next job, route stops — is derived from it below, so
  // flipping Mine / Everyone needs no reload.
  const [dayRows, setDayRows] = useState<any[]>([])
  // Cleans left open on a PREVIOUS day — see the query in load().
  const [strandedRows, setStrandedRows] = useState<any[]>([])
  // jobId -> outstanding blocker count. Absent = unresolved (offline, or
  // the RPC failed), which renders no badge rather than a wrong one.
  const [closingBlockers, setClosingBlockers] = useState<Record<string, number>>({})
  // This month's completed jobs, as loaded (the office's whole company, crew their own).
  const [monthRows, setMonthRows] = useState<any[]>([])
  // null = the pay read hasn't landed yet (shown as "—", not $0.00).
  const [earnings, setEarnings] = useState<number | null>(null)
  // Bumped per load(): an older load's late answers must not overwrite a newer one's.
  const loadGen = useRef(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [offline, setOffline] = useState(false)
  // The offline day pack (lib/offlinePrefetch): when it last saved, and how many
  // stops it holds from today on.
  const [dayPack, setDayPack] = useState<DayPack | null>(null)
  const sosTimer = useRef<any>(null)
  const sosInterval = useRef<any>(null)
  // Day-long shift clock-in (only when tenant uses 'daily' time tracking)
  const dailyMode = user._timeMode === 'daily'
  const [activeShift, setActiveShift] = useState<any>(null)
  // False until this screen has read whether a shift is open. Until then the
  // card offers neither Start nor End: a Dashboard that just mounted (app
  // opened, back from a job) used to show "Start my day" over a running shift
  // for as long as its load took, and a tap started a second one.
  const [shiftKnown, setShiftKnown] = useState(false)
  const [shiftElapsed, setShiftElapsed] = useState('')
  const [shiftBusy, setShiftBusy] = useState(false)
  // Bumped by every Start/End: a read that began before one must not put the
  // older state back (9/27: the load's read returned [] a millisecond after
  // Start's insert and the button came back).
  const shiftOps = useRef(0)
  // Set synchronously on the first tap, so a second one that lands before the
  // button re-renders busy can't start a second shift.
  const startingDay = useRef(false)

  // Crew see the property, not the homeowner — client names are for admins.
  const canSeeClientNames = ['owner', 'manager', 'dispatcher'].includes(user.role)

  // Mine / Everyone (lib/jobScope). The office loads the whole company's day
  // and can narrow it to the cleans they're on; crew rows are already only
  // their own (load() filters them), so for crew the scope changes nothing.
  const isOffice = isOfficeRole(user.role)
  const [scope, setScope] = useJobScope(user.id)
  const viewScope: JobScope = isOffice ? scope : 'everyone'

  // The day shift (daily mode), read on its own and first, never behind the
  // day's jobs: the shift card shows nothing until it knows. On a weak signal
  // the saved copy answers within SHIFT_WAIT_MS and the live answer replaces
  // it when it lands. `gen` is the load it belongs to.
  const readShift = useCallback((gen: number) => {
    if (user._timeMode !== 'daily') return
    const opsAtRead = shiftOps.current
    const apply = async (shift: any) => {
      // Overlay queued shift punches (start/end made offline) so a relaunch in
      // a dead zone still shows the running shift — or its queued end.
      const rows = await overlayPending('job_time_entries', shift ? [shift] : [],
        v => v.user_id === user.id && v.entry_type === 'shift' && !v.job_id)
      const open = rows.filter((r: any) => !r.clocked_out_at)
      // A Start/End made while this read was in flight is newer: keep it.
      // So is a later load's read.
      if (shiftOps.current !== opsAtRead || gen !== loadGen.current) return
      setActiveShift(open.length ? open[open.length - 1] : null)
      setShiftKnown(true)
    }
    readSoon(dashShiftRead(user), lastTripFailed() ? 0 : SHIFT_WAIT_MS)
      .then(async first => {
        await apply(first.data)
        if (first.late) await apply((await first.late).data)
      })
      .catch(() => { if (shiftOps.current === opsAtRead && gen === loadGen.current) setShiftKnown(true) })
  }, [user])

  // pulled = pull-to-refresh: the crew asked for fresh data, so the day pack
  // refreshes too instead of waiting out its 10 minutes.
  const load = useCallback(async (pulled = false) => {
    // Drain queued offline writes first chance we get (pull-to-refresh after
    // driving back into signal is a natural sync moment).
    flushOutbox().catch(() => {})
    const now = new Date()
    // "Today" is the tenant's day, not the phone's. With the two disagreeing,
    // a late-evening clean sat in one app's today and the other's tomorrow.
    const todayStart = startOfDayInTz(now)
    // Same for the month: these bounds feed crew_pay_for_period, so a phone in
    // another zone must not report a different month's earnings than payroll.
    const monthStart = startOfMonthInTz(now)

    const isOwner = ['owner', 'manager', 'dispatcher'].includes(user.role)
    const gen = ++loadGen.current

    readShift(gen)

    // Earnings via the crew_pay_for_period RPC — the same canonical pay
    // hierarchy the owner Payroll page uses (property crew rate → property
    // default w/ pooled split + lead rate → turnover/per-job flat → hourly).
    // The old hourly×hours / jobs×rate calc here showed $0 for
    // property-flat-rate and mixed-pay crews. Falls back to 0 on error so an
    // app update ahead of the DB migration can't crash the dashboard.
    // Started now and applied when it lands: the day must not wait on it.
    // (The pay read and the shift read used to run AFTER the three below, one
    // after another — on one bar of signal the spinner sat through all five.)
    cachedQuery(`dash:pay:${user.id}`, supabase.rpc('crew_pay_for_period', {
      p_start: monthStart.toISOString(), p_end: now.toISOString(), p_user_id: user.id,
    })).then(({ data: pay }) => {
      if (gen !== loadGen.current) return
      const labor = Number((pay as any[])?.[0]?.labor_total || 0)
      setEarnings(Math.round(labor * 100) / 100)
    }).catch(() => { /* keep what's shown */ })

    // Reads go through cachedQuery: last good result survives in AsyncStorage,
    // so a crew member who loaded their day online keeps it when signal drops.
    // All in parallel: the slowest one sets the wait, not the sum of them.
    // The day read runs to the end of TOMORROW (lib/jobReads), so the copy
    // saved tonight still has the morning's jobs with no signal. Only today is
    // shown: every row goes through homeDayRows() below.
    const [todayRes, monthRes, strandedRes] = await Promise.all([
      cachedRead(dashTodayRead(user, now)),
      // Monthly stats. For crew, filter to THEIR jobs server-side (inner join)
      // — the old fetch-everything-then-filter pulled every tenant job of the
      // month, which silently truncates at PostgREST's 1,000-row cap on a busy
      // tenant and understates the crew member's own hours/earnings.
      // The office's rows carry who is on each job, so "This month" follows Mine.
      cachedQuery(`dash:month:${user.id}`, isOwner
        ? supabase.from('jobs')
            .select('id, status, scheduled_start, scheduled_end, job_assignments(user_id)')
            .eq('tenant_id', user.tenant_id)
            .eq('status', 'completed')
            .gte('scheduled_start', monthStart.toISOString())
        : supabase.from('jobs')
            .select('id, status, scheduled_start, scheduled_end, job_assignments!inner(user_id)')
            .eq('tenant_id', user.tenant_id)
            .eq('job_assignments.user_id', user.id)
            .eq('status', 'completed')
            .gte('scheduled_start', monthStart.toISOString())),

      // Cleans left open on a PREVIOUS day. The dashboard above is a strict
      // today window and Schedule only reaches back a month, so a job that
      // stayed in_progress overnight quietly left the crew's reach — the exact
      // way the 8/16–8/29 backlog built up. Cached like the rest of the day so
      // it survives a dead zone.
      //
      // Deliberately has NO lower date bound: a stranded clean stays actionable
      // until it is closed. The status filter keeps this empty for a crew with
      // nothing outstanding.
      cachedQuery(`dash:stranded:${user.id}`, supabase.from('jobs')
        .select('id, job_number, tenant_id, status, scheduled_start, scheduled_end, is_turnover, job_type, internal_notes, source_report_id, clients!jobs_client_id_fkey(full_name, phone, client_type), client_addresses!jobs_address_id_fkey(id, street, city, nickname, lockbox_code, lat, lng, photo_url), job_assignments(user_id)')
        .eq('tenant_id', user.tenant_id)
        .in('status', ['in_progress', 'en_route'])
        .lt('scheduled_start', todayStart.toISOString())
        .order('scheduled_start')
        .limit(50)),
    ])
    if (gen !== loadGen.current) return
    setOffline(todayRes.fromCache)

    // Today only. The read carries tomorrow too, and cached rows can be from
    // an EARLIER day, so every row — live or cached — is re-filtered to the
    // current tenant day; tomorrow's never reach the list, the counts, Mine /
    // Everyone or the prep card. Crew keep only their own.
    const today = todayKey()
    // Queued offline status changes (en_route/in_progress/completed) overlay
    // the cached/live rows so the day reads right after a relaunch.
    const myTodayAll = await overlayPending('jobs', homeDayRows(todayRes.data, user, today))

    setMonthRows((monthRes.data ?? []).filter((j: any) => new Date(j.scheduled_start) >= monthStart))

    // Same ownership filter + pending overlay as the day itself, so a queued
    // offline completion drops the row instead of nagging until it syncs.
    setStrandedRows(await overlayPending('jobs', (isOwner
      ? (strandedRes.data ?? [])
      : (strandedRes.data ?? []).filter((j: any) => isMyJob(j, user.id))
    )))

    // Sorted here rather than trusting the query's ORDER BY: the server can only
    // order by start time, which leaves same-slot jobs in an arbitrary — and
    // unstable — sequence, and ignores the route the dispatcher set. See
    // byCrewDayOrder for why time wins and route_order only breaks ties.
    //
    // "Next job" is derived from the SORTED list, not the raw one. It used to
    // take the first scheduled row in whatever order the query returned, so on
    // a day with several cleans in the same slot the crew's next stop was
    // whichever one Postgres happened to hand back first — and could change on
    // a refresh. Next now means next in the order they actually work.
    // (dayView picks active/next from this order.)
    setDayRows([...myTodayAll].sort(byCrewDayOrder))

    setLoading(false)
    setRefreshing(false)

    // Register OS arrival geofences for today's assigned jobs (GPS-verified
    // time tracking). Region-based — no tracking, no location writes until an
    // actual clock-in. No-op for daily-shift crews and non-granted phones.
    refreshArrivalGeofences(user).catch(() => {})

    // A live day read: save today's and tomorrow's stops for offline, from the
    // rows just read (lib/offlinePrefetch; at most every 10 minutes unless
    // pulled). A cached read means no signal — nothing to save from.
    if (!todayRes.fromCache && !todayRes.error) {
      prefetchDays(user, { rows: todayRes.data as any[], force: pulled }).catch(() => {})
    }
  }, [user, readShift])

  useEffect(() => { load() }, [load])

  // A queued Start that lost to a shift already running is settled into it
  // once signal returns (lib/outbox, resolveShiftStart). Read the shift again
  // then, so the card shows when the day really began, not the queued tap.
  useEffect(() => onOutboxDrained(() => readShift(loadGen.current)), [readShift])

  useEffect(() => {
    let live = true
    loadDayPack(user.id).then(p => { if (live) setDayPack(p) }).catch(() => {})
    const off = onDayPackChange((uid, p) => { if (uid === user.id) setDayPack(p) })
    return () => { live = false; off() }
  }, [user.id])

  // Cancelled jobs used to be filtered out server-side, so a cancellation
  // silently vanished from the crew's day — dayView keeps them apart as
  // explicit "cancelled" cards, so nobody drives to a dead job or wonders
  // where it went. They never count toward Today / Done / Remaining.
  const day = useMemo(() => dayView(dayRows, user.id, viewScope), [dayRows, user.id, viewScope])
  const todayJobs = day.jobs
  const cancelledToday = day.cancelled
  const activeJob = day.active
  const nextJob = day.next
  // Everyone, crew by crew (lib/crewGroups): the office's whole day in one
  // section per person, each numbered "Stop k of M" over that person's stops.
  // Mine, and every crew phone, keep the plain list and the day's stops.
  const youLabel = t('crew_you')
  const groups = useMemo(() => (isOffice && viewScope === 'everyone' ? crewGroups(day.jobs, user.id, youLabel) : null),
    [isOffice, viewScope, day.jobs, user.id, youLabel])
  const todayItems = useMemo(() => listItems(day.jobs, day.stops, groups), [day.jobs, day.stops, groups])
  // Still open after the offline overlay (load()), and narrowed like the day.
  const needsClosing = useMemo(() => jobsInScope(strandedRows, user.id, viewScope)
    .filter((j: any) => j.status === 'in_progress' || j.status === 'en_route'), [strandedRows, user.id, viewScope])
  const monthStats = useMemo(() => {
    const rows = jobsInScope(monthRows, user.id, viewScope)
    const hours = rows.reduce((s: number, j: any) => {
      if (!j.scheduled_end) return s
      return s + (new Date(j.scheduled_end).getTime() - new Date(j.scheduled_start).getTime()) / 3600000
    }, 0)
    // Earnings are filled in by the pay read started in load().
    return { completed: rows.length, hours: Math.round(hours * 10) / 10, earnings }
  }, [monthRows, earnings, user.id, viewScope])

  // Resolve "ready to close" vs "still short of photos" per stranded clean,
  // using the SAME job_completion_blockers() gate JobDetailScreen enforces on
  // Complete — so the badge can never promise something the gate then refuses.
  // Kept out of load() so the day paints first; badges fill in after. Offline
  // it simply stays unresolved and no badge renders.
  useEffect(() => {
    if (needsClosing.length === 0) { setClosingBlockers({}); return }
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(needsClosing.map(async (j: any) => {
        const { data, error } = await supabase.rpc('job_completion_blockers', { p_job_id: j.id })
        if (error) return null
        return [j.id, (data ?? []).length] as const
      }))
      if (cancelled) return
      setClosingBlockers(Object.fromEntries(entries.filter(Boolean) as (readonly [string, number])[]))
    })()
    return () => { cancelled = true }
  }, [needsClosing])

  // Live "on shift" timer
  useEffect(() => {
    if (!activeShift) { setShiftElapsed(''); return }
    const tick = () => {
      const secs = Math.max(0, Math.floor((Date.now() - new Date(activeShift.clocked_in_at).getTime()) / 1000))
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60)
      setShiftElapsed(`${h}h ${String(m).padStart(2, '0')}m`)
    }
    tick()
    const id = setInterval(tick, 30000)
    return () => clearInterval(id)
  }, [activeShift])

  // "9:24 AM" for a shift started today; "Mon, Sep 28 4:00 PM" for one still
  // open from an earlier day, so a forgotten shift doesn't read as this
  // morning's.
  const shiftSince = (iso: string) => new Date(iso) < startOfDayInTz(new Date())
    ? `${fmtDate(iso, localeFor(lang), { weekday: 'short' })} ${fmtTime(iso, localeFor(lang))}`
    : fmtTime(iso, localeFor(lang))

  // The person's open shift as the server has it now. `error` set = no answer.
  const readOpenShift = () => supabase.from('job_time_entries')
    .select('id, clocked_in_at')
    .eq('user_id', user.id).is('job_id', null).eq('entry_type', 'shift').is('clocked_out_at', null)
    .order('clocked_in_at', { ascending: false }).limit(1)

  // What Home shows for the shift after a reload with no signal.
  const saveShift = (shift: { id: string; clocked_in_at: string } | null, epoch: number) =>
    writeCacheEntry(dashShiftRead(user).key, shift, epoch)

  // "Start your day from when you arrived?": the arrival the phone recorded
  // at the home they're at (lib/siteVisits arrivalForStart), or the tap. Two
  // choices, theirs (CKS, 2026-10-23). Resolves to the arrival they picked,
  // or null for now. Not dismissable: a tap outside on Android isn't a choice.
  const askStartFrom = (arrival: { jobId: string; at: string }, tappedAt: string) => new Promise<string | null>(resolve => {
    const row = dayRows.find((r: any) => r.id === arrival.jobId)
    const home = (row?.client_addresses as any)?.nickname || (row?.client_addresses as any)?.street || t('arrival_generic_property')
    const arrived = fmtTime(arrival.at, localeFor(lang))
    Alert.alert(t('start_from_arrival_title'), ti(t('start_from_arrival_body'), { home, arrived }), [
      { text: ti(t('start_from_arrival_then'), { arrived }), onPress: () => resolve(arrival.at) },
      { text: ti(t('start_from_arrival_now'), { now: fmtTime(tappedAt, localeFor(lang)) }), onPress: () => resolve(null) },
    ], { cancelable: false })
  })

  async function handleStartDay() {
    if (startingDay.current) return
    startingDay.current = true
    shiftOps.current++
    setShiftBusy(true)
    const epoch = cacheEpoch()
    try {
      // The start is the tap, unless their phone recorded them reaching the
      // home they're at 5+ minutes before it (day-shift arrive/leave on): then
      // they pick the arrival or the tap, and a picked arrival is marked
      // (source 'prompted', arrived_at) for the office's Time logs. Where they
      // were is a best-effort GPS fix for the office (Time logs, Payroll, Team
      // today: "📍 Started at SILEX"); it waits at most 2.5 s and never holds
      // up the start (no fix, no stamp).
      const tappedAt = new Date().toISOString()
      const arrival = await arrivalForStart()
      const fromArrival = arrival ? await askStartFrom(arrival, tappedAt) : null
      const startedAt = fromArrival ?? tappedAt
      const stamp = await quickGpsStamp()
      // Client-minted id: offline the punch queues in the outbox (a shift IS the
      // day's pay) and replays idempotently when signal returns. The server
      // allows one open shift per person (job_time_entries_one_open_shift), so
      // this insert is also the "already started?" check; a shift left open
      // from an earlier day is closed by the server as this one starts.
      const entry = {
        id: uuid4(),
        tenant_id: user.tenant_id, user_id: user.id, job_id: null,
        entry_type: 'shift', clocked_in_at: startedAt,
        clock_in_lat: stamp?.lat ?? null, clock_in_lng: stamp?.lng ?? null,
        ...(fromArrival ? { source: 'prompted', arrived_at: fromArrival } : {}),
      }
      const { error, queued } = await writeThrough({
        table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: entry,
      })
      let started: { id: string; clocked_in_at: string } = entry
      if (error?.code === '23505') {
        // Already started: on the web, on another phone, or by a tap this
        // screen lost track of. Not a failure; show that shift.
        const { data: open } = await readOpenShift()
        // Couldn't read it back (signal dropped): reload, which shows it.
        if (!open?.length) { load(); return }
        started = open[0]
        Alert.alert('🟢', ti(t('day_already_started'), { time: shiftSince(started.clocked_in_at) }))
      } else if (error) {
        Alert.alert(t('error'), error.message)
        return
      } else if (queued) {
        Alert.alert('📡', t('queued_offline'))
      }
      setActiveShift(started)
      setShiftKnown(true)
      saveShift(started, epoch)
      // Start broadcasting location for the day so the crew shows live on
      // dispatch. Start-of-day is a user-initiated moment, so escalate to the
      // "Always" location prompt for pocket-tracking through the shift.
      startLocationTracking(user, { requestBackground: true }).catch(() => {})
    } finally {
      // Again on the way out: a read issued while the write was in flight saw
      // the state before it.
      shiftOps.current++
      setShiftBusy(false)
      startingDay.current = false
    }
  }

  async function handleEndDay() {
    if (!activeShift) return
    Alert.alert(t('end_my_day'), t('on_shift_since') + ' ' + shiftSince(activeShift.clocked_in_at), [
      { text: t('cancel') || 'Cancel', style: 'cancel' },
      { text: t('end_my_day'), style: 'destructive', onPress: async () => {
        shiftOps.current++
        setShiftBusy(true)
        const epoch = cacheEpoch()
        // The end is the tap; the GPS fix that stamps it comes back while the
        // open shift is read, and is left off if it doesn't come in 2.5 s.
        const out = new Date()
        const stampP = quickGpsStamp()
        try {
          // End the shift the server has open NOW. The one on screen can be
          // stale (ended or restarted on the web, or a start that lost to one
          // already running); ending its id changed nothing and left the real
          // shift open into the 16 h auto-close.
          let target = activeShift
          const live = await readOpenShift()
          if (!live.error) {
            if (live.data?.length) target = live.data[0]
            else if (!(await isQueued('job_time_entries', activeShift.id))) {
              // Nothing open on the server and no start of ours still queued:
              // the day was already ended elsewhere.
              setActiveShift(null)
              saveShift(null, epoch)
              stopLocationTracking().catch(() => {})
              Alert.alert('✓', t('day_already_ended'))
              return
            }
          }
          // No answer = no signal: end the one on screen. The outbox replays it,
          // pointed at the right row if its start lost to another.
          const stamp = await stampP
          const { error } = await writeThrough({
            table: 'job_time_entries', op: 'update', match: { id: target.id },
            values: {
              clocked_out_at: out.toISOString(),
              duration_minutes: Math.max(0, Math.round((out.getTime() - new Date(target.clocked_in_at).getTime()) / 60000)),
              clock_out_lat: stamp?.lat ?? null, clock_out_lng: stamp?.lng ?? null,
            },
          })
          if (error) { Alert.alert(t('error'), error.message); return }
          setActiveShift(null)
          saveShift(null, epoch)
          // Stop broadcasting once the shift ends.
          stopLocationTracking().catch(() => {})
        } finally {
          shiftOps.current++
          setShiftBusy(false)
        }
      } },
    ])
  }

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? t('good_morning') : hour < 17 ? t('good_afternoon') : t('good_evening')
  const packStops = stopsAhead(dayPack, todayKey())
  // "8:42 PM" today, "Yesterday 8:42 PM", else the date.
  const packTime = (at: string) => {
    const d = dayKey(at)
    if (d === todayKey()) return fmtTime(at, localeFor(lang))
    if (d === shiftYmd(todayKey(), -1)) return `${t('yesterday')} ${fmtTime(at, localeFor(lang))}`
    return fmtDateTime(at, localeFor(lang))
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true) }} tintColor={GOLD} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <Text style={styles.greeting}>{greeting}, {user.full_name?.split(' ')[0]} 👋</Text>
              <Text style={styles.date}>{capFirst(fmtDate(now, localeFor(lang), { weekday: 'long', month: 'long', day: 'numeric' }))}</Text>
            </View>
            <TouchableOpacity style={styles.sosBtn} onPress={onSOS} activeOpacity={0.8}>
              <Text style={styles.sosBtnText}>🆘</Text>
              <Text style={styles.sosHoldLabel}>SOS</Text>
            </TouchableOpacity>
          </View>

          {isOffice && (
            <View style={styles.scopeRow}>
              <JobScopeToggle scope={scope} onChange={setScope} />
            </View>
          )}

          {/* Stats bar */}
          <View style={styles.statsBar}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{todayJobs.length}</Text>
              <Text style={styles.statLabel}>{t('today')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>{day.done}</Text>
              <Text style={styles.statLabel}>{t('done_label')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>{day.remaining}</Text>
              <Text style={styles.statLabel}>{t('remaining')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>{monthStats.completed}</Text>
              <Text style={styles.statLabel}>{t('this_month')}</Text>
            </View>
          </View>
        </View>

        {/* Offline: rendering from the on-device cache — saved data, not live */}
        {offline && (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineBannerText}>📡 {t('offline_cached')}</Text>
          </View>
        )}

        {/* What the offline day pack holds. Hidden for an office user with
            no stops of their own — "0 stops" every day is noise there. */}
        {packStops != null && !(isOffice && packStops === 0) && dayPack && (
          <Text style={styles.dayPackLine}>
            ✓ {ti(t(packStops === 1 ? 'offline_pack_saved_one' : 'offline_pack_saved'), { time: packTime(dayPack.at), n: String(packStops) })}
          </Text>
        )}

        {/* Day-long shift clock-in (daily mode) */}
        {dailyMode && (
          !shiftKnown ? (
            <View style={styles.shiftCardPending}>
              <ActivityIndicator color={SLATE} size="small" />
              <Text style={styles.shiftPendingText}>{t('checking_day')}</Text>
            </View>
          ) : activeShift ? (
            <View style={styles.shiftCardOn}>
              <View style={{ flex: 1 }}>
                <Text style={styles.shiftOnLabel}>🟢 {t('on_shift_since')} {shiftSince(activeShift.clocked_in_at)}</Text>
                {!!shiftElapsed && <Text style={styles.shiftTimer}>{shiftElapsed}</Text>}
              </View>
              <TouchableOpacity style={styles.endDayBtn} onPress={handleEndDay} disabled={shiftBusy} activeOpacity={0.85}>
                {shiftBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.endDayBtnText}>{t('end_my_day')}</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.startDayBtn} onPress={handleStartDay} disabled={shiftBusy} activeOpacity={0.85}>
              {shiftBusy ? <ActivityIndicator color={SLATE} /> : <Text style={styles.startDayBtnText}>⏱  {t('start_my_day')}</Text>}
            </TouchableOpacity>
          )
        )}

        {loading ? (
          <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Active job banner */}
            {activeJob && (
              <TouchableOpacity style={styles.activeBanner} onPress={() => onJobPress(activeJob)}>
                <View style={styles.activePulse} />
                <View style={styles.activeInfo}>
                  <Text style={styles.activeLabel}>🔶 {t('active_job')}</Text>
                  <Text style={styles.activeClient}>
                    {(activeJob.client_addresses as any)?.nickname || (canSeeClientNames ? (activeJob.clients as any)?.full_name : (activeJob.client_addresses as any)?.street)}
                  </Text>
                  <Text style={styles.activeTime}>{fmtTime(activeJob.scheduled_start, localeFor(lang))} – {fmtTime(activeJob.scheduled_end, localeFor(lang))}</Text>
                </View>
                {/* Day shift: time on this job so far, from its Start (lib/jobTimer). */}
                {dailyMode && <JobClock job={activeJob} prefix="⏱ " style={styles.activeClock} />}
                <Text style={styles.activeArrow}>→</Text>
              </TouchableOpacity>
            )}

            {/* Get ready for today — renders nothing when there's nothing to prep */}
            <PrepCard user={user} jobs={todayJobs} onJobPress={onJobPress} />

            {/* Next job */}
            {nextJob && !activeJob && (
              <TouchableOpacity style={styles.nextJobCard} onPress={() => onJobPress(nextJob)}>
                <View style={styles.nextJobHeader}>
                  <Text style={styles.nextJobLabel}>⏰ {t('next_job')}</Text>
                  <Text style={styles.nextJobTime}>{fmtTime(nextJob.scheduled_start, localeFor(lang))}</Text>
                </View>
                <Text style={styles.nextJobClient}>
                  {(nextJob.client_addresses as any)?.nickname || (canSeeClientNames ? (nextJob.clients as any)?.full_name : (nextJob.client_addresses as any)?.street)}
                </Text>
                <Text style={styles.nextJobAddress}>
                  📍 {(nextJob.client_addresses as any)?.street}, {(nextJob.client_addresses as any)?.city}
                </Text>
                {(nextJob.client_addresses as any)?.lockbox_code && (
                  <Text style={styles.nextJobLockbox}>🔐 {(nextJob.client_addresses as any)?.lockbox_code}</Text>
                )}
              </TouchableOpacity>
            )}

            {/* Quick actions */}
            <View style={styles.quickActions}>
              <TouchableOpacity style={styles.quickBtn} onPress={() => onNavigate('schedule')}>
                <Text style={styles.quickBtnIcon}>📅</Text>
                <Text style={styles.quickBtnLabel}>{t('schedule')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.quickBtn} onPress={() => onNavigate('mileage')}>
                <Text style={styles.quickBtnIcon}>↗</Text>
                <Text style={styles.quickBtnLabel}>{t('log_miles')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.quickBtn} onPress={() => onNavigate('profile')}>
                <Text style={styles.quickBtnIcon}>◉</Text>
                <Text style={styles.quickBtnLabel}>{t('profile')}</Text>
              </TouchableOpacity>
            </View>

            {/* ── NEEDS CLOSING ──
                Cleans left open on an earlier day. Sits ABOVE today's list
                because it is overdue work, and because being unreachable is
                the whole reason these accumulate. */}
            {needsClosing.length > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: '#B45309' }]}>{t('needs_closing')} ({needsClosing.length})</Text>
                </View>
                <Text style={styles.needsClosingHint}>{t('needs_closing_hint')}</Text>
                {needsClosing.map((job: any) => {
                  const addr = job.client_addresses
                  const n = closingBlockers[job.id]
                  const isReady = n === 0
                  const days = Math.max(1, Math.floor((Date.now() - new Date(job.scheduled_start).getTime()) / 86400000))
                  return (
                    <TouchableOpacity key={job.id} style={styles.strandedRow} onPress={() => onJobPress(job)}>
                      <View style={[styles.jobDot, { backgroundColor: '#F59E0B' }]} />
                      <View style={styles.jobInfo}>
                        <Text style={styles.jobClient}>
                          {job.job_type === 'laundry_run' ? `🧺 ${t('laundry_run')}` : job.job_type === 'inspection' ? `🔍 ${t('inspection')} · ${addr?.nickname || addr?.street || ''}` : job.job_type === 'task' ? `📌 ${(job.internal_notes || t('task')).split('\n')[0]}` : (addr?.nickname || (canSeeClientNames ? (job.clients as any)?.full_name : addr?.street))}
                          {job.job_number ? <Text style={{ fontWeight: '400', opacity: 0.55 }}>  #{job.job_number}</Text> : null}
                        </Text>
                        <Text style={styles.jobTime}>
                          {fmtDate(job.scheduled_start, localeFor(lang))} · {ti(t('open_for_days'), { days: String(days) })}
                        </Text>
                        {/* No badge until the gate answers — an optimistic
                            "ready" that then refuses on Complete is worse. */}
                        {n !== undefined && (
                          <Text style={[styles.strandedBadge, isReady ? styles.strandedBadgeReady : styles.strandedBadgeBlocked]}>
                            {isReady ? t('ready_to_close') : ti(t('photos_outstanding'), { count: String(n) })}
                          </Text>
                        )}
                      </View>
                      <Text style={styles.jobArrow}>→</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            )}

            {/* Today's job list preview */}
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{t('todays_jobs')}</Text>
              </View>
              {todayJobs.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>{viewScope === 'mine' ? t('no_jobs_today_mine') : t('no_jobs_today')} 🌟</Text>
                </View>
              ) : todayItems.map(item => {
                if (item.kind === 'header') return <CrewGroupHeader key={`crew:${item.group.id}`} kind={item.group.kind} label={item.group.label} n={item.group.jobs.length} />
                const job = item.job
                const addr = job.client_addresses
                const isDone = job.status === 'completed'
                const isActive = job.status === 'in_progress'
                // Dispatcher-suggested driving order → "Stop k of M", ranked over
                // the viewer's own stops on Mine, each person's in a section (see
                // routeStops, crewGroups).
                const stop = item.stops[job.id]
                return (
                  <TouchableOpacity key={job.id} style={[styles.jobRow, isDone && { opacity: 0.5 }]} onPress={() => onJobPress(job)}>
                    <View style={[styles.jobDot, { backgroundColor: isDone ? '#10B981' : isActive ? '#F59E0B' : '#3B82F6' }]} />
                    <View style={styles.jobInfo}>
                      <Text style={styles.jobClient}>{job.job_type === 'laundry_run' ? `🧺 ${t('laundry_run')}` : job.job_type === 'inspection' ? `🔍 ${t('inspection')} · ${addr?.nickname || addr?.street || ''}` : job.job_type === 'task' ? `📌 ${(job.internal_notes || t('task')).split('\n')[0]}` : (addr?.nickname || (canSeeClientNames ? (job.clients as any)?.full_name : addr?.street))}{(job as any).job_number ? <Text style={{ fontWeight: '400', opacity: 0.55 }}>  #{(job as any).job_number}</Text> : null}</Text>
                      <Text style={styles.jobTime}>{[fmtTime(job.scheduled_start, localeFor(lang)), ...kindParts(job, kindLabels)].join(' · ')}</Text>
                      <CrewLine crew={job.crew} viewerId={user.id} showUnassigned={canSeeClientNames} />
                    </View>
                    {dailyMode && isActive && <JobClock job={job} prefix="⏱ " style={styles.jobClock} />}
                    {stop && (
                      <View style={styles.routeStopBadge}>
                        <Text style={styles.routeStopText}>🧭 {ti(t('route_stop_of'), { k: String(stop.k), m: String(stop.m) })}</Text>
                      </View>
                    )}
                    <Text style={styles.jobArrow}>→</Text>
                  </TouchableOpacity>
                )
              })}

              {/* Cancelled today — the job doesn't just vanish; the crew sees
                  what happened and why (first line of the cancellation note).
                  Under crew sections they get their own header, so they don't
                  read as the last person's. */}
              {groups && cancelledToday.length > 0 && <CrewGroupHeader kind="cancelled" n={cancelledToday.length} />}
              {cancelledToday.map((job: any) => {
                const addr = job.client_addresses
                const reason = (job.internal_notes || '').split('\n')[0]
                return (
                  <View key={job.id} style={[styles.jobRow, { opacity: 0.65, borderStyle: 'dashed' as const }]}>
                    <View style={[styles.jobDot, { backgroundColor: '#EF4444' }]} />
                    <View style={styles.jobInfo}>
                      <Text style={[styles.jobClient, { textDecorationLine: 'line-through' as const }]}>
                        {addr?.nickname || (job.clients as any)?.full_name}
                      </Text>
                      <Text style={[styles.jobTime, { color: '#EF4444', fontWeight: '700' as const }]}>
                        ❌ {t('job_cancelled_label')}{reason ? ` — ${reason}` : ''}
                      </Text>
                    </View>
                  </View>
                )
              })}
            </View>

            {/* Monthly earnings; tapping it opens My week (day by day, this week) */}
            {user.role !== 'owner' && (
              <TouchableOpacity style={styles.earningsCard} activeOpacity={0.85} onPress={() => onNavigate('week')}
                accessibilityRole="button" accessibilityLabel={t('week_open')}>
                <Text style={styles.earningsLabel}>💰 {t('my_earnings')}</Text>
                <Text style={styles.earningsValue}>{monthStats.earnings == null ? '—' : `$${monthStats.earnings.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}</Text>
                <View style={styles.earningsStats}>
                  <View style={styles.earningStat}>
                    <Text style={styles.earningStatValue}>{monthStats.completed}</Text>
                    <Text style={styles.earningStatLabel}>{t('done_label')}</Text>
                  </View>
                  <View style={styles.earningStat}>
                    <Text style={styles.earningStatValue}>{monthStats.hours}h</Text>
                    <Text style={styles.earningStatLabel}>{t('total_time')}</Text>
                  </View>
                </View>
                <Text style={styles.earningsLink}>{t('week_open')}</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  scroll: { paddingBottom: 40 },
  offlineBanner: { marginHorizontal: 16, marginTop: 12, backgroundColor: '#FEF3C7', borderColor: '#FCD34D', borderWidth: 1, borderRadius: 10, padding: 10 },
  offlineBannerText: { color: '#92400E', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  dayPackLine: { marginHorizontal: 16, marginTop: 10, fontSize: 11, color: '#64748B', textAlign: 'center' },
  startDayBtn:{ marginHorizontal: 16, marginTop: 16, backgroundColor: GOLD, borderRadius: 14, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
  startDayBtnText: { color: SLATE, fontSize: 17, fontWeight: '800' },
  shiftCardPending: { marginHorizontal: 16, marginTop: 16, backgroundColor: '#F1F5F9', borderRadius: 14, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  shiftPendingText: { color: '#64748B', fontSize: 15, fontWeight: '600' },
  shiftCardOn: { marginHorizontal: 16, marginTop: 16, backgroundColor: '#ECFDF5', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: '#A7F3D0' },
  shiftOnLabel: { color: '#065F46', fontSize: 14, fontWeight: '700' },
  shiftTimer: { color: '#047857', fontSize: 22, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  endDayBtn: { backgroundColor: '#10B981', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  endDayBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  header: { backgroundColor: SLATE_DARK, padding: 20, paddingBottom: 0 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  greeting: { color: '#fff', fontSize: 22, fontWeight: '800' },
  date: { color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 },
  sosBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', shadowColor: '#EF4444', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8 },
  sosBtnText: { fontSize: 20 },
  sosHoldLabel: { fontSize: 7, color: 'rgba(255,255,255,0.8)', fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.3 },
  scopeRow: { marginTop: -8, marginBottom: 14 },
  statsBar: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, padding: 14, marginBottom: 20 },
  stat: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, backgroundColor: 'rgba(255,255,255,0.1)' },
  statValue: { color: '#fff', fontSize: 20, fontWeight: '800' },
  statLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
  activeBanner: { margin: 16, backgroundColor: '#FEF3C7', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: '#FCD34D' },
  activePulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#F59E0B', marginRight: 12 },
  activeInfo: { flex: 1 },
  activeLabel: { fontSize: 11, fontWeight: '700', color: '#92400E', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  activeClient: { fontSize: 16, fontWeight: '800', color: '#111827', marginBottom: 2 },
  activeTime: { fontSize: 12, color: '#6B7280' },
  activeArrow: { fontSize: 18, color: '#F59E0B', fontWeight: '700' },
  activeClock: { fontSize: 18, fontWeight: '900', color: '#92400E', marginRight: 10, fontVariant: ['tabular-nums'] },
  jobClock: { fontSize: 13, fontWeight: '800', color: '#B45309', marginLeft: 8, fontVariant: ['tabular-nums'] },
  nextJobCard: { margin: 16, marginTop: 0, backgroundColor: '#fff', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#E2E8F0', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
  nextJobHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  nextJobLabel: { fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 },
  nextJobTime: { fontSize: 13, fontWeight: '700', color: GOLD },
  nextJobClient: { fontSize: 18, fontWeight: '800', color: '#0F172A', marginBottom: 4 },
  nextJobAddress: { fontSize: 12, color: '#64748B', marginBottom: 4 },
  nextJobLockbox: { fontSize: 12, color: '#334155', fontWeight: '600' },
  quickActions: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 16 },
  quickBtn: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4 },
  quickBtnIcon: { fontSize: 22, marginBottom: 4 },
  quickBtnLabel: { fontSize: 10, fontWeight: '700', color: '#334155', textAlign: 'center' },
  section: { paddingHorizontal: 16 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  seeAll: { fontSize: 12, color: GOLD, fontWeight: '600' },
  emptyCard: { backgroundColor: '#fff', borderRadius: 12, padding: 20, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  emptyText: { fontSize: 13, color: '#94A3B8' },
  jobRow: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  jobDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  jobInfo: { flex: 1 },
  jobClient: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  jobTime: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
  jobArrow: { fontSize: 16, color: '#CBD5E1' },
  // "Needs closing" — amber-bordered so an overdue clean reads as an
  // exception against the plain white rows of today's work.
  needsClosingHint: { fontSize: 11, color: '#94A3B8', marginBottom: 8, lineHeight: 15 },
  strandedRow: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#FCD34D' },
  strandedBadge: { alignSelf: 'flex-start', fontSize: 10, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, overflow: 'hidden', marginTop: 6 },
  strandedBadgeReady: { backgroundColor: '#DCFCE7', color: '#15803D' },
  strandedBadgeBlocked: { backgroundColor: '#FEE2E2', color: '#991B1B' },
  routeStopBadge: { backgroundColor: '#F5F3FF', borderColor: '#DDD6FE', borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginRight: 8 },
  routeStopText: { fontSize: 10, fontWeight: '800', color: '#6D28D9' },
  moreBtn: { backgroundColor: '#F8FAFC', borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  moreBtnText: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  earningsCard: { margin: 16, backgroundColor: SLATE_DARK, borderRadius: 16, padding: 20 },
  earningsLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  earningsValue: { color: GOLD, fontSize: 36, fontWeight: '900', marginBottom: 14 },
  earningsStats: { flexDirection: 'row', gap: 16 },
  earningStat: { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 10, padding: 10, flex: 1, alignItems: 'center' },
  earningStatValue: { color: '#fff', fontSize: 20, fontWeight: '800' },
  earningStatLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
  earningsLink: { color: GOLD, fontSize: 13, fontWeight: '800', marginTop: 14, textAlign: 'right' },
})
