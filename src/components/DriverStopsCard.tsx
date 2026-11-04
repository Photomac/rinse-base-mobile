// "🚐 Your linen drops" — the linen driver's day on Home.
//
// A driver (jobs.driver_user_id, web migration 20261103214000_driver_on_clean)
// brings each clean its clean linen and takes the soiled away. The office puts
// them on the clean, or a property's default drivers do. They are NOT the
// clean's crew: they don't clock in to it, so this card opens no job. Each stop
// says when and where, who's cleaning, the door code, and the linen to bring
// (the property's Linens par plus this clean's extras, as on the Pull Sheet),
// with two buttons: Picked up and Dropped off (driver_mark_linen, which the
// office sees on the clean). A finished stop folds to one line so the next one
// is on screen; a tap opens it again. Today is open; the next six days are
// listed below.
//
// Renders nothing for anyone who drives no clean this week, so it costs crew
// who aren't drivers one small read.

import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Linking, Alert, ActivityIndicator } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor, capFirst } from '../lib/i18n'
import { tv } from '../lib/vocab'
import { translateTexts, normalizeText } from '../lib/machineTranslate'
import { cachedRead } from '../lib/dataCache'
import { driverStopsRead, driverLinenReads } from '../lib/jobReads'
import { linenFor, stopsByDay, stopFinished, primaryTick, crewFirstNames, type LinenRow, type ExtraRow } from '../lib/driverStops'
import { bagLine } from '../lib/laundryBags'
import { fmtTimeAt, fmtDate, dayKey, todayKey } from '../lib/timezone'
import { GOLD_MUTED, SLATE, BORDER, TEXT, TEXT_MUTED } from '../lib/theme'

type Ticks = { linen_dropped_at: string | null; linen_collected_at: string | null }

export function DriverStopsCard({ user, reloadKey }: { user: any; reloadKey?: unknown }) {
  const { t, lang } = useLang()
  const locale = localeFor(lang)
  const today = todayKey()
  const [stops, setStops] = useState<any[]>([])
  const [linen, setLinen] = useState<LinenRow[]>([])
  const [extras, setExtras] = useState<ExtraRow[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  // Ticks saved on this phone since the last read.
  const [ticked, setTicked] = useState<Record<string, Ticks>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({})
  // A stop's item list, folded: crews move whole bags (CKS, 2026-11-04).
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({})
  // A finished stop the driver opened again (to check it or untick a slip).
  const [openDone, setOpenDone] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await cachedRead(driverStopsRead(user, new Date()))
      const rows = (data as any[]) ?? []
      if (cancelled) return
      setStops(rows)
      setTicked({})
      if (rows.length === 0) return
      const reads = driverLinenReads(user, rows)
      const [l, x] = await Promise.all([cachedRead(reads.linen), cachedRead(reads.extras)])
      const linenRows = ((l.data as any[]) ?? []) as LinenRow[]
      // Owner-typed linen names in the driver's language; seeded ones resolve locally.
      const m = await translateTexts(lang, [...new Set(linenRows.map(r => r.item_name))]).catch(() => new Map<string, string>())
      if (cancelled) return
      setLinen(linenRows)
      setExtras(((x.data as any[]) ?? []) as ExtraRow[])
      setNames(m)
    })().catch(() => { if (!cancelled) setStops([]) })
    return () => { cancelled = true }
  }, [user.id, user.tenant_id, lang, reloadKey])

  const days = useMemo(() => stopsByDay(stops, at => dayKey(at)), [stops])

  if (stops.length === 0) return null

  const linenName = (s: string) => names.get(normalizeText(s)) ?? tv(lang, s)
  const ticksOf = (s: any): Ticks => ticked[s.id] ?? { linen_dropped_at: s.linen_dropped_at, linen_collected_at: s.linen_collected_at }

  async function mark(stop: any, step: 'dropped' | 'collected', done: boolean) {
    setBusy(`${stop.id}:${step}`)
    const { data, error } = await supabase.rpc('driver_mark_linen', { p_job_id: stop.id, p_step: step, p_done: done })
    setBusy(null)
    if (error || !data) {
      Alert.alert(t('driver_tick_failed_title'), t('driver_tick_failed'))
      return
    }
    setTicked(prev => ({ ...prev, [stop.id]: data as Ticks }))
    // A tick that finishes the stop folds it, even one opened by hand.
    setOpenDone(prev => ({ ...prev, [stop.id]: false }))
  }

  function openMaps(addr: any) {
    const q = addr?.lat ? `${addr.lat},${addr.lng}` : [addr?.street, addr?.city].filter(Boolean).join(', ')
    if (q) Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(q)}`).catch(() => {})
  }

  const dayLabel = (day: string, first: any) => day === today ? t('today')
    : capFirst(fmtDate(first.scheduled_start, locale, { weekday: 'long' }))

  const renderStop = (s: any) => {
    const addr = s.client_addresses ?? {}
    const tk = ticksOf(s)
    const finished = stopFinished({ status: s.status, ...tk })
    const when = fmtTimeAt(s.scheduled_start, addr, locale)
    const where = addr.nickname || addr.street || '—'
    // Finished: one line, so the next stop isn't pushed off the screen (CKS,
    // 2026-11-04). A tap opens it again.
    if (finished && !openDone[s.id]) {
      return (
        <TouchableOpacity key={s.id} onPress={() => setOpenDone(p => ({ ...p, [s.id]: true }))} activeOpacity={0.7}
          accessibilityRole="button" accessibilityState={{ expanded: false }} style={[styles.stop, styles.stopFolded]}>
          <Text style={styles.foldedText} numberOfLines={1}>
            <Text style={styles.foldedTick}>✓</Text>  {when}  ·  {where}
          </Text>
          <Text style={styles.foldedChevron}>▸</Text>
        </TouchableOpacity>
      )
    }
    const items = linenFor(s, linen, extras)
    const crew = crewFirstNames(s)
    // Which bags and how many first: that is what a crew carrying closed bags
    // checks; the item list folds away behind a tap.
    const bags = bagLine(addr.laundry_bag_count, addr.laundry_bag_color, n => n === 1 ? t('bags_one') : ti(t('bags_n'), { n: String(n) }))
    const primary = primaryTick(tk)
    return (
      <View key={s.id} style={[styles.stop, finished && styles.stopDone]}>
        {finished
          ? (
            <TouchableOpacity onPress={() => setOpenDone(p => ({ ...p, [s.id]: false }))} activeOpacity={0.7}
              accessibilityRole="button" accessibilityState={{ expanded: true }}>
              <Text style={styles.stopHead}>▾ ✓  {when}  ·  {where}</Text>
            </TouchableOpacity>
          )
          : <Text style={styles.stopHead}>{when}  ·  {where}</Text>}
        {!!(addr.street || addr.city) && (
          <TouchableOpacity onPress={() => openMaps(addr)} activeOpacity={0.6}>
            <Text style={styles.link}>{[addr.street, addr.city].filter(Boolean).join(', ')}  ·  {t('directions')} ›</Text>
          </TouchableOpacity>
        )}
        {!!bags && <Text style={styles.bags}>🧺 {bags}</Text>}
        {!!addr.lockbox_code?.trim() && <Text style={styles.line}>🔑 {t('lockbox')}: {addr.lockbox_code}</Text>}
        {crew.length > 0 && <Text style={styles.line}>{ti(t('driver_cleaning'), { names: crew.join(', ') })}</Text>}
        {items.length > 0 && (
          <TouchableOpacity onPress={() => setOpenItems(p => ({ ...p, [s.id]: !p[s.id] }))} activeOpacity={0.7}
            accessibilityRole="button" accessibilityState={{ expanded: !!openItems[s.id] }}>
            <Text style={styles.fold}>{openItems[s.id] ? '▾' : '▸'} {t('driver_whats_in')} ({items.length})</Text>
          </TouchableOpacity>
        )}
        {items.length > 0 && openItems[s.id] && (
          <Text style={styles.line}>{items.map(i => `${i.qty} × ${linenName(i.name)}`).join(' · ')}</Text>
        )}
        {!bags && items.length === 0 && <Text style={styles.muted}>{t('driver_no_bags')}</Text>}
        {/* Picked up first (CKS, 2026-11-04): their day starts with the bags at
            the office. Neither is highlighted until one is ticked. */}
        <View style={styles.buttons}>
          <TickButton label={t('driver_picked_up')} at={tk.linen_collected_at} addr={addr} locale={locale}
            busy={busy === `${s.id}:collected`} primary={primary === 'pickup'}
            onPress={() => mark(s, 'collected', !tk.linen_collected_at)} />
          <TickButton label={t('driver_dropped')} at={tk.linen_dropped_at} addr={addr} locale={locale}
            busy={busy === `${s.id}:dropped`} primary={false}
            onPress={() => mark(s, 'dropped', !tk.linen_dropped_at)} />
        </View>
      </View>
    )
  }

  const drops = (n: number) => n === 1 ? t('driver_n_drops_one') : ti(t('driver_n_drops'), { n: String(n) })
  const todays = days.find(d => d.day === today)
  const later = days.filter(d => d.day > today)

  return (
    <View style={styles.card}>
      <Text style={styles.title}>🚐 {t('driver_title')}</Text>
      {todays
        ? (<>
            <Text style={styles.dayHead}>{t('today')} · {drops(todays.stops.length)}</Text>
            {todays.stops.map(renderStop)}
          </>)
        : <Text style={styles.muted}>{t('driver_none_today')}</Text>}
      {later.map(d => (
        <View key={d.day}>
          <TouchableOpacity onPress={() => setOpenDays(p => ({ ...p, [d.day]: !p[d.day] }))} activeOpacity={0.7}>
            <Text style={styles.dayHead}>
              {openDays[d.day] ? '▾' : '▸'} {dayLabel(d.day, d.stops[0])} · {drops(d.stops.length)}
            </Text>
          </TouchableOpacity>
          {openDays[d.day] && d.stops.map(renderStop)}
        </View>
      ))}
    </View>
  )
}

// Tapped once: ticked, with the time. Tapped again: unticked (a slip of the thumb).
function TickButton({ label, at, addr, locale, busy, primary, onPress }: {
  label: string; at: string | null; addr: any; locale: string; busy: boolean; primary: boolean; onPress: () => void
}) {
  const done = !!at
  return (
    <TouchableOpacity onPress={onPress} disabled={busy} activeOpacity={0.8}
      accessibilityRole="checkbox" accessibilityState={{ checked: done }}
      style={[styles.btn, done ? styles.btnDone : primary ? styles.btnPrimary : styles.btnPlain]}>
      {busy
        ? <ActivityIndicator size="small" color={done || primary ? '#fff' : SLATE} />
        : <>
            <Text style={[styles.btnText, (done || primary) && styles.btnTextOn]} numberOfLines={1}>
              {done ? `✓ ${label}` : label}
            </Text>
            {done && <Text style={styles.btnTime} numberOfLines={1}>{fmtTimeAt(at, addr, locale)}</Text>}
          </>}
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#F0F9FF', borderRadius: 14, borderWidth: 1, borderColor: '#BAE6FD', padding: 14, margin: 16 },
  title: { fontSize: 16, fontWeight: '700', color: SLATE, marginBottom: 4 },
  dayHead: { fontSize: 13, fontWeight: '700', color: GOLD_MUTED, marginTop: 10, marginBottom: 2 },
  stop: { borderTopWidth: 1, borderTopColor: BORDER, paddingVertical: 10 },
  stopDone: { opacity: 0.55 },
  stopFolded: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  foldedText: { flex: 1, fontSize: 13, fontWeight: '600', color: TEXT_MUTED },
  foldedTick: { color: '#15803D', fontWeight: '700' },
  foldedChevron: { fontSize: 13, color: TEXT_MUTED, marginLeft: 8 },
  stopHead: { fontSize: 14, fontWeight: '700', color: TEXT },
  link: { fontSize: 13, color: SLATE, marginTop: 4, textDecorationLine: 'underline' },
  line: { fontSize: 13, color: TEXT, marginTop: 4 },
  bags: { fontSize: 14, fontWeight: '700', color: TEXT, marginTop: 6 },
  fold: { fontSize: 13, color: SLATE, marginTop: 4, fontWeight: '600' },
  muted: { fontSize: 12, color: TEXT_MUTED, marginTop: 4 },
  buttons: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, minHeight: 48 },
  btnPrimary: { backgroundColor: SLATE, borderColor: SLATE },
  btnDone: { backgroundColor: '#15803D', borderColor: '#15803D' },
  btnPlain: { backgroundColor: '#fff', borderColor: BORDER },
  btnText: { fontSize: 13, fontWeight: '700', color: SLATE },
  btnTextOn: { color: '#fff' },
  btnTime: { fontSize: 11, fontWeight: '600', color: '#fff', marginTop: 2, opacity: 0.9 },
})
