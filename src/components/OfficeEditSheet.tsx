// "Edit time & crew": the office moves a clean or changes who is on it from the
// phone (Z & K Cleaning, 2026-10-27). A sheet over the clean's screen: the day,
// a typed start time, the length, the crew and its lead, the warnings that
// apply, then one confirm that says what will change and who is told. What a
// save does, and why it is an edit form and never a drag, is lib/officeEdit.ts.
//
// No native date or time picker: one would be a native dependency, and this
// ships as an over-the-air update (the same reason as TeamTimeForm).
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Modal, ScrollView, Alert, Platform } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor, type TranslationKey } from '../lib/i18n'
import { GOLD, SLATE, ROLE_COLORS } from '../lib/theme'
import { fmtDate, fmtTime, todayKey, tomorrowKey } from '../lib/timezone'
import { parseClock, clockText, addDays, type Meridiem } from '../lib/teamDay'
import { linkAnswering } from '../lib/netFetch'
import { uuid4 } from '../lib/outbox'
import {
  canEditClean, draftFrom, planEdit, editWarnings, resolveLead, stepLength, saveEdit,
  loadEditBase, loadCrew, loadBookingWindow, loadDayOff, LENGTH_MIN, LENGTH_MAX,
  type EditBase, type EditDraft, type CrewMember, type BookingWindow, type ScheduleOff, type EditWarning,
} from '../lib/officeEdit'

/** What the clean's screen updates on itself after a save. */
export type EditedPatch = {
  scheduled_start?: string
  scheduled_end?: string
  manually_retimed_at?: string
  job_assignments?: { user_id: string }[]
  crew?: { user_id: string; is_lead: boolean; users: { full_name: string } | null }[]
}

type Phase = 'loading' | 'offline' | 'failed' | 'started' | 'ready'

export function OfficeEditSheet({ visible, job, user, onClose, onSaved }: {
  visible: boolean
  job: any
  user: any
  onClose: () => void
  onSaved: (patch: EditedPatch) => void
}) {
  const { t, lang } = useLang()
  const locale = localeFor(lang)
  const [phase, setPhase] = useState<Phase>('loading')
  const [base, setBase] = useState<EditBase | null>(null)
  const [people, setPeople] = useState<CrewMember[]>([])
  const [win, setWin] = useState<BookingWindow | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [timeText, setTimeText] = useState('')
  const [meridiem, setMeridiem] = useState<Meridiem>('am')
  const [dayOff, setDayOff] = useState<{ ymd: string; timeOffIds: string[]; scheduleOff: Map<string, ScheduleOff> } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const loads = useRef(0)

  async function load(note = '') {
    const n = ++loads.current
    setPhase('loading'); setError(note)
    if (!(await linkAnswering())) { if (n === loads.current) setPhase('offline'); return }
    const { base: b } = await loadEditBase(supabase, job.id)
    if (n !== loads.current) return
    if (!b) { setPhase('failed'); return }
    if (!canEditClean(user.role, b)) { setPhase('started'); return }
    const [list, w] = await Promise.all([loadCrew(supabase, b.tenant_id, b.crew), loadBookingWindow(supabase, b)])
    if (n !== loads.current) return
    const d = draftFrom(b)
    const c = clockText(d.start?.h ?? 9, d.start?.mi ?? 0)
    setBase(b); setPeople(list); setWin(w); setDraft(d)
    setTimeText(c.text); setMeridiem(c.meridiem)
    setPhase('ready')
  }

  useEffect(() => {
    if (!visible) { loads.current++; return }
    setSaving(false); setDayOff(null)
    load()
  }, [visible, job?.id])

  // The draft's start as typed: the field and its AM/PM switch.
  const start = useMemo(() => parseClock(timeText, meridiem), [timeText, meridiem])
  const current = draft ? { ...draft, start } : null

  // Time off and weekly days off follow the day picked.
  useEffect(() => {
    if (phase !== 'ready' || !base || !draft || !people.length) return
    let live = true
    const ymd = draft.ymd
    loadDayOff(supabase, base.tenant_id, people.map(p => p.id), ymd)
      .then(r => { if (live) setDayOff({ ymd, ...r }) })
      .catch(() => {})
    return () => { live = false }
  }, [phase, base?.id, draft?.ymd, people.length])

  const plan = base && current ? planEdit(base, current) : null
  const offNow = dayOff && draft && dayOff.ymd === draft.ymd ? dayOff : null
  const warnings: EditWarning[] = base && current && plan
    ? editWarnings(base, current, plan, { window: win, timeOffIds: offNow?.timeOffIds ?? [], scheduleOff: offNow?.scheduleOff ?? new Map(), nowMs: Date.now() })
    : []

  const nameOf = (id: string) => people.find(p => p.id === id)?.full_name || '—'
  const dayLabel = (ymd: string) => fmtDate(ymd, locale, { weekday: 'short' })
  const whenLabel = (iso: string) => `${fmtDate(iso, locale, { weekday: 'short' })} · ${fmtTime(iso, locale)}`
  const lengthLabel = (min: number) => {
    const h = Math.floor(min / 60), m = min % 60
    return h && m ? ti(t('oe_len_hm'), { h: String(h), m: String(m) }) : h ? ti(t('oe_len_h'), { h: String(h) }) : ti(t('oe_len_m'), { m: String(m) })
  }

  function setDay(ymd: string) { setDraft(d => (d ? { ...d, ymd } : d)) }
  function toggle(id: string) {
    setDraft(d => {
      if (!d) return d
      const crew = d.crew.includes(id) ? d.crew.filter(x => x !== id) : [...d.crew, id]
      return { ...d, crew, lead: resolveLead(d.lead, crew, people) }
    })
  }

  function warningText(w: EditWarning): string {
    switch (w.code) {
      case 'window_before': return ti(t('oe_w_window_before'), { date: dayLabel(w.lo) })
      case 'window_after': return ti(t('oe_w_window_after'), { date: dayLabel(w.hi) })
      case 'off_hours': return t('oe_w_off_hours')
      case 'past': return t('oe_w_past')
      case 'time_off': return ti(t('oe_w_time_off'), { names: w.ids.map(nameOf).join(', ') })
      case 'schedule_off': return ti(t('oe_w_schedule_off'), { names: w.ids.map(nameOf).join(', ') })
      case 'over_max': return ti(t('oe_w_over_max'), { max: String(w.max), n: String(w.n) })
      case 'under_min': return ti(t('oe_w_under_min'), { min: String(w.min), n: String(w.n) })
      case 'no_crew': return t('oe_w_no_crew')
    }
  }

  function crewLine(d: EditDraft): string {
    if (!d.crew.length) return t('oe_sum_nobody')
    const lead = d.crew.includes(d.lead) ? d.lead : d.crew[0]
    return [lead, ...d.crew.filter(id => id !== lead)].map(id => (id === lead ? `${nameOf(id)} (${t('lead_tag')})` : nameOf(id))).join(', ')
  }

  async function onSave() {
    if (!base || !current || !plan || plan.problem || saving) return
    if (!(await linkAnswering())) { setError(t('oe_needs_signal')); return }
    const lines: string[] = []
    if (plan.timeChanged && plan.newStart) lines.push(ti(t('oe_sum_time'), { from: whenLabel(base.scheduled_start), to: whenLabel(plan.newStart) }))
    if (plan.crewChanged) lines.push(ti(t('oe_sum_crew'), { crew: crewLine(current) }))
    if (plan.timeChanged) lines.push(plan.dayChanged ? t('oe_sum_tell_day') : t('oe_sum_tell_same_day'))
    if (plan.crewChanged && current.crew.some(id => !base.crew.includes(id))) lines.push(t('oe_sum_push_added'))
    if (warnings.length) lines.push('', t('oe_heads_up'), ...warnings.map(w => `• ${warningText(w)}`))
    const go = await new Promise<boolean>(resolve => Alert.alert(t('oe_confirm_title'), lines.join('\n'), [
      { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: warnings.length ? t('oe_save_anyway') : t('save'), onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }))
    if (!go) return

    setSaving(true); setError('')
    const out = await saveEdit(supabase, { base, draft: current, me: user.id, newBatchId: uuid4 })
    setSaving(false)
    const crewPatch = (): EditedPatch => ({
      job_assignments: current.crew.map(id => ({ user_id: id })),
      crew: current.crew.map(id => ({ user_id: id, is_lead: id === (current.crew.includes(current.lead) ? current.lead : current.crew[0]), users: { full_name: nameOf(id) } })),
    })
    const timePatch = (retimedAt: string | null): EditedPatch => (retimedAt && plan.newStart && plan.newEnd
      ? { scheduled_start: plan.newStart, scheduled_end: plan.newEnd, manually_retimed_at: retimedAt } : {})

    if (out.ok) {
      onSaved({ ...timePatch(out.retimedAt), ...(out.crewChanged ? crewPatch() : {}) })
      onClose()
      Alert.alert(t('oe_saved'), out.timeChanged && plan.newStart ? ti(t('oe_saved_when'), { when: whenLabel(plan.newStart) }) : t('oe_saved_crew'))
      return
    }
    if (out.stage === 'crew') {
      onSaved(timePatch(out.retimedAt))
      onClose()
      Alert.alert(t('error'), ti(t(out.timeChanged ? 'oe_err_crew_time_saved' : 'oe_err_crew'), { why: out.error }))
      return
    }
    if (out.stale) { load(t('oe_err_stale')); return }
    setError(out.stage === 'record'
      ? ti(t('oe_err_record'), { why: out.error ?? '' })
      : ti(t('oe_err_save'), { why: out.error ?? '' }))
  }

  const close = () => { if (!saving) onClose() }
  const placeLabel = job?.client_addresses?.nickname || job?.client_addresses?.street || ''
  const message: Partial<Record<Phase, TranslationKey>> = { offline: 'oe_needs_signal', failed: 'oe_load_failed', started: 'oe_started' }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.wrap}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={close} />
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: 36 }}>
            <View style={styles.head}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{t('oe_title')}</Text>
                {!!placeLabel && <Text style={styles.sub} numberOfLines={1}>{placeLabel}</Text>}
              </View>
              <TouchableOpacity onPress={close} accessibilityLabel={t('cancel')}><Text style={styles.close}>×</Text></TouchableOpacity>
            </View>

            {phase === 'loading' && <ActivityIndicator color={GOLD} style={{ marginVertical: 30 }} />}
            {!!message[phase] && (
              <>
                <Text style={styles.notice}>{t(message[phase]!)}</Text>
                {phase !== 'started' && (
                  <TouchableOpacity style={[styles.btn, styles.btnGhost, { marginTop: 14 }]} onPress={() => load()}>
                    <Text style={styles.btnGhostText}>{t('oe_try_again')}</Text>
                  </TouchableOpacity>
                )}
              </>
            )}

            {phase === 'ready' && base && draft && current && (
              <>
                {!!error && <Text style={[styles.problem, { marginBottom: 6 }]}>{error}</Text>}

                <Text style={styles.label}>{t('oe_day')}</Text>
                <View style={styles.dayRow}>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => setDay(addDays(draft.ymd, -1))} accessibilityLabel={t('oe_day_earlier')}>
                    <Text style={styles.stepText}>‹</Text>
                  </TouchableOpacity>
                  <Text style={styles.dayText}>{fmtDate(draft.ymd, locale, { weekday: 'long' })}</Text>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => setDay(addDays(draft.ymd, 1))} accessibilityLabel={t('oe_day_later')}>
                    <Text style={styles.stepText}>›</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.chips}>
                  {[{ k: 'today' as const, ymd: todayKey() }, { k: 'oe_tomorrow' as const, ymd: tomorrowKey() }].map(c => (
                    <TouchableOpacity key={c.k} style={[styles.chip, draft.ymd === c.ymd && styles.chipOn]} onPress={() => setDay(c.ymd)}>
                      <Text style={[styles.chipText, draft.ymd === c.ymd && styles.chipTextOn]}>{t(c.k)}</Text>
                    </TouchableOpacity>
                  ))}
                  {win && (
                    <Text style={styles.windowText}>
                      {win.hi ? ti(t('oe_window'), { out: dayLabel(win.lo), in: dayLabel(win.hi) }) : ti(t('oe_window_open'), { out: dayLabel(win.lo) })}
                    </Text>
                  )}
                </View>

                <Text style={styles.label}>{t('oe_start')}</Text>
                <View style={styles.timeRow}>
                  <TextInput
                    value={timeText} onChangeText={setTimeText}
                    keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
                    placeholder="9:30" placeholderTextColor="#94A3B8" accessibilityLabel={t('oe_time_hint')}
                    style={styles.timeInput} maxLength={8} selectTextOnFocus
                  />
                  <View style={styles.segment}>
                    {(['am', 'pm'] as Meridiem[]).map(m => (
                      <TouchableOpacity key={m} style={[styles.segBtn, meridiem === m && styles.segOn]} onPress={() => setMeridiem(m)}>
                        <Text style={[styles.segText, meridiem === m && styles.segTextOn]}>{m.toUpperCase()}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                <Text style={styles.label}>{t('oe_length')}</Text>
                <View style={styles.dayRow}>
                  <TouchableOpacity style={[styles.stepBtn, draft.minutes <= LENGTH_MIN && { opacity: 0.4 }]} disabled={draft.minutes <= LENGTH_MIN}
                    onPress={() => setDraft(d => (d ? { ...d, minutes: stepLength(d.minutes, -1) } : d))} accessibilityLabel={t('oe_shorter')}>
                    <Text style={styles.stepText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.dayText}>{lengthLabel(draft.minutes)}</Text>
                  <TouchableOpacity style={[styles.stepBtn, draft.minutes >= LENGTH_MAX && { opacity: 0.4 }]} disabled={draft.minutes >= LENGTH_MAX}
                    onPress={() => setDraft(d => (d ? { ...d, minutes: stepLength(d.minutes, 1) } : d))} accessibilityLabel={t('oe_longer')}>
                    <Text style={styles.stepText}>+</Text>
                  </TouchableOpacity>
                </View>
                {plan?.newStart && plan.newEnd && (
                  <Text style={styles.ends}>{ti(t('oe_runs'), { from: fmtTime(plan.newStart, locale), to: fmtTime(plan.newEnd, locale) })}</Text>
                )}

                <Text style={styles.label}>{t('oe_crew')}</Text>
                {people.map(p => {
                  const on = draft.crew.includes(p.id)
                  const isLead = on && draft.lead === p.id
                  const off = offNow?.timeOffIds.includes(p.id) ? t('oe_off_time_off')
                    : offNow?.scheduleOff.get(p.id) === 'off_week' ? t('oe_off_week')
                    : offNow?.scheduleOff.has(p.id) ? t('oe_off_weekday') : null
                  return (
                    <TouchableOpacity key={p.id} style={[styles.person, on && styles.personOn]} onPress={() => toggle(p.id)}
                      accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                      <View style={[styles.tick, on && styles.tickOn]}>{on && <Text style={styles.tickMark}>✓</Text>}</View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.personName} numberOfLines={1}>{p.full_name}</Text>
                        <Text style={[styles.personRole, { color: ROLE_COLORS[p.role ?? ''] ?? '#64748B' }]}>
                          {p.role ? t(`role_${p.role}` as TranslationKey) : ''}{off ? <Text style={styles.offTag}>{`  ·  ${off}`}</Text> : null}
                        </Text>
                      </View>
                      {isLead ? <Text style={styles.leadTag}>{t('oe_lead')}</Text>
                        : on && draft.crew.length > 1 ? (
                          <TouchableOpacity style={styles.makeLead} onPress={() => setDraft(d => (d ? { ...d, lead: p.id } : d))}>
                            <Text style={styles.makeLeadText}>{t('oe_make_lead')}</Text>
                          </TouchableOpacity>
                        ) : null}
                    </TouchableOpacity>
                  )
                })}

                {warnings.length > 0 && (
                  <View style={styles.warnBox}>
                    {warnings.map((w, i) => <Text key={i} style={styles.warnText}>⚠ {warningText(w)}</Text>)}
                  </View>
                )}
                {plan?.problem === 'no_time' && <Text style={[styles.problem, { marginTop: 12 }]}>{t('oe_p_time')}</Text>}

                <View style={styles.actions}>
                  <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={close} disabled={saving}>
                    <Text style={styles.btnGhostText}>{t('cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.btn, styles.btnGold, (!!plan?.problem || saving) && { opacity: 0.5 }]}
                    onPress={onSave} disabled={!!plan?.problem || saving}>
                    {saving ? <ActivityIndicator color={SLATE} />
                      : <Text style={styles.btnGoldText}>{plan?.problem === 'nothing' ? t('oe_no_changes') : t('save')}</Text>}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '92%' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  title: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  sub: { fontSize: 13, color: '#64748B', marginTop: 2 },
  close: { fontSize: 28, color: '#94A3B8', paddingHorizontal: 4 },
  notice: { fontSize: 14, color: '#334155', lineHeight: 20, marginTop: 14 },
  label: { fontSize: 12, fontWeight: '800', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { width: 46, height: 46, borderRadius: 12, borderWidth: 1.5, borderColor: '#CBD5E1', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  stepText: { fontSize: 24, fontWeight: '700', color: '#0F172A', marginTop: -2 },
  dayText: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800', color: '#0F172A' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 },
  chip: { borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#F8FAFC', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12 },
  chipOn: { backgroundColor: SLATE, borderColor: SLATE },
  chipText: { fontSize: 13, fontWeight: '700', color: '#334155' },
  chipTextOn: { color: '#fff' },
  windowText: { fontSize: 12, color: '#64748B', flexBasis: '100%', marginTop: 2 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  timeInput: {
    flex: 1, minWidth: 0, borderWidth: 1.5, borderColor: '#CBD5E1', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8,
    fontSize: 26, fontWeight: '800', color: '#0F172A', fontVariant: ['tabular-nums'], backgroundColor: '#fff',
  },
  segment: { flexDirection: 'row', backgroundColor: '#F1F5F9', borderRadius: 10, padding: 3, gap: 3, flexShrink: 0 },
  // Sized by its text: a flex: 0 button shrinks below it on web (flex-basis 0%).
  segBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center' },
  segOn: { backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segText: { fontSize: 13, fontWeight: '700', color: '#64748B' },
  segTextOn: { color: '#0F172A' },
  ends: { fontSize: 13, color: '#334155', marginTop: 8, textAlign: 'center' },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 8 },
  personOn: { borderColor: GOLD, backgroundColor: '#FFFBEB' },
  tick: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: '#CBD5E1', alignItems: 'center', justifyContent: 'center' },
  tickOn: { backgroundColor: GOLD, borderColor: GOLD },
  tickMark: { color: SLATE, fontSize: 15, fontWeight: '900', marginTop: -1 },
  personName: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  personRole: { fontSize: 12, fontWeight: '600', marginTop: 1 },
  offTag: { color: '#B45309', fontWeight: '700' },
  leadTag: { fontSize: 12, fontWeight: '800', color: SLATE, backgroundColor: GOLD, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 9, overflow: 'hidden' },
  makeLead: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingVertical: 5, paddingHorizontal: 9 },
  makeLeadText: { fontSize: 12, fontWeight: '700', color: '#334155' },
  warnBox: { backgroundColor: '#FFFBEB', borderColor: '#FCD34D', borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 14, gap: 6 },
  warnText: { fontSize: 13, color: '#92400E', fontWeight: '600', lineHeight: 18 },
  problem: { fontSize: 13, fontWeight: '700', color: '#B91C1C', lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: '#F1F5F9' },
  btnGhostText: { color: '#475569', fontSize: 15, fontWeight: '700' },
  btnGold: { backgroundColor: GOLD },
  btnGoldText: { color: SLATE, fontSize: 15, fontWeight: '800' },
})
