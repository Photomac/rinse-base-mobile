// The time picker behind "Team today"'s fixes: End their day, Start their
// day, Fix clock-in, Fix clock-out (screens/TeamTodayScreen). The owner types
// a time ("8:21") with an AM/PM switch, or takes a chip (Now, the suggested
// end), and sees at once whether it can be saved and how long that makes the
// day. The rules are lib/endDay's; the screen does the saving.
//
// No native date picker: one would be a native dependency, and this ships as
// an over-the-air update.
import React, { useMemo, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor } from '../lib/i18n'
import { GOLD, SLATE } from '../lib/theme'
import { fmtDate, fmtTime, dayKey, wallTimeInTz, clockInTz } from '../lib/timezone'
import { parseClock, clockText, type Meridiem } from '../lib/teamDay'
import type { TimeProblem } from '../lib/endDay'

export type TimeChip = { label: string; ms: number }

export function TeamTimeForm({
  title, subtitle, initialMs, days, chips, why, whyWarn, check, result, saving, error, onCancel, onSave,
}: {
  title: string
  subtitle?: string | null
  /** what the field opens on */
  initialMs: number
  /** the calendar days the time may fall on ('YYYY-MM-DD'); more than one shows a switch */
  days: string[]
  chips: TimeChip[]
  /** a line under the chips (why the suggested time) */
  why?: string | null
  whyWarn?: boolean
  /** why the picked time can't be saved, worded; null when it can */
  check: (ms: number) => string | null
  /** what saving it would make ("That makes a 6 hr 8 min day."), or null */
  result: (ms: number) => string | null
  saving: boolean
  /** a refusal from the save itself */
  error?: string | null
  onCancel: () => void
  onSave: (ms: number) => void
}) {
  const { t, lang } = useLang()
  const locale = localeFor(lang)
  const fromMs = (ms: number) => {
    const { h, mi } = clockInTz(new Date(ms))
    const c = clockText(h, mi)
    const d = dayKey(new Date(ms))
    return { day: days.includes(d) ? d : days[0], text: c.text, meridiem: c.meridiem as Meridiem, exactMs: ms as number | null }
  }
  const [pick, setPick] = useState(() => fromMs(initialMs))

  // A chip keeps its exact instant (seconds and all) until the field is
  // edited; a typed time is that minute on the chosen day, company clock.
  const pickedMs = useMemo(() => {
    if (pick.exactMs != null) return pick.exactMs
    const hm = parseClock(pick.text, pick.meridiem)
    return hm ? wallTimeInTz(pick.day, hm.h, hm.mi).getTime() : NaN
  }, [pick])

  const problem = check(pickedMs)
  const outcome = problem ? null : result(pickedMs)
  const dayLabel = (d: string) => fmtDate(d, locale, { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <View>
      <Text style={styles.title}>{title}</Text>
      {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}

      {days.length > 1 && (
        <View style={styles.segment}>
          {days.map(d => (
            <TouchableOpacity key={d} style={[styles.segBtn, pick.day === d && styles.segOn]}
              onPress={() => setPick(p => ({ ...p, day: d, exactMs: null }))}>
              <Text style={[styles.segText, pick.day === d && styles.segTextOn]}>{dayLabel(d)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.timeRow}>
        <TextInput
          value={pick.text}
          onChangeText={text => setPick(p => ({ ...p, text, exactMs: null }))}
          keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
          placeholder="8:21" placeholderTextColor="#94A3B8"
          accessibilityLabel={t('team_time_hint')}
          style={styles.timeInput} maxLength={8} selectTextOnFocus
        />
        <View style={[styles.segment, styles.merSegment]}>
          {(['am', 'pm'] as Meridiem[]).map(m => (
            <TouchableOpacity key={m} style={[styles.merBtn, pick.meridiem === m && styles.segOn]}
              onPress={() => setPick(p => ({ ...p, meridiem: m, exactMs: null }))}>
              <Text style={[styles.segText, pick.meridiem === m && styles.segTextOn]}>{m.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      {days.length === 1 && !!pick.day && <Text style={styles.onDay}>{dayLabel(pick.day)}</Text>}

      {chips.length > 0 && (
        <View style={styles.chips}>
          {chips.map(c => (
            <TouchableOpacity key={c.label} style={styles.chip} onPress={() => setPick(fromMs(c.ms))}>
              <Text style={styles.chipText}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {!!why && <Text style={[styles.why, whyWarn && styles.whyWarn]}>{why}</Text>}

      <View style={styles.checkBox}>
        {problem ? <Text style={styles.problem}>{problem}</Text>
          : outcome ? <Text style={styles.outcome}>{outcome}</Text>
          : Number.isFinite(pickedMs) ? <Text style={styles.outcome}>{fmtTime(new Date(pickedMs), locale)}</Text> : null}
        {!!error && <Text style={[styles.problem, { marginTop: 4 }]}>{error}</Text>}
      </View>

      <View style={styles.actions}>
        <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={onCancel} disabled={saving}>
          <Text style={styles.btnGhostText}>{t('cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnGold, (!!problem || saving) && { opacity: 0.5 }]}
          onPress={() => onSave(pickedMs)} disabled={!!problem || saving}>
          {saving ? <ActivityIndicator color={SLATE} /> : <Text style={styles.btnGoldText}>{t('save')}</Text>}
        </TouchableOpacity>
      </View>
    </View>
  )
}

/** A TimeProblem in the crew app's words. `when` formats an instant the way
 *  the sheet does (time today, weekday + time otherwise). */
export function problemText(p: TimeProblem, t: (k: any) => string, when: (ms: number) => string, timeOf: (ms: number) => string): string {
  switch (p.code) {
    case 'no_time': return t('team_p_no_time')
    case 'before_start': return ti(t(p.kind === 'shift' ? 'team_p_before_start_day' : 'team_p_before_start_job'), { time: when(p.startMs) })
    case 'after_end': return ti(t('team_p_after_end'), { time: when(p.endMs) })
    case 'zero_length': return t('team_p_zero')
    case 'future': return ti(t('team_p_future'), { time: timeOf(p.nowMs) })
    case 'after_next': return ti(t(p.kind === 'shift' ? 'team_p_after_next_day' : 'team_p_after_next_job'), { when: when(p.nextMs) })
    case 'too_old': return t('team_p_too_old')
  }
}

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  subtitle: { fontSize: 13, color: '#64748B', marginTop: 4, lineHeight: 18 },
  segment: { flexDirection: 'row', backgroundColor: '#F1F5F9', borderRadius: 10, padding: 3, gap: 3, marginTop: 14 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  // Sized by its text: a flex: 0 button shrinks below it on web (flex-basis 0%).
  merBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center' },
  segOn: { backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segText: { fontSize: 13, fontWeight: '700', color: '#64748B' },
  segTextOn: { color: '#0F172A' },
  timeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  merSegment: { flexShrink: 0 },
  timeInput: {
    flex: 1, minWidth: 0, marginTop: 14, borderWidth: 1.5, borderColor: '#CBD5E1', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 28, fontWeight: '800', color: '#0F172A', fontVariant: ['tabular-nums'], backgroundColor: '#fff',
  },
  onDay: { fontSize: 12, color: '#64748B', marginTop: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#F8FAFC', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12 },
  chipText: { fontSize: 13, fontWeight: '700', color: '#334155' },
  why: { fontSize: 12, color: '#64748B', marginTop: 10, lineHeight: 17 },
  whyWarn: { color: '#B45309' },
  checkBox: { minHeight: 22, marginTop: 14 },
  problem: { fontSize: 13, fontWeight: '700', color: '#B91C1C', lineHeight: 18 },
  outcome: { fontSize: 13, color: '#334155', lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: '#F1F5F9' },
  btnGhostText: { color: '#475569', fontSize: 15, fontWeight: '700' },
  btnGold: { backgroundColor: GOLD },
  btnGoldText: { color: SLATE, fontSize: 15, fontWeight: '800' },
})
