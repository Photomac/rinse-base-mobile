// "My week": a crew member's own week, opened from Home's earnings card.
//
// CKS Perfections asked on 2026-10-08 with Homebase screenshots: each day's
// pay, hours and clock-in/out times ("$203.85 for 7 hr 33 min, 7:57 AM –
// 3:30 PM"), the week's totals, and the time on the schedule beside it, so the
// crew open this instead of asking the office. The rules live in lib/myWeek,
// the reads in lib/myWeekReads. Pay is the Payroll page's own figure for the
// same days (crew_pay_for_period); a clock still running isn't paid until it
// ends, so today shows its time so far and its pay once they clock out.
//
// Arrows step back through earlier weeks. Only the current week is kept for
// offline. Nothing here writes.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, ActivityIndicator, AppState } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor, capFirst } from '../lib/i18n'
import { pauseReasonLabel } from '../lib/pauseReason'
import { GOLD, SLATE_DARK } from '../lib/theme'
import { cachedRead } from '../lib/dataCache'
import { flushOutbox, onOutboxDrained, overlayPending } from '../lib/outbox'
import { dayKey, fmtDate, fmtDatePart, fmtTime, todayKey, wallTimeInTz } from '../lib/timezone'
import {
  addDays, daysBetween, weekDays, weekStartFor, buildWeek, overUnderMinutes,
  type DayBounds, type PaySchedule, type WeekDay,
} from '../lib/myWeek'
import { myWeekRead, myWeekScheduleRead, scheduleOf, type WeekData } from '../lib/myWeekReads'

/** Dollars, written the US way like every other amount in the app ($1,234.50). */
const usDollars = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function boundsOf(start: string): DayBounds[] {
  return weekDays(start).map(ymd => ({
    ymd,
    startMs: wallTimeInTz(ymd, 0, 0).getTime(),
    endMs: wallTimeInTz(addDays(ymd, 1), 0, 0).getTime(),
  }))
}

export function MyWeekScreen({ user, onBack }: { user: any; onBack?: () => void }) {
  const { t, lang } = useLang()
  const locale = localeFor(lang)

  // 0 = this week, -1 = last week, ...
  const [offset, setOffset] = useState(0)
  const [week, setWeek] = useState<{ start: string; bounds: DayBounds[] } | null>(null)
  const [data, setData] = useState<WeekData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [offline, setOffline] = useState(false)
  const [nothingSaved, setNothingSaved] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Bumped per load: an older load's late answer must not replace a newer week.
  const loadGen = useRef(0)
  // The load reads the strings through a ref: a new t() must not re-run it.
  const tRef = useRef(t)
  tRef.current = t

  const load = useCallback(async () => {
    const gen = ++loadGen.current
    flushOutbox().catch(() => {})
    try {
      const s = await cachedRead(myWeekScheduleRead(user.tenant_id))
      if (gen !== loadGen.current) return
      const schedule: PaySchedule | null = s.error ? null : scheduleOf(s.data)
      const today = todayKey()
      const start = addDays(weekStartFor(today, schedule), 7 * offset)
      const bounds = boundsOf(start)
      // Pay through each day up to today; a day still ahead has nothing to pay.
      const payDays = Math.min(7, Math.max(0, daysBetween(start, today) + 1))
      const r = myWeekRead(user, bounds, payDays)
      // This week is kept for offline; an earlier one is read live.
      const res: any = offset === 0
        ? await cachedRead(r)
        : await Promise.resolve(r.q()).then((x: any) => ({ data: x.data, error: x.error, fromCache: false }))
      if (gen !== loadGen.current) return
      setWeek({ start, bounds })
      if (res.error?.offline) {
        // No signal and no saved copy of this week (only this week is kept).
        setData(null)
        setOffline(true)
        setNothingSaved(true)
        setLoadError('')
      } else if (res.error) {
        setLoadError(ti(tRef.current('week_load_failed'), { error: res.error.message || String(res.error) }))
        setOffline(false)
        setNothingSaved(false)
      } else if (res.data && res.data.weekStart === start) {
        // A Start / End queued on this phone (no signal) shows as made.
        const entries = await overlayPending('job_time_entries', res.data.entries,
          v => v.user_id === user.id && typeof v.clocked_in_at === 'string')
        if (gen !== loadGen.current) return
        setData({ ...res.data, entries })
        setOffline(!!res.fromCache || !!s.fromCache)
        setNothingSaved(false)
        setLoadError(s.error ? ti(tRef.current('week_load_failed'), { error: s.error.message || String(s.error) }) : '')
      } else {
        // The saved copy is another week's (or there is none).
        setData(null)
        setOffline(true)
        setNothingSaved(true)
        setLoadError('')
      }
    } catch (err: any) {
      if (gen === loadGen.current) setLoadError(ti(tRef.current('week_load_failed'), { error: err?.message || String(err) }))
    } finally {
      if (gen === loadGen.current) { setLoading(false); setRefreshing(false) }
    }
  }, [offset, user])

  useEffect(() => { setLoading(true); setData(null); load() }, [load])
  // Back in the app, or queued punches just went out: re-read.
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => { if (st === 'active') load() })
    return () => sub.remove()
  }, [load])
  useEffect(() => onOutboxDrained(() => { load() }), [load])

  // A running clock ticks.
  useEffect(() => {
    setNowMs(Date.now())
    if (offset !== 0) return
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [offset])

  const view = useMemo(() => {
    if (!week || !data) return null
    return buildWeek({
      days: week.bounds, entries: data.entries, jobs: data.jobs, payThrough: data.payThrough,
      nowMs, todayYmd: todayKey(),
    })
  }, [week, data, nowMs])

  // ── Formatting ──
  const money = (n: number) => `${n < 0 ? '-' : ''}$${usDollars(Math.abs(n))}`
  const dur = (mins: number) => {
    const m = Math.max(0, Math.round(mins))
    const h = Math.floor(m / 60), r = m % 60
    if (h && r) return ti(t('team_hm'), { h: String(h), m: String(r) })
    if (h) return ti(t('team_h'), { h: String(h) })
    return ti(t('team_m'), { m: String(r) })
  }
  /** The totals' hours as a decimal, like a payroll sheet ("35.4 hr", "35,4 h"):
   *  hours and minutes don't fit a third of a phone's width. */
  const hoursDec = (mins: number) =>
    ti(t('team_h'), { h: (Math.round(Math.max(0, mins) / 6) / 10).toLocaleString(locale, { maximumFractionDigits: 1 }) })
  const timeOf = (ms: number) => fmtTime(new Date(ms), locale)
  /** A time on the row's own day; weekday + time when it fell on the next one
   *  (a day that ran past midnight: "8:10 AM to Thu 12:10 AM"). */
  const timeOn = (ms: number, ymd: string) => (dayKey(new Date(ms)) === ymd
    ? timeOf(ms)
    : `${capFirst(fmtDatePart(new Date(ms), 'weekday', locale))} ${timeOf(ms)}`)
  const weekTitle = (() => {
    if (!week) return offset === 0 ? t('week_this') : offset === -1 ? t('week_last') : ''
    const range = `${fmtDate(week.start, locale)} – ${fmtDate(addDays(week.start, 6), locale)}`
    if (offset === 0) return `${t('week_this')} · ${range}`
    if (offset === -1) return `${t('week_last')} · ${range}`
    return range
  })()

  /** The day's first line: its clock times, or what's missing. */
  function headLine(d: WeekDay): { text: string; tone: 'on' | 'warn' | 'dim' | 'plain' } {
    switch (d.state) {
      case 'on_clock': {
        const since = Date.parse((d.open as any).clocked_in_at)
        return { text: ti(t('week_clocked_in'), { time: timeOf(since) }), tone: 'on' }
      }
      case 'worked': {
        const span = ti(t('team_in_to_out'), { in: timeOf(d.firstInMs as number), out: d.lastOutMs != null ? timeOn(d.lastOutMs, d.ymd) : '—' })
        return { text: d.entries.length > 1 ? `${span} · ${ti(t('team_entries_n'), { n: String(d.entries.length) })}` : span, tone: 'plain' }
      }
      case 'not_started': return { text: t('week_not_started'), tone: 'dim' }
      case 'missed': return { text: t('week_missed'), tone: 'warn' }
      case 'upcoming': return d.sched ? { text: '', tone: 'dim' } : { text: t('week_off'), tone: 'dim' }
      default: return { text: t('week_off'), tone: 'dim' }
    }
  }

  /** "Scheduled 8:00 AM to 3:00 PM · 7 hr". */
  function schedLine(d: WeekDay): string {
    if (!d.sched) return ''
    const line = ti(t('week_sched_line'), { start: timeOf(d.sched.startMs), end: timeOf(d.sched.endMs) })
    return d.sched.ms > 0 ? `${line} · ${dur(d.sched.ms / 60_000)}` : line
  }

  /** "33 min more than scheduled", on a day whose time has ended. */
  function diffLine(d: WeekDay): string {
    const diff = overUnderMinutes(d)
    return diff ? ti(t(diff > 0 ? 'week_more' : 'week_less'), { dur: dur(Math.abs(diff)) }) : ''
  }

  /** The right-hand column: the day's pay, and its hours under it. */
  function dayMoney(d: WeekDay): { amount: string; hours: string; sub: string } | null {
    if (d.state === 'on_clock') {
      const paidSoFar = d.pay && d.pay.amount > 0 ? money(d.pay.amount) : '—'
      return { amount: paidSoFar, hours: dur(d.workedMs / 60_000), sub: t('team_so_far_label') }
    }
    if (d.state !== 'worked') return null
    return {
      amount: d.pay ? money(d.pay.amount) : '—',
      hours: dur(d.pay ? d.pay.minutes : d.workedMs / 60_000),
      sub: '',
    }
  }

  const totals = view?.totals
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          {onBack && (
            <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityLabel={t('back')}>
              <Text style={styles.backText}>‹ {t('back')}</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.title}>💰 {t('week_title')}</Text>
        </View>
        <View style={styles.dateRow}>
          <TouchableOpacity style={styles.dateArrow} onPress={() => setOffset(o => o - 1)} accessibilityLabel="‹">
            <Text style={styles.dateArrowText}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setOffset(0)}>
            <Text style={styles.dateText}>{weekTitle}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.dateArrow, offset === 0 && { opacity: 0.25 }]} disabled={offset === 0}
            onPress={() => setOffset(o => Math.min(0, o + 1))} accessibilityLabel="›">
            <Text style={styles.dateArrowText}>›</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{totals && totals.amount != null ? money(totals.amount) : '—'}</Text>
            <Text style={styles.statLabel}>{t('week_pay')}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{totals ? hoursDec(totals.minutes) : '—'}</Text>
            <Text style={styles.statLabel}>{totals?.running ? `${t('week_hours')} · ${t('team_so_far_label')}` : t('week_hours')}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{totals ? hoursDec(totals.scheduledMs / 60_000) : '—'}</Text>
            <Text style={styles.statLabel}>{t('week_scheduled')}</Text>
          </View>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={GOLD} />}
      >
        {loading ? (
          <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
        ) : (
          <>
            {offline && !nothingSaved && <View style={styles.offline}><Text style={styles.offlineText}>{t('week_offline')}</Text></View>}
            {nothingSaved && <View style={styles.offline}><Text style={styles.offlineText}>{t('week_offline_none')}</Text></View>}
            {!!loadError && <View style={styles.errorBox}><Text style={styles.errorText}>{loadError}</Text></View>}
            {!!data?.payError && <View style={styles.errorBox}><Text style={styles.errorText}>{ti(t('week_pay_failed'), { error: data.payError })}</Text></View>}

            {view && (
              <View style={styles.card}>
                {view.days.map((d, i) => {
                  const head = headLine(d)
                  const sched = schedLine(d)
                  const diff = diffLine(d)
                  const right = dayMoney(d)
                  return (
                    <View key={d.ymd} style={[styles.row, i > 0 && styles.rowBorder, d.isToday && styles.rowToday]}>
                      <View style={styles.dayCol}>
                        <Text style={[styles.dayName, d.isToday && styles.dayToday]}>{capFirst(fmtDatePart(d.ymd, 'weekday', locale))}</Text>
                        <Text style={[styles.dayNum, d.isToday && styles.dayToday]}>{fmtDatePart(d.ymd, 'day', locale)}</Text>
                      </View>
                      <View style={styles.rowBody}>
                        {!!head.text && (
                          <View style={styles.lineRow}>
                            {head.tone === 'on' && <View style={styles.dotOn} />}
                            <Text style={[styles.line, head.tone === 'on' && styles.lineOn, head.tone === 'warn' && styles.lineWarn, head.tone === 'dim' && styles.lineDim]}>{head.text}</Text>
                          </View>
                        )}
                        {!!sched && <Text style={[styles.meta, !head.text && styles.metaFirst]}>{sched}</Text>}
                        {!!diff && <Text style={styles.meta}>{diff}</Text>}
                        {d.notes.map(n => <Text key={n} style={styles.warn}>{pauseReasonLabel(n, t)}</Text>)}
                        {d.state === 'on_clock' && <Text style={styles.meta}>{t('week_pay_later')}</Text>}
                        {!!d.pay && d.pay.amount < 0 && <Text style={styles.meta}>{t('week_adjusted')}</Text>}
                      </View>
                      {right && (
                        <View style={styles.moneyCol}>
                          <Text style={[styles.amount, d.state === 'on_clock' && styles.amountOn]}>{right.amount}</Text>
                          <Text style={styles.hours}>{right.hours}</Text>
                          {!!right.sub && <Text style={styles.hoursSub}>{right.sub}</Text>}
                        </View>
                      )}
                    </View>
                  )
                })}
              </View>
            )}
            {view && <Text style={styles.note}>{t('week_note')}</Text>}
          </>
        )}
      </ScrollView>
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
  dateRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12 },
  dateArrow: { paddingHorizontal: 16, paddingVertical: 8 },
  dateArrowText: { color: '#fff', fontSize: 24, fontWeight: '700', lineHeight: 26 },
  dateText: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  stats: { flexDirection: 'row', marginTop: 12, gap: 8 },
  stat: { flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 6, alignItems: 'center' },
  statValue: { color: '#fff', fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'], textAlign: 'center' },
  statLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '600', marginTop: 2, textAlign: 'center' },
  scroll: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
  rowBorder: { borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  rowToday: { backgroundColor: '#FFFBEB' },
  dayCol: { width: 40, alignItems: 'center' },
  dayName: { fontSize: 12, fontWeight: '700', color: '#64748B' },
  dayNum: { fontSize: 18, fontWeight: '800', color: '#0F172A', fontVariant: ['tabular-nums'] },
  dayToday: { color: '#92750F' },
  rowBody: { flex: 1, minWidth: 0, paddingTop: 2 },
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  line: { fontSize: 14, color: '#0F172A', fontWeight: '600', lineHeight: 19, flexShrink: 1 },
  lineOn: { color: '#065F46' },
  lineWarn: { color: '#B45309' },
  lineDim: { color: '#94A3B8', fontWeight: '500' },
  dotOn: { width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: '#22C55E' },
  meta: { fontSize: 12, color: '#64748B', marginTop: 3, lineHeight: 16 },
  metaFirst: { marginTop: 0, fontSize: 13 },
  warn: { fontSize: 12, color: '#B45309', marginTop: 3, fontWeight: '600' },
  moneyCol: { alignItems: 'flex-end', maxWidth: 110, paddingTop: 1 },
  amount: { fontSize: 15, fontWeight: '800', color: '#0F172A', fontVariant: ['tabular-nums'], textAlign: 'right' },
  amountOn: { color: '#047857' },
  hours: { fontSize: 12, color: '#475569', marginTop: 2, fontVariant: ['tabular-nums'], textAlign: 'right' },
  hoursSub: { fontSize: 11, color: '#64748B', marginTop: 1 },
  note: { fontSize: 12, color: '#94A3B8', textAlign: 'center', lineHeight: 17, paddingHorizontal: 12 },
  offline: { backgroundColor: '#FEF3C7', borderColor: '#FCD34D', borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 12 },
  offlineText: { color: '#92400E', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  errorBox: { backgroundColor: '#FEF2F2', borderColor: '#FECACA', borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 12 },
  errorText: { color: '#B91C1C', fontSize: 12, fontWeight: '600' },
})
