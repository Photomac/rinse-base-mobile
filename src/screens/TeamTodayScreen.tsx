// "Team today": who is on the clock, for the office, on the phone.
//
// CKS Perfections asked for it on 2026-10-19 with a Homebase screenshot: the
// owner won't keep Safari open all day, so the day's clock-ins belong in the
// app. One list for the day, by clock-in time: "Clocked in at 8:21 AM · 7 hr
// 42 min so far" (ticking) or "Clocked out · 7:30 AM to 1:38 PM · 6 hr 8 min".
// Above it, who hasn't clocked in (people on the day's schedule first). A date
// switch looks back at earlier days.
//
// The owner fixes the day from here: End their day, Start their day (a
// day-shift company, today), Fix clock-in, Fix clock-out. The rules are the
// web's (lib/endDay); the writes go through the outbox like the crew's own
// punches, so a fix made on one bar is kept and sent when the signal returns.
// Managers and dispatchers see the same roster with no edit buttons
// (lib/teamDay canFixTeamTime). Crew never get here (App.tsx). Pay never shows:
// nothing on this screen reads a rate or an amount.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, ActivityIndicator, Modal, AppState } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor } from '../lib/i18n'
import { pauseReasonLabel } from '../lib/pauseReason'
import { GOLD, SLATE_DARK } from '../lib/theme'
import { cachedRead } from '../lib/dataCache'
import { writeThrough, overlayPending, flushOutbox, onOutboxDrained, uuid4 } from '../lib/outbox'
import { fmtDate, fmtTime, dayKey, todayKey, wallTimeInTz } from '../lib/timezone'
import {
  buildRoster, canSeeTeam, canFixTeamTime, hoursMinutes, nextStartAfter, cleansFor, addDays,
  type TeamEntry, type TeamPerson, type TeamClean, type RosterRow, type NotInRow,
} from '../lib/teamDay'
import {
  entryKind, suggestEnd, validateEnd, validateOfficeStart, validateStartFix, minutesBetween, endedNote, startedNote,
  SHIFT_CAP_MS, type Suggestion, type TimeProblem,
} from '../lib/endDay'
import { teamPeopleRead, teamEntriesRead, teamCleansRead, readEntryNow, readOpenShiftNow } from '../lib/teamReads'
import { TeamTimeForm, problemText, type TimeChip } from '../components/TeamTimeForm'

const LONG_OPEN_MS = 10 * 3_600_000

type Fix =
  /** cleans: that day's, when the entry began on another day than the one shown */
  | { mode: 'end'; entry: TeamEntry; cleans?: TeamClean[] }
  | { mode: 'start'; personId: string }
  | { mode: 'fix_in'; entry: TeamEntry }
  | { mode: 'fix_out'; entry: TeamEntry }

function cleanFromRow(j: any): TeamClean {
  const a = j.client_addresses
  return {
    id: j.id, status: j.status, job_type: j.job_type, scheduled_start: j.scheduled_start, scheduled_end: j.scheduled_end,
    completed_at: j.completed_at, completed_by_user_id: j.completed_by_user_id,
    crew: ((j.job_assignments ?? []) as any[]).map(x => x.user_id).filter(Boolean),
    label: a?.nickname || a?.street || '',
  }
}

export function TeamTodayScreen({ user, navigation, onBack }: { user: any; navigation?: any; onBack?: () => void }) {
  const { t, lang } = useLang()
  const locale = localeFor(lang)
  const tenantId: string = user.tenant_id
  const office = canSeeTeam(user.role)
  const canFix = canFixTeamTime(user.role)
  const dailyMode = user._timeMode === 'daily'

  const [ymd, setYmd] = useState(() => todayKey())
  const [people, setPeople] = useState<TeamPerson[]>([])
  const [entries, setEntries] = useState<TeamEntry[]>([])
  const [cleans, setCleans] = useState<TeamClean[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [offline, setOffline] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  const [fix, setFix] = useState<Fix | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [flash, setFlash] = useState('')
  // Bumped per load: an older load's late answer must not replace a newer day.
  const loadGen = useRef(0)
  // The load reads the strings through a ref: a new t() must not re-run it.
  const tRef = useRef(t)
  tRef.current = t

  const isToday = ymd === todayKey()
  const dayStartMs = useMemo(() => wallTimeInTz(ymd, 0, 0).getTime(), [ymd])
  const dayEndMs = useMemo(() => wallTimeInTz(addDays(ymd, 1), 0, 0).getTime(), [ymd])

  const load = useCallback(async () => {
    if (!office) { setLoading(false); return }
    const gen = ++loadGen.current
    // Queued fixes (and the owner's own punches) go out first chance we get.
    flushOutbox().catch(() => {})
    const today = ymd === todayKey()
    // Today is kept for offline; an earlier day is read live (lib/teamReads).
    const run = (r: { key: string; q: () => PromiseLike<any> }) => today
      ? cachedRead(r)
      : Promise.resolve(r.q()).then((res: any) => ({ data: res.data, error: res.error, fromCache: false }))
    try {
      const [p, e, c] = await Promise.all([
        cachedRead(teamPeopleRead(tenantId)),
        run(teamEntriesRead(tenantId, dayStartMs, dayEndMs)),
        run(teamCleansRead(tenantId, dayStartMs, dayEndMs)),
      ])
      if (gen !== loadGen.current) return
      const failed = p.error || e.error || c.error
      if (failed) setLoadError(ti(tRef.current('team_load_failed'), { error: failed.message || String(failed) }))
      else setLoadError('')
      if (!p.error) setPeople((p.data ?? []) as TeamPerson[])
      if (!e.error) {
        // A start or end queued on this phone (no signal) shows as made.
        const rows = await overlayPending('job_time_entries', (e.data ?? []) as any[],
          v => v.tenant_id === tenantId && typeof v.clocked_in_at === 'string')
        if (gen !== loadGen.current) return
        setEntries(rows as TeamEntry[])
      }
      if (!c.error) setCleans(((c.data ?? []) as any[]).map(cleanFromRow))
      setOffline(!!(p.fromCache || e.fromCache || c.fromCache))
    } catch (err: any) {
      if (gen === loadGen.current) setLoadError(ti(tRef.current('team_load_failed'), { error: err?.message || String(err) }))
    } finally {
      if (gen === loadGen.current) { setLoading(false); setRefreshing(false) }
    }
  }, [office, ymd, tenantId, dayStartMs, dayEndMs])

  useEffect(() => { setLoading(true); load() }, [load])
  // Back on the tab, back in the app, or queued writes just went out: re-read.
  useEffect(() => navigation?.addListener?.('focus', () => { load() }), [navigation, load])
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') load() })
    return () => sub.remove()
  }, [load])
  useEffect(() => onOutboxDrained(() => { load() }), [load])

  // The running clocks tick.
  useEffect(() => {
    setNowMs(Date.now())
    if (!isToday) return
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [isToday])

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(''), 6_000)
    return () => clearTimeout(id)
  }, [flash])

  const roster = useMemo(() => buildRoster({ people, entries, cleans, dayStartMs, dayEndMs, nowMs, isToday }),
    [people, entries, cleans, dayStartMs, dayEndMs, nowMs, isToday])
  const onClock = roster.rows.filter(r => r.open).length
  const nameOf = useCallback((id: string | null | undefined) =>
    (people.find(p => p.id === id)?.full_name || '').trim() || t('team_someone_else'), [people, t])
  const firstName = (name: string) => name.trim().split(/\s+/)[0] || name

  // ── Formatting ──
  const timeOf = (ms: number) => fmtTime(new Date(ms), locale)
  /** A time on the day being looked at; weekday + time on any other day. */
  const when = (ms: number) => dayKey(new Date(ms)) === ymd
    ? timeOf(ms)
    : `${fmtDate(new Date(ms), locale, { weekday: 'short', month: 'short', day: 'numeric' })} ${timeOf(ms)}`
  const dur = (ms: number, running: boolean) => {
    const { h, m } = hoursMinutes(ms, running)
    if (h && m) return ti(t('team_hm'), { h: String(h), m: String(m) })
    if (h) return ti(t('team_h'), { h: String(h) })
    return ti(t('team_m'), { m: String(m) })
  }
  const dayTitle = (() => {
    const label = fmtDate(ymd, locale, { weekday: 'short', month: 'short', day: 'numeric' })
    if (isToday) return `${t('today')} · ${label}`
    if (ymd === addDays(todayKey(), -1)) return `${t('yesterday')} · ${label}`
    return label
  })()
  /** "Clocked in at 8:21 AM", or "Clocked in since Mon, Oct 19 4:40 PM" for a start on another day. */
  const sinceText = (ms: number) => (dayKey(new Date(ms)) === ymd
    ? ti(t('team_clocked_in_at'), { time: timeOf(ms) })
    : ti(t('team_clocked_in_since'), { when: when(ms) }))
  const entryLabel = (e: TeamEntry) => entryKind(e) === 'shift'
    ? t('team_day_shift')
    : (cleans.find(c => c.id === e.job_id)?.label || t('team_clean_entry'))

  /** "Clocked in at 8:21 AM" / "Clocked out · 7:30 AM to 1:38 PM": the row's
   *  line, with the hours in their own column (rowHours). */
  function statusHead(r: RosterRow): string {
    if (r.open) {
      const since = Date.parse(r.open.clocked_in_at)
      return r.openFromEarlierDay
        ? ti(t('team_clocked_in_since'), { when: when(since) })
        : ti(t('team_clocked_in_at'), { time: timeOf(since) })
    }
    const span = ti(t('team_in_to_out'), { in: when(r.firstInMs), out: r.lastOutMs != null ? when(r.lastOutMs) : '—' })
    return `${t('team_clocked_out')} · ${span}`
  }
  const rowHours = (r: RosterRow) => dur(r.workedMs, !!r.open)
  /** The whole sentence: "Clocked in at 8:21 AM · 7 hr 42 min so far". */
  const statusLine = (r: RosterRow) => (r.open
    ? `${statusHead(r)} · ${ti(t('team_so_far'), { dur: rowHours(r) })}`
    : `${statusHead(r)} · ${rowHours(r)}`)

  function notInLine(n: NotInRow): string {
    if (!n.cleans) return t('team_not_scheduled')
    const first = n.firstCleanMs != null ? timeOf(n.firstCleanMs) : '—'
    return n.cleans === 1 ? ti(t('team_cleans_one'), { time: first }) : ti(t('team_cleans_n'), { n: String(n.cleans), time: first })
  }

  const describe = (p: TimeProblem | null) => (p ? problemText(p, t, when, timeOf) : null)

  // ── Saving ──
  const closeAll = () => { setFix(null); setSheetFor(null); setSaveError('') }
  const iso = (ms: number) => new Date(ms).toISOString()
  const sameMs = (a: string | null | undefined, ms: number | null) => (a ? Date.parse(a) : null) === ms

  async function saveEnd(entry: TeamEntry, endMs: number) {
    const kind = entryKind(entry)
    const person = firstName(nameOf(entry.user_id))
    // Re-read: it may have been ended, or its start fixed, since the sheet opened.
    const live = await readEntryNow(entry.id)
    let cur: TeamEntry = entry
    if (!live.error) {
      if (!live.data) { setFlash(t('team_gone')); closeAll(); load(); return }
      cur = live.data as TeamEntry
      if (cur.clocked_out_at) {
        setFlash(ti(t('team_already_ended'), { time: when(Date.parse(cur.clocked_out_at)) })); closeAll(); load(); return
      }
    }
    const now = Date.now()
    const startMs = Date.parse(cur.clocked_in_at)
    const problem = validateEnd({ kind, startMs, endMs, nowMs: now, nextStartMs: nextStartAfter(cur, entries) })
    if (problem) { setSaveError(describe(problem) || ''); return }
    const end = Math.min(endMs, now) // inside the one-minute grace, never a future time
    const { error, queued } = await writeThrough({
      table: 'job_time_entries', op: 'update',
      // Only while it's still open: a replay never overwrites a day ended since.
      match: { id: cur.id, clocked_out_at: null },
      values: {
        clocked_out_at: iso(end),
        duration_minutes: minutesBetween(startMs, end),
        edited_at: iso(now),
        edited_by: user.id,
        // The crew's own punch-in, kept the first time anyone edits the row.
        ...(cur.original_clocked_in_at ? {} : { original_clocked_in_at: cur.clocked_in_at }),
        pause_reason: endedNote(kind, user.full_name, cur.pause_reason),
      },
    })
    if (error) { setSaveError(error.message || String(error)); return }
    if (queued) setFlash(t('queued_offline'))
    else {
      const after = await readEntryNow(cur.id)
      const out = (after.data as TeamEntry | null)?.clocked_out_at
      if (!after.error && after.data && !sameMs(out, end)) {
        setFlash(out ? ti(t('team_already_ended'), { time: when(Date.parse(out)) }) : t('team_not_changed'))
      } else {
        setFlash(ti(t(kind === 'shift' ? 'team_done_ended' : 'team_done_clocked_out'), { name: person, time: when(end) }))
      }
    }
    closeAll()
    load()
  }

  async function saveStart(personId: string, startMs: number) {
    const now = Date.now()
    const problem = validateOfficeStart({ startMs, nowMs: now })
    if (problem) { setSaveError(describe(problem) || ''); return }
    const person = firstName(nameOf(personId))
    // The same open shift "Start my day" writes: the person's phone shows the
    // day running and their End my day closes it. Client-minted id, so a
    // replay from the outbox can't add a second row.
    const entry = {
      id: uuid4(), tenant_id: tenantId, user_id: personId, job_id: null, entry_type: 'shift',
      clocked_in_at: iso(Math.min(startMs, now)),
      edited_at: iso(now), edited_by: user.id,
      pause_reason: startedNote(user.full_name),
    }
    const { error, queued } = await writeThrough({ table: 'job_time_entries', op: 'upsert', onConflict: 'id', values: entry })
    if (error?.code === '23505') {
      // job_time_entries_one_open_shift: their day is already running (their
      // phone, the web, or another office phone got there first).
      const { data: open } = await readOpenShiftNow(personId)
      setFlash(open?.length
        ? ti(t('team_already_on'), { name: person, time: when(Date.parse(open[0].clocked_in_at)) })
        : ti(t('team_already_on_plain'), { name: person }))
      closeAll(); load(); return
    }
    if (error) { setSaveError(error.message || String(error)); return }
    setFlash(queued ? t('queued_offline') : ti(t('team_done_started'), { name: person, time: timeOf(Date.parse(entry.clocked_in_at)) }))
    closeAll()
    load()
  }

  async function saveFix(entry: TeamEntry, which: 'in' | 'out', ms: number) {
    const kind = entryKind(entry)
    const live = await readEntryNow(entry.id)
    let cur: TeamEntry = entry
    if (!live.error) {
      if (!live.data) { setFlash(t('team_gone')); closeAll(); load(); return }
      cur = live.data as TeamEntry
      // Changed under the owner (ended, or fixed on the web): show the new
      // times before anything is written over them.
      const shownOut = entry.clocked_out_at ? Date.parse(entry.clocked_out_at) : null
      if (!sameMs(cur.clocked_in_at, Date.parse(entry.clocked_in_at)) || !sameMs(cur.clocked_out_at, shownOut)) {
        setFlash(t('team_changed_meanwhile')); closeAll(); load(); return
      }
    }
    const now = Date.now()
    const open = !cur.clocked_out_at
    const inMs = which === 'in' ? Math.min(ms, now) : Date.parse(cur.clocked_in_at)
    const outMs = open ? null : which === 'out' ? Math.min(ms, now) : Date.parse(cur.clocked_out_at as string)
    const problem = which === 'in'
      ? validateStartFix({ kind, startMs: ms, endMs: outMs, nowMs: now })
      : validateEnd({ kind, startMs: inMs, endMs: ms, nowMs: now, nextStartMs: nextStartAfter(cur, entries) })
    if (problem) { setSaveError(describe(problem) || ''); return }
    const { error, queued } = await writeThrough({
      table: 'job_time_entries', op: 'update',
      // A running entry's start only while it still runs: a fix replayed after
      // the crew ended the day would leave its minutes counted from the old start.
      match: open ? { id: cur.id, clocked_out_at: null } : { id: cur.id },
      values: {
        clocked_in_at: iso(inMs),
        ...(outMs != null ? { clocked_out_at: iso(outMs), duration_minutes: minutesBetween(inMs, outMs) } : {}),
        original_clocked_in_at: cur.original_clocked_in_at || cur.clocked_in_at,
        ...(open ? {} : { original_clocked_out_at: cur.original_clocked_out_at || cur.clocked_out_at }),
        // edited_at changing is what lets the office move a closed row's times
        // (guard_closed_time_entry_times), its own row included.
        edited_at: iso(now),
        edited_by: user.id,
      },
    })
    if (error) { setSaveError(error.message || String(error)); return }
    if (queued) setFlash(t('queued_offline'))
    else {
      const after = await readEntryNow(cur.id)
      const a = after.data as TeamEntry | null
      if (!after.error && a && (!sameMs(a.clocked_in_at, inMs) || (outMs != null && !sameMs(a.clocked_out_at, outMs)))) {
        setFlash(t('team_not_changed'))
      } else {
        setFlash(outMs != null
          ? ti(t('team_done_fixed'), { in: when(inMs), out: when(outMs) })
          : ti(t('team_done_fixed_open'), { in: when(inMs) }))
      }
    }
    closeAll()
    load()
  }

  async function onSave(ms: number) {
    if (!fix || saving) return
    setSaving(true)
    setSaveError('')
    try {
      if (fix.mode === 'end') await saveEnd(fix.entry, ms)
      else if (fix.mode === 'start') await saveStart(fix.personId, ms)
      else await saveFix(fix.entry, fix.mode === 'fix_in' ? 'in' : 'out', ms)
    } catch (err: any) {
      setSaveError(err?.message || String(err))
    } finally {
      setSaving(false)
    }
  }

  /**
   * End their day. A day left open from an earlier day (nobody ended it) is
   * suggested an end from THAT day's cleans, as the web does: her last
   * completion yesterday, not 16 h. Read live (no signal: today's cleans, so
   * the cap); the saved copy of today is never overwritten by it.
   */
  async function openEnd(e: TeamEntry) {
    setSaveError('')
    const startDay = dayKey(new Date(Date.parse(e.clocked_in_at)))
    if (startDay === ymd) { setFix({ mode: 'end', entry: e }); return }
    const r = teamCleansRead(tenantId, wallTimeInTz(startDay, 0, 0).getTime(), wallTimeInTz(addDays(startDay, 1), 0, 0).getTime())
    let theirDay: TeamClean[] | undefined
    try {
      const res: any = await r.q()
      if (!res.error) theirDay = ((res.data ?? []) as any[]).map(cleanFromRow)
    } catch { /* no answer: suggest from what's loaded */ }
    setFix({ mode: 'end', entry: e, cleans: theirDay })
  }

  // ── The form for the fix being made ──
  function formFor(f: Fix) {
    const self = (id: string) => id === user.id
    if (f.mode === 'start') {
      const name = firstName(nameOf(f.personId))
      return (
        <TeamTimeForm
          key="start"
          title={ti(t('team_start_title'), { name })}
          subtitle={t('team_start_note')}
          initialMs={nowMs}
          days={[todayKey()]}
          chips={[{ label: t('team_now'), ms: Date.now() }]}
          check={ms => describe(validateOfficeStart({ startMs: ms, nowMs: Date.now() }))}
          result={() => null}
          saving={saving} error={saveError}
          onCancel={() => { setFix(null); setSaveError('') }}
          onSave={onSave}
        />
      )
    }
    const e = f.entry
    const kind = entryKind(e)
    const name = firstName(nameOf(e.user_id))
    const startMs = Date.parse(e.clocked_in_at)
    const startDay = dayKey(new Date(startMs))
    const nextStartMs = nextStartAfter(e, entries)
    const spanText = (fromMs: number, toMs: number) => {
      const mins = minutesBetween(fromMs, toMs)
      const base = ti(t(kind === 'shift' ? 'team_makes_day' : 'team_makes_job'), { dur: dur(mins * 60_000, false) })
      return mins * 60_000 > SHIFT_CAP_MS ? `${base} ${t('team_over_cap')}` : base
    }
    // The end may fall on the start's day or the day after (a late finish).
    const endDays = Array.from(new Set([startDay, addDays(startDay, 1)])).filter(d => d <= todayKey())
    if (f.mode === 'end') {
      const dayCleans = f.cleans ?? cleans
      const job = dayCleans.find(c => c.id === e.job_id)
      const s: Suggestion = suggestEnd({
        kind, startMs, nowMs: Date.now(), nextStartMs, personId: e.user_id,
        cleans: cleansFor(e.user_id, dayCleans),
        jobScheduledStart: job?.scheduled_start, jobScheduledEnd: job?.scheduled_end,
      })
      const c = dayCleans.find(x => x.id === s.cleanId)
      const place = c?.label || t('team_clean_entry')
      const why = s.reason === 'own_completion' ? ti(t('team_why_own'), { name, place })
        : s.reason === 'crew_completion' ? ti(t('team_why_crew'), { name, place, presser: c?.completed_by_user_id === user.id ? t('crew_you') : nameOf(c?.completed_by_user_id) })
        : s.reason === 'next_start' ? t('team_why_next')
        : s.reason === 'shift_cap' ? t('team_why_cap')
        : s.reason === 'scheduled_length' ? t('team_why_scheduled')
        : t('team_why_now')
      const chips: TimeChip[] = [{ label: ti(t('team_suggested'), { time: when(s.ms) }), ms: s.ms }, { label: t('team_now'), ms: Date.now() }]
      return (
        <TeamTimeForm
          key={`end-${e.id}`}
          title={kind === 'shift'
            ? (self(e.user_id) ? t('team_end_title_self') : ti(t('team_end_title'), { name }))
            : ti(t('team_clock_out_title'), { name })}
          subtitle={ti(t('team_started_line'), { when: when(startMs), dur: dur(Math.max(0, Date.now() - startMs), true) })}
          initialMs={s.ms}
          days={endDays}
          chips={chips}
          why={why} whyWarn={s.reason === 'crew_completion'}
          check={ms => describe(validateEnd({ kind, startMs, endMs: ms, nowMs: Date.now(), nextStartMs }))}
          result={ms => spanText(startMs, Math.min(ms, Date.now()))}
          saving={saving} error={saveError}
          onCancel={() => { setFix(null); setSaveError('') }}
          onSave={onSave}
        />
      )
    }
    const endMs = e.clocked_out_at ? Date.parse(e.clocked_out_at) : null
    if (f.mode === 'fix_in') {
      return (
        <TeamTimeForm
          key={`in-${e.id}`}
          title={ti(t('team_fix_in_title'), { name })}
          subtitle={`${entryLabel(e)} · ${endMs != null ? ti(t('team_entry_line'), { in: when(startMs), out: when(endMs) }) : sinceText(startMs)}`}
          initialMs={startMs}
          days={[startDay]}
          chips={endMs == null ? [{ label: t('team_now'), ms: Date.now() }] : []}
          check={ms => describe(validateStartFix({ kind, startMs: ms, endMs, nowMs: Date.now() }))}
          result={ms => (endMs != null ? spanText(ms, endMs) : null)}
          saving={saving} error={saveError}
          onCancel={() => { setFix(null); setSaveError('') }}
          onSave={onSave}
        />
      )
    }
    return (
      <TeamTimeForm
        key={`out-${e.id}`}
        title={ti(t('team_fix_out_title'), { name })}
        subtitle={`${entryLabel(e)} · ${endMs != null ? ti(t('team_entry_line'), { in: when(startMs), out: when(endMs) }) : sinceText(startMs)}`}
        initialMs={endMs ?? Date.now()}
        days={endDays}
        chips={[]}
        check={ms => describe(validateEnd({ kind, startMs, endMs: ms, nowMs: Date.now(), nextStartMs }))}
        result={ms => spanText(startMs, ms)}
        saving={saving} error={saveError}
        onCancel={() => { setFix(null); setSaveError('') }}
        onSave={onSave}
      />
    )
  }

  // ── The person sheet ──
  const sheetRow = sheetFor ? roster.rows.find(r => r.personId === sheetFor) ?? null : null
  const sheetNotIn = sheetFor && !sheetRow ? roster.notIn.find(n => n.personId === sheetFor) ?? null : null
  const sheetName = sheetRow?.name || sheetNotIn?.name || ''
  const startable = canFix && dailyMode && isToday && !!sheetNotIn

  function entryCard(e: TeamEntry) {
    const s = Date.parse(e.clocked_in_at)
    const end = e.clocked_out_at ? Date.parse(e.clocked_out_at) : null
    const open = end == null
    const kind = entryKind(e)
    return (
      <View key={e.id} style={styles.entryCard}>
        <View style={styles.entryTop}>
          <View style={[styles.dot, open ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.entryLabel}>{entryLabel(e)}</Text>
        </View>
        <Text style={styles.entryTimes}>
          {open ? sinceText(s) : ti(t('team_entry_line'), { in: when(s), out: when(end as number) })}
          {' · '}
          {open ? ti(t('team_so_far'), { dur: dur(Math.max(0, nowMs - s), true) }) : dur((end as number) - s, false)}
        </Text>
        {!!e.edited_by && <Text style={styles.entryMeta}>{ti(t('team_edited_by'), { name: nameOf(e.edited_by) })}</Text>}
        {!!e.pause_reason && <Text style={styles.entryMeta} numberOfLines={3}>{pauseReasonLabel(e.pause_reason, t)}</Text>}
        {canFix && (
          <View style={styles.entryBtns}>
            {open && (
              <TouchableOpacity style={[styles.smallBtn, styles.smallBtnGold]} onPress={() => openEnd(e)}>
                <Text style={styles.smallBtnGoldText}>{kind === 'shift' ? t('team_end_day') : t('team_clock_out')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.smallBtn} onPress={() => { setSaveError(''); setFix({ mode: 'fix_in', entry: e }) }}>
              <Text style={styles.smallBtnText}>{t('team_fix_in')}</Text>
            </TouchableOpacity>
            {!open && (
              <TouchableOpacity style={styles.smallBtn} onPress={() => { setSaveError(''); setFix({ mode: 'fix_out', entry: e }) }}>
                <Text style={styles.smallBtnText}>{t('team_fix_out')}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    )
  }

  const avatar = (initials: string, state: 'on' | 'off' | 'none') => (
    <View style={[styles.avatar, state === 'on' ? styles.avatarOn : state === 'off' ? styles.avatarOff : styles.avatarNone]}>
      <Text style={[styles.avatarText, state === 'on' ? { color: '#065F46' } : state === 'off' ? { color: '#475569' } : { color: '#94A3B8' }]}>{initials}</Text>
    </View>
  )
  const you = (id: string) => (id === user.id ? <Text style={styles.you}>{`  · ${t('crew_you')}`}</Text> : null)

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          {onBack && (
            <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityLabel={t('back')}>
              <Text style={styles.backText}>‹ {t('back')}</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.title}>👥 {t('team_title')}</Text>
        </View>
        <Text style={styles.subtitle}>{dailyMode ? t('team_daily_note') : t('team_per_job_note')}</Text>
        <View style={styles.dateRow}>
          <TouchableOpacity style={styles.dateArrow} onPress={() => setYmd(d => addDays(d, -1))} accessibilityLabel="‹">
            <Text style={styles.dateArrowText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setYmd(todayKey())}>
            <Text style={styles.dateText}>{dayTitle}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.dateArrow, isToday && { opacity: 0.25 }]} disabled={isToday}
            onPress={() => setYmd(d => (d < todayKey() ? addDays(d, 1) : d))} accessibilityLabel="›">
            <Text style={styles.dateArrowText}>›</Text>
          </TouchableOpacity>
        </View>
        {office && !loading && (
          <Text style={styles.summary}>
            {ti(t('team_summary'), { in: String(onClock), out: String(roster.rows.length - onClock), notin: String(roster.notIn.length) })}
          </Text>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={GOLD} />}
      >
        {!office ? (
          <Text style={styles.empty}>{t('team_office_only')}</Text>
        ) : loading ? (
          <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
        ) : (
          <>
            {offline && <View style={styles.offline}><Text style={styles.offlineText}>{t('team_offline')}</Text></View>}
            {!!loadError && <View style={styles.errorBox}><Text style={styles.errorText}>{loadError}</Text></View>}

            {roster.notIn.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>{isToday ? t('team_not_in') : t('team_no_time')} · {roster.notIn.length}</Text>
                <View style={styles.card}>
                  {roster.notIn.map((n, i) => (
                    <TouchableOpacity key={n.personId} style={[styles.row, i > 0 && styles.rowBorder]} activeOpacity={0.7}
                      onPress={() => { setSaveError(''); setFix(null); setSheetFor(n.personId) }}>
                      {avatar(n.initials, 'none')}
                      <View style={styles.rowBody}>
                        <Text style={styles.name} numberOfLines={1}>{n.name}{you(n.personId)}</Text>
                        <Text style={[styles.line, n.cleans > 0 && isToday && { color: '#B45309' }]}>{notInLine(n)}</Text>
                      </View>
                      {canFix && dailyMode && isToday && (
                        <TouchableOpacity style={styles.startChip}
                          onPress={() => { setSaveError(''); setSheetFor(n.personId); setFix({ mode: 'start', personId: n.personId }) }}>
                          <Text style={styles.startChipText}>{t('team_start_day')}</Text>
                        </TouchableOpacity>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            <Text style={styles.sectionTitle}>{t('team_title')} · {roster.rows.length}</Text>
            {roster.rows.length === 0 ? (
              <Text style={styles.empty}>{isToday ? t('team_nobody_today') : t('team_nobody_day')}</Text>
            ) : (
              <View style={styles.card}>
                {roster.rows.map((r, i) => {
                  const long = !!r.open && (r.openFromEarlierDay || nowMs - Date.parse(r.open.clocked_in_at) >= LONG_OPEN_MS)
                  return (
                    <TouchableOpacity key={r.personId} style={[styles.row, i > 0 && styles.rowBorder]} activeOpacity={0.7}
                      onPress={() => { setSaveError(''); setFix(null); setSheetFor(r.personId) }}>
                      {avatar(r.initials, r.open ? 'on' : 'off')}
                      <View style={styles.rowBody}>
                        <Text style={styles.name} numberOfLines={1}>{r.name}{you(r.personId)}</Text>
                        <View style={styles.lineRow}>
                          <View style={[styles.dot, r.open ? styles.dotOn : styles.dotOff]} />
                          <Text style={[styles.line, r.open && styles.lineOn]}>{statusHead(r)}</Text>
                        </View>
                        {long && <Text style={styles.warn}>{r.openFromEarlierDay ? t('team_open_earlier') : t('team_open_long')}</Text>}
                        {r.entries.length > 1 && <Text style={styles.meta}>{ti(t('team_entries_n'), { n: String(r.entries.length) })}</Text>}
                      </View>
                      <View style={styles.hoursCol}>
                        <Text style={[styles.hours, r.open && styles.hoursOn]}>{rowHours(r)}</Text>
                        {!!r.open && <Text style={styles.hoursSub}>{t('team_so_far_label')}</Text>}
                      </View>
                      <Text style={styles.chev}>›</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {!!flash && (
        <TouchableOpacity style={styles.flash} activeOpacity={0.9} onPress={() => setFlash('')} accessibilityLiveRegion="polite">
          <Text style={styles.flashText}>{flash}</Text>
        </TouchableOpacity>
      )}

      <Modal visible={!!sheetFor} transparent animationType="slide" onRequestClose={() => { if (!saving) closeAll() }}>
        <View style={styles.sheetWrap}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => { if (!saving) closeAll() }} />
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: 36 }}>
              {fix ? formFor(fix) : (
                <>
                  <View style={styles.sheetHead}>
                    {avatar(sheetRow?.initials || sheetNotIn?.initials || '?', sheetRow?.open ? 'on' : sheetRow ? 'off' : 'none')}
                    <View style={styles.rowBody}>
                      <Text style={styles.sheetName}>{sheetName}</Text>
                      <Text style={styles.line}>{sheetRow ? statusLine(sheetRow) : sheetNotIn ? `${isToday ? t('team_not_in') : t('team_no_time')} · ${notInLine(sheetNotIn)}` : ''}</Text>
                    </View>
                    <TouchableOpacity onPress={closeAll} accessibilityLabel={t('cancel')}><Text style={styles.close}>×</Text></TouchableOpacity>
                  </View>
                  {sheetRow?.entries.map(entryCard)}
                  {startable && (
                    <>
                      <TouchableOpacity style={styles.bigBtn} onPress={() => { setSaveError(''); setFix({ mode: 'start', personId: sheetFor as string }) }}>
                        <Text style={styles.bigBtnText}>⏱  {t('team_start_day')}</Text>
                      </TouchableOpacity>
                      <Text style={styles.meta}>{t('team_start_note')}</Text>
                    </>
                  )}
                  {!canFix && <Text style={[styles.meta, { marginTop: 12 }]}>{t('team_view_only')}</Text>}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: SLATE_DARK, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14 },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backBtn: { paddingVertical: 4, paddingRight: 4 },
  backText: { color: GOLD, fontSize: 15, fontWeight: '700' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  subtitle: { color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 2 },
  dateRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12 },
  dateArrow: { paddingHorizontal: 16, paddingVertical: 8 },
  dateArrowText: { color: '#fff', fontSize: 24, fontWeight: '700', lineHeight: 26 },
  dateText: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  summary: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '600', marginTop: 10, textAlign: 'center' },
  scroll: { padding: 16, paddingBottom: 40 },
  sectionTitle: { fontSize: 12, fontWeight: '800', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginTop: 6 },
  card: { backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
  rowBorder: { borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  rowBody: { flex: 1, minWidth: 0 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarOn: { backgroundColor: '#D1FAE5', borderWidth: 2, borderColor: '#34D399' },
  avatarOff: { backgroundColor: '#E2E8F0' },
  avatarNone: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#CBD5E1', borderStyle: 'dashed' },
  avatarText: { fontSize: 14, fontWeight: '800' },
  name: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  you: { fontSize: 13, fontWeight: '600', color: '#94A3B8' },
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 3 },
  line: { fontSize: 13, color: '#64748B', lineHeight: 18, flexShrink: 1 },
  lineOn: { color: '#065F46', fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  dotOn: { backgroundColor: '#22C55E' },
  dotOff: { backgroundColor: '#CBD5E1' },
  warn: { fontSize: 12, color: '#B45309', marginTop: 3, fontWeight: '600' },
  meta: { fontSize: 12, color: '#94A3B8', marginTop: 3 },
  chev: { fontSize: 22, color: '#CBD5E1', fontWeight: '600' },
  hoursCol: { alignItems: 'flex-end', maxWidth: 96 },
  hours: { fontSize: 14, fontWeight: '800', color: '#334155', fontVariant: ['tabular-nums'], textAlign: 'right' },
  hoursOn: { color: '#047857' },
  hoursSub: { fontSize: 11, color: '#64748B', marginTop: 1 },
  startChip: { borderWidth: 1, borderColor: GOLD, borderRadius: 16, paddingVertical: 6, paddingHorizontal: 10 },
  startChipText: { color: '#92750F', fontSize: 12, fontWeight: '800' },
  empty: { fontSize: 14, color: '#64748B', textAlign: 'center', marginTop: 24, marginBottom: 16 },
  flash: {
    position: 'absolute', left: 16, right: 16, bottom: 16, backgroundColor: '#0F172A', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  flashText: { color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'center', lineHeight: 19 },
  offline: { backgroundColor: '#FEF3C7', borderColor: '#FCD34D', borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 12 },
  offlineText: { color: '#92400E', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  errorBox: { backgroundColor: '#FEF2F2', borderColor: '#FECACA', borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 12 },
  errorText: { color: '#B91C1C', fontSize: 12, fontWeight: '600' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '88%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  sheetName: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  close: { fontSize: 28, color: '#94A3B8', paddingHorizontal: 4 },
  entryCard: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 12, marginBottom: 10 },
  entryTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  entryLabel: { fontSize: 13, fontWeight: '800', color: '#334155' },
  entryTimes: { fontSize: 15, fontWeight: '700', color: '#0F172A', marginTop: 4 },
  entryMeta: { fontSize: 12, color: '#64748B', marginTop: 3 },
  entryBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  smallBtn: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  smallBtnText: { color: '#334155', fontSize: 13, fontWeight: '700' },
  smallBtnGold: { backgroundColor: GOLD, borderColor: GOLD },
  smallBtnGoldText: { color: '#1E293B', fontSize: 13, fontWeight: '800' },
  bigBtn: { backgroundColor: GOLD, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 6, marginBottom: 6 },
  bigBtnText: { color: '#1E293B', fontSize: 16, fontWeight: '800' },
})
