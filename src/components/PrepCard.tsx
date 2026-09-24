// "Get ready for today" — the crew's morning prep card on the Dashboard.
//
// Every line is derived from data the office already keeps, and a line only
// renders when it applies to one of THIS crew member's remaining cleans today.
// A crew with nothing to prep sees no card at all — an empty checklist every
// morning trains people to ignore it.
//
//   🧺 Linens to bring   — tenant opt-in (tenants.crew_prep_linens). Same math
//                          as the web Linen Pull Sheet: the property's Linens
//                          par + any per-turnover extra for that job, floored
//                          at 0. Off by default: companies with a linen
//                          service or linen room don't want this on a phone.
//   ⏰ Guests arriving    — a confirmed stay (guest or owner) checks in today
//                          at a property being cleaned today.
//   🧴 Restock            — supplies still flagged low at today's properties.
//   🔑 Access             — no lockbox code AND no arrival instructions.
//
// Deliberately NOT a "read notes" line: property crew_notes are standing notes
// present on nearly every property, and 94% of cleans carry a sync-written
// internal_notes ("X checking out, next guest in 4d"). Either would show every
// single day. A line needs a real "must read" signal the office sets — which
// doesn't exist yet.
//
// Ticks are per crew member, per tenant day, stored on the phone only — they
// are a personal checklist, not a record anyone else reads.

import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { tv } from '../lib/vocab'
import { translateTexts, normalizeText } from '../lib/machineTranslate'
import { ti, localeFor } from '../lib/i18n'
import { cachedQuery } from '../lib/dataCache'
import { todayKey } from '../lib/timezone'
import { GOLD, GOLD_MUTED, SLATE, BORDER, TEXT, TEXT_MUTED } from '../lib/theme'

type Prop = { job: any; name: string }
type Section = {
  key: string; icon: string; title: string; sub?: string
  lines: { text: string; job?: any }[]
}

// A reservation's check-in time is a bare wall-clock time in the tenant's zone
// ("16:00:00"), not an instant — format it without any zone conversion.
function fmtWallTime(hhmm: string | null | undefined, locale: string): string | null {
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h)) return null
  const d = new Date(Date.UTC(2000, 0, 1, h, m || 0))
  return d.toLocaleTimeString(locale, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
}

export function PrepCard({ user, jobs, onJobPress }: { user: any; jobs: any[]; onJobPress: (job: any) => void }) {
  const { t, lang } = useLang()
  const locale = localeFor(lang)
  const today = todayKey()
  const storeKey = `prep:${user.id}:${today}`

  // Only cleans still ahead of (or under) the crew need prep. Laundry runs,
  // tasks and inspections don't take linens or supplies to a property.
  const cleans = useMemo(() => jobs.filter((j: any) =>
    (j.job_type ?? 'clean') === 'clean' && j.client_addresses?.id &&
    ['scheduled', 'en_route', 'in_progress'].includes(j.status)), [jobs])
  const props: Prop[] = useMemo(() => cleans.map((j: any) => ({
    job: j, name: j.client_addresses?.nickname || j.client_addresses?.street || '—',
  })), [cleans])
  const sig = cleans.map((j: any) => j.id).join(',')

  const [sections, setSections] = useState<Section[]>([])
  const [done, setDone] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    AsyncStorage.getItem(storeKey).then(raw => { try { setDone(raw ? JSON.parse(raw) : {}) } catch { setDone({}) } }).catch(() => {})
  }, [storeKey])

  useEffect(() => {
    if (props.length === 0) { setSections([]); return }
    let cancelled = false
    ;(async () => {
      const addrIds = [...new Set(props.map(p => p.job.client_addresses.id))]
      const jobIds = props.map(p => p.job.id)
      const nameByAddr: Record<string, string> = {}
      const jobByAddr: Record<string, any> = {}
      props.forEach(p => { nameByAddr[p.job.client_addresses.id] = p.name; jobByAddr[p.job.client_addresses.id] ||= p.job })

      // Each read is cached like the rest of the day, so the card survives a
      // dead zone. A failed read just drops its section — never the card.
      // Owner-typed names (custom linens, custom supplies) in the crew's
      // language via translate-crew-text; seeded names resolve locally through
      // vocab.ts and are never sent. Falls back to English on any failure.
      const mtx = async (names: string[]) => {
        const m = await translateTexts(lang, names)
        return (s: string) => m.get(normalizeText(s)) ?? tv(lang, s)
      }
      const [tenRes, addrRes, resvRes, restockRes] = await Promise.all([
        cachedQuery(`prep:ten:${user.tenant_id}`, supabase.from('tenants')
          .select('crew_prep_linens, default_checkin_time').eq('id', user.tenant_id).maybeSingle()),
        cachedQuery(`prep:addr:${user.id}`, supabase.from('client_addresses')
          .select('id, lockbox_code, arrival_instructions, laundry_bag_color, default_checkin_time').in('id', addrIds)),
        cachedQuery(`prep:resv:${user.id}`, supabase.from('property_reservations')
          .select('address_id, checkin_date, checkin_time').in('address_id', addrIds)
          .eq('checkin_date', today).eq('status', 'confirmed')),
        cachedQuery(`prep:restock:${user.id}`, supabase.from('job_inventory_log')
          .select('item_name, jobs!inner(address_id)').eq('needs_restock', true).in('jobs.address_id', addrIds)),
      ])
      const tenant: any = tenRes.data ?? {}
      const addrs: any[] = addrRes.data ?? []
      const addrById: Record<string, any> = {}
      addrs.forEach(a => { addrById[a.id] = a })
      const out: Section[] = []

      // 🧺 Linens
      if (tenant.crew_prep_linens) {
        const [{ data: linen }, { data: extras }] = await Promise.all([
          cachedQuery(`prep:linen:${user.id}`, supabase.from('address_inventory')
            .select('id, address_id, item_name, par_level, sort_order').in('address_id', addrIds)
            .eq('category', 'Linens').gt('par_level', 0)),
          cachedQuery(`prep:extras:${user.id}`, supabase.from('turnover_linen_extras')
            .select('job_id, inventory_id, extra_qty').in('job_id', jobIds)),
        ])
        const invById: Record<string, any> = {}
        ;(linen ?? []).forEach((l: any) => { invById[l.id] = l })
        const extraFor: Record<string, number> = {}  // `${jobId}:${inventoryId}`
        ;(extras ?? []).forEach((x: any) => { extraFor[`${x.job_id}:${x.inventory_id}`] = x.extra_qty || 0 })
        const totals: Record<string, { qty: number; order: number }> = {}
        let cleansWithLinen = 0
        for (const p of props) {
          const rows = (linen ?? []).filter((l: any) => l.address_id === p.job.client_addresses.id)
          if (rows.length) cleansWithLinen++
          for (const l of rows) {
            const qty = Math.max(0, (l.par_level || 0) + (extraFor[`${p.job.id}:${l.id}`] || 0))
            const cur = totals[l.item_name] ||= { qty: 0, order: l.sort_order ?? 9999 }
            cur.qty += qty
            cur.order = Math.min(cur.order, l.sort_order ?? 9999)
          }
        }
        // Custom linen names (owner-typed) → crew language; seeded ones resolve locally.
        const lx = await mtx(Object.keys(totals))
        const lines = Object.entries(totals).filter(([, v]) => v.qty > 0)
          .sort((a, b) => (a[1].order - b[1].order) || a[0].localeCompare(b[0]))
          .map(([name, v]) => ({ text: `${v.qty} × ${lx(name)}` }))
        const bags = [...new Set(props.map(p => p.job.client_addresses.id))]
          .filter(id => addrById[id]?.laundry_bag_color)
          .map(id => ({ text: `${nameByAddr[id]}: ${ti(t('prep_bags'), { color: addrById[id].laundry_bag_color })}`, job: jobByAddr[id] }))
        if (lines.length) out.push({
          key: 'linens', icon: '🧺', title: t('prep_linens_title'),
          sub: ti(t('prep_linens_sub'), { n: String(cleansWithLinen) }), lines: [...lines, ...bags],
        })
      }

      // ⏰ Guests arriving today — property default, then tenant default, when
      // the feed sends no time (iCal never does).
      const arrivals: Record<string, string | null> = {}
      // Re-filter to today: an offline cache hit can be yesterday's arrivals.
      ;(resvRes.data ?? []).filter((r: any) => r.checkin_date === today).forEach((r: any) => {
        const time = r.checkin_time || addrById[r.address_id]?.default_checkin_time || tenant.default_checkin_time || null
        const prev = arrivals[r.address_id]
        if (prev === undefined || (time && (!prev || time < prev))) arrivals[r.address_id] = time
      })
      const arrivalLines = Object.entries(arrivals)
        .sort((a, b) => (a[1] || '99').localeCompare(b[1] || '99'))
        .map(([id, time]) => {
          const when = fmtWallTime(time, locale)
          return { text: `${nameByAddr[id]} — ${when ? ti(t('prep_guest_arrives'), { time: when }) : t('prep_arrives_today')}`, job: jobByAddr[id] }
        })
      if (arrivalLines.length) out.push({ key: 'arrivals', icon: '⏰', title: t('prep_turnaround_title'), lines: arrivalLines })

      // 🧴 Restock
      const low: Record<string, Set<string>> = {}
      ;(restockRes.data ?? []).forEach((r: any) => {
        const id = r.jobs?.address_id
        if (id && r.item_name) (low[id] ||= new Set()).add(r.item_name)
      })
      const rx = await mtx(Object.values(low).flatMap(s => [...s]))
      const restockLines = Object.entries(low).map(([id, items]) => ({ text: `${nameByAddr[id]}: ${[...items].map(n => rx(n)).join(', ')}`, job: jobByAddr[id] }))
      if (restockLines.length) out.push({ key: 'restock', icon: '🧴', title: t('prep_restock_title'), sub: t('prep_restock_sub'), lines: restockLines })

      // 🔑 Access — only judge properties we actually loaded, so an offline
      // miss never claims "no code on file".
      const accessLines = addrIds.filter(id => addrById[id] && !addrById[id].lockbox_code?.trim() && !addrById[id].arrival_instructions?.trim())
        .map(id => ({ text: nameByAddr[id], job: jobByAddr[id] }))
      if (accessLines.length) out.push({ key: 'access', icon: '🔑', title: t('prep_access_title'), sub: t('prep_access_sub'), lines: accessLines })

      if (!cancelled) setSections(out)
    })().catch(() => { if (!cancelled) setSections([]) })
    return () => { cancelled = true }
    // sig captures the set of cleans; lang re-renders the strings.
  }, [sig, lang, user.id, user.tenant_id, today])

  if (sections.length === 0) return null

  const toggle = (key: string) => {
    const next = { ...done, [key]: !done[key] }
    setDone(next)
    AsyncStorage.setItem(storeKey, JSON.stringify(next)).catch(() => {})
  }
  const allDone = sections.every(s => done[s.key])

  if (allDone && !expanded) {
    return (
      <TouchableOpacity style={[styles.card, styles.collapsed]} onPress={() => setExpanded(true)} activeOpacity={0.8}>
        <Text style={styles.collapsedText}>✓ {t('prep_all_set')}</Text>
        <Text style={styles.show}>{t('prep_show')}</Text>
      </TouchableOpacity>
    )
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('prep_title')}</Text>
      {sections.map(s => {
        const isDone = !!done[s.key]
        return (
          <View key={s.key} style={[styles.section, isDone && styles.sectionDone]}>
            <TouchableOpacity style={styles.sectionHead} onPress={() => toggle(s.key)} activeOpacity={0.7}
              accessibilityRole="checkbox" accessibilityState={{ checked: isDone }}>
              <View style={[styles.box, isDone && styles.boxOn]}>{isDone && <Text style={styles.tick}>✓</Text>}</View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.sectionTitle, isDone && styles.strike]}>{s.icon}  {s.title}</Text>
                {!!s.sub && <Text style={styles.sub}>{s.sub}</Text>}
              </View>
            </TouchableOpacity>
            {!isDone && s.lines.map((l, i) => (
              <TouchableOpacity key={i} disabled={!l.job} onPress={() => l.job && onJobPress(l.job)} activeOpacity={0.6}>
                <Text style={[styles.line, l.job && styles.lineLink]}>{l.text}{l.job ? '  ›' : ''}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFBEB', borderRadius: 14, borderWidth: 1, borderColor: '#F3E3B3', padding: 14, margin: 16 },
  collapsed: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  collapsedText: { fontSize: 14, fontWeight: '600', color: '#15803D' },
  show: { fontSize: 13, color: GOLD_MUTED, fontWeight: '600' },
  title: { fontSize: 16, fontWeight: '700', color: SLATE, marginBottom: 8 },
  section: { borderTopWidth: 1, borderTopColor: BORDER, paddingVertical: 10 },
  sectionDone: { opacity: 0.55 },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: GOLD, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  boxOn: { backgroundColor: GOLD },
  tick: { color: '#fff', fontWeight: '800', fontSize: 13 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: TEXT },
  strike: { textDecorationLine: 'line-through' },
  sub: { fontSize: 12, color: TEXT_MUTED, marginTop: 2 },
  line: { fontSize: 13, color: TEXT, marginLeft: 32, marginTop: 6 },
  lineLink: { color: SLATE },
})
