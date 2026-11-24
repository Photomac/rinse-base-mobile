// "Fix my times" (lib/timeFix): the crew member picks when their day really
// started and ended, says what happened, and sends it to the office, which
// approves or declines it on the web. Opened from Home's End my day ("End and
// fix times", on the day just ended) and from My week (any closed day of the
// last 14, or "Forgot to start my day?" on a day with none).
//
// Times are typed like Team today's fixes (components/TeamTimeForm): "8:21"
// with an AM/PM switch, on the day's own date in the company clock. The end
// can be on the next day, for a day that ran past midnight.
//
// The ask is request_time_fix (rinsebase-app 20261123220100), sent live: it
// can't be queued, because the server checks it against the day as it is.
// Its id is made when the sheet opens, so sending again after a lost answer
// finds the same ask instead of making a second one.
import React, { useMemo, useRef, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Modal, ScrollView, KeyboardAvoidingView, Alert,
} from 'react-native'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor } from '../lib/i18n'
import { GOLD, SLATE } from '../lib/theme'
import { fmtDate, fmtTime, wallTimeInTz, clockInTz, dayKey } from '../lib/timezone'
import { parseClock, clockText, addDays, type Meridiem } from '../lib/teamDay'
import { fixProblem, fixErrorKey, FIX_PROBLEM_KEYS, FIX_REASONS } from '../lib/timeFix'
import { supabase } from '../lib/supabase'
import { uuid4 } from '../lib/outbox'

export type TimeFixTarget = {
  /** the day shift to fix, or null for a day never started */
  entry: { id: string; clocked_in_at: string; clocked_out_at: string } | null
  /** the day ('YYYY-MM-DD', company clock) */
  ymd: string
  /** what the fields open on (the day's own times; for a new day, empty) */
  inMs?: number | null
  outMs?: number | null
}

type Field = { text: string; meridiem: Meridiem }

function fieldOf(ms: number | null | undefined): Field {
  if (ms == null || !Number.isFinite(ms)) return { text: '', meridiem: 'am' }
  const { h, mi } = clockInTz(new Date(ms))
  return clockText(h, mi)
}

export function TimeFixSheet({ target, onClose, onSent }: {
  target: TimeFixTarget | null
  onClose: () => void
  /** after the office has it (the screen re-reads its asks) */
  onSent?: () => void
}) {
  if (!target) return null
  return <Sheet key={`${target.entry?.id ?? 'new'}:${target.ymd}`} target={target} onClose={onClose} onSent={onSent} />
}

function Sheet({ target, onClose, onSent }: { target: TimeFixTarget; onClose: () => void; onSent?: () => void }) {
  const { t, lang } = useLang()
  const locale = localeFor(lang)
  const askId = useRef(uuid4())
  const day = target.ymd
  const nextDay = addDays(day, 1)
  const [start, setStart] = useState<Field>(() => fieldOf(target.inMs))
  // The end opens on its own day when that is this day or the next; an end
  // further on (a day left running over a weekend) opens empty.
  const [end, setEnd] = useState<Field>(() => {
    const ok = target.outMs != null && [day, nextDay].includes(dayKey(new Date(target.outMs)))
    return fieldOf(ok ? target.outMs : null)
  })
  const [endNext, setEndNext] = useState(() => target.outMs != null && dayKey(new Date(target.outMs)) === nextDay)
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const msOf = (f: Field, ymd: string) => {
    const hm = parseClock(f.text, f.meridiem)
    return hm ? wallTimeInTz(ymd, hm.h, hm.mi).getTime() : NaN
  }
  const inMs = useMemo(() => msOf(start, day), [start, day])
  const outMs = useMemo(() => msOf(end, endNext ? nextDay : day), [end, endNext, day, nextDay])
  const was = target.entry ? { inMs: Date.parse(target.entry.clocked_in_at), outMs: Date.parse(target.entry.clocked_out_at) } : null
  const problem = fixProblem({ inMs, outMs, nowMs: Date.now(), was })
  const needReason = !reason.trim()

  const dayLabel = (ymd: string) => fmtDate(ymd, locale, { weekday: 'short', month: 'short', day: 'numeric' })
  const dur = (mins: number) => {
    const m = Math.max(0, Math.round(mins))
    const h = Math.floor(m / 60), r = m % 60
    if (h && r) return ti(t('team_hm'), { h: String(h), m: String(r) })
    if (h) return ti(t('team_h'), { h: String(h) })
    return ti(t('team_m'), { m: String(r) })
  }
  const spanOf = (a: number, b: number) => {
    const out = dayKey(new Date(b)) === dayKey(new Date(a)) ? fmtTime(new Date(b), locale) : `${dayLabel(dayKey(new Date(b)))} ${fmtTime(new Date(b), locale)}`
    return ti(t('fix_recorded'), { in: fmtTime(new Date(a), locale), out })
  }

  async function send() {
    if (problem || needReason || sending) return
    setSending(true)
    setError('')
    try {
      const { data, error: err } = await supabase.rpc('request_time_fix', {
        p_id: askId.current,
        p_entry_id: target.entry?.id ?? null,
        p_in: new Date(inMs).toISOString(),
        p_out: new Date(outMs).toISOString(),
        p_reason: reason.trim(),
      })
      if (err || !(data as any)?.ok) {
        const key = fixErrorKey(err ?? 'unknown')
        setError(key ? t(key) : String(err?.message ?? err))
        return
      }
      onSent?.()
      onClose()
      Alert.alert(`✓ ${t('fix_sent_title')}`, t('fix_sent_body'))
    } catch (e: any) {
      setError(t(fixErrorKey(e) ?? 'fix_no_signal'))
    } finally {
      setSending(false)
    }
  }

  const timeRow = (label: string, f: Field, set: (f: Field) => void) => (
    <View style={{ marginTop: 14 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.timeRow}>
        <TextInput
          value={f.text}
          onChangeText={text => set({ ...f, text })}
          keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
          placeholder="8:00" placeholderTextColor="#94A3B8"
          accessibilityLabel={`${label} ${t('team_time_hint')}`}
          style={styles.timeInput} maxLength={8} selectTextOnFocus
        />
        <View style={[styles.segment, styles.merSegment]}>
          {(['am', 'pm'] as Meridiem[]).map(m => (
            <TouchableOpacity key={m} style={[styles.merBtn, f.meridiem === m && styles.segOn]} onPress={() => set({ ...f, meridiem: m })}>
              <Text style={[styles.segText, f.meridiem === m && styles.segTextOn]}>{m.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  )

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => { if (!sending) onClose() }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.wrap}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => { if (!sending) onClose() }} />
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: 36 }}>
              <Text style={styles.title}>{target.entry ? t('fix_title') : t('fix_title_forgot')}</Text>
              <Text style={styles.subtitle}>
                {dayLabel(day)}
                {' · '}
                {target.entry && was ? spanOf(was.inMs, was.outMs) : ti(t('fix_no_day'), { day: dayLabel(day) })}
              </Text>

              {timeRow(t('fix_started'), start, setStart)}
              {timeRow(t('fix_ended'), end, setEnd)}
              <View style={styles.segment}>
                {[false, true].map(n => (
                  <TouchableOpacity key={String(n)} style={[styles.segBtn, endNext === n && styles.segOn]} onPress={() => setEndNext(n)}>
                    <Text style={[styles.segText, endNext === n && styles.segTextOn]}>{n ? `${t('fix_next_day')} · ${dayLabel(nextDay)}` : dayLabel(day)}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[styles.label, { marginTop: 16 }]}>{t('fix_why')}</Text>
              <View style={styles.chips}>
                {FIX_REASONS.map(r => (
                  <TouchableOpacity key={r.value} style={[styles.chip, reason === r.value && styles.chipOn]} onPress={() => setReason(r.value)}>
                    <Text style={[styles.chipText, reason === r.value && styles.chipTextOn]}>{t(r.key)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                value={FIX_REASONS.some(r => r.value === reason) ? '' : reason}
                onChangeText={setReason}
                placeholder={FIX_REASONS.some(r => r.value === reason) ? t(FIX_REASONS.find(r => r.value === reason)!.key) : t('fix_why_ph')}
                placeholderTextColor="#94A3B8"
                style={styles.reasonInput} multiline maxLength={500}
              />

              <View style={styles.checkBox}>
                {problem ? <Text style={styles.problem}>{t(FIX_PROBLEM_KEYS[problem])}</Text>
                  : <Text style={styles.outcome}>{ti(t('fix_makes'), { dur: dur((outMs - inMs) / 60_000) })}</Text>}
                {!problem && needReason && <Text style={[styles.hint, { marginTop: 4 }]}>{t('fix_p_reason')}</Text>}
                {!!error && <Text style={[styles.problem, { marginTop: 4 }]}>{error}</Text>}
              </View>
              <Text style={styles.hint}>{t('fix_office_note')}</Text>

              <View style={styles.actions}>
                <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={onClose} disabled={sending}>
                  <Text style={styles.btnGhostText}>{t('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.btnGold, (!!problem || needReason || sending) && { opacity: 0.5 }]}
                  onPress={send} disabled={!!problem || needReason || sending}>
                  {sending ? <ActivityIndicator color={SLATE} /> : <Text style={styles.btnGoldText}>{t('fix_send')}</Text>}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '92%' },
  title: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  subtitle: { fontSize: 13, color: '#64748B', marginTop: 4, lineHeight: 18 },
  label: { fontSize: 13, fontWeight: '700', color: '#334155' },
  segment: { flexDirection: 'row', backgroundColor: '#F1F5F9', borderRadius: 10, padding: 3, gap: 3, marginTop: 8 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  merBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center' },
  segOn: { backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segText: { fontSize: 13, fontWeight: '700', color: '#64748B' },
  segTextOn: { color: '#0F172A' },
  timeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  merSegment: { flexShrink: 0 },
  timeInput: {
    flex: 1, minWidth: 0, marginTop: 6, borderWidth: 1.5, borderColor: '#CBD5E1', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8,
    fontSize: 24, fontWeight: '800', color: '#0F172A', fontVariant: ['tabular-nums'], backgroundColor: '#fff',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: { borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#F8FAFC', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12 },
  chipOn: { borderColor: GOLD, backgroundColor: '#FDF6E3' },
  chipText: { fontSize: 13, fontWeight: '700', color: '#334155' },
  chipTextOn: { color: '#8A6810' },
  reasonInput: {
    marginTop: 10, borderWidth: 1.5, borderColor: '#CBD5E1', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15, color: '#0F172A', minHeight: 64, textAlignVertical: 'top', backgroundColor: '#fff',
  },
  checkBox: { minHeight: 22, marginTop: 14 },
  problem: { fontSize: 13, fontWeight: '700', color: '#B91C1C', lineHeight: 18 },
  outcome: { fontSize: 13, color: '#334155', lineHeight: 18 },
  hint: { fontSize: 12, color: '#64748B', marginTop: 6, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: '#F1F5F9' },
  btnGhostText: { color: '#475569', fontSize: 15, fontWeight: '700' },
  btnGold: { backgroundColor: GOLD },
  btnGoldText: { color: SLATE, fontSize: 15, fontWeight: '800' },
})
