// Profile → "My week": the days this cleaner can work, at a company that lets
// its crew set them (tenants.crew_set_availability; the rule is in
// lib/crewSchedule). Off, or before the web migration, the read fails or says
// no and nothing shows. Plain reads, not cachedQuery(): a stale copy could write
// over a schedule the office just changed.
//
// Every write asks for its rows back: RLS refuses by matching zero rows, with
// no error (crew_time_off's silent no-op, 2026-07-31).
//
// Switching a day off they're already on cleans for asks first, then takes them
// off those cleans and tells the office (release_my_cleans_on_day_off).
import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { localeFor, ti } from '../lib/i18n'
import { dayKey } from '../lib/timezone'
import { GOLD, SLATE_DARK } from '../lib/theme'
import { cleansOnWeekday, planDayTap, worksDay, type DayTap, type ScheduleRow } from '../lib/crewSchedule'

const SELECT = 'id, day_of_week, is_available, every_other_week, week_anchor'
const DAYS = [0, 1, 2, 3, 4, 5, 6]

export function CrewWeekCard({ tenantId, userId }: { tenantId: string; userId: string }) {
  const { t, lang } = useLang()
  const [allowed, setAllowed] = useState(false)
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const { data: tenant, error } = await supabase.from('tenants')
      .select('crew_set_availability').eq('id', tenantId).maybeSingle()
    if (error || (tenant as any)?.crew_set_availability !== true) { setAllowed(false); return }
    const { data: mine, error: rowsError } = await supabase.from('crew_availability')
      .select(SELECT).eq('tenant_id', tenantId).eq('user_id', userId)
    if (rowsError) { setAllowed(false); return }
    setRows((mine as ScheduleRow[]) || [])
    setAllowed(true)
  }, [tenantId, userId])

  useEffect(() => { load() }, [load])

  // Upcoming cleans this person is on that fall on this weekday (company clock).
  async function cleansOn(dow: number): Promise<number> {
    const { data, error } = await supabase.from('job_assignments')
      .select('jobs!inner(scheduled_start, status)')
      .eq('user_id', userId)
      .in('jobs.status', ['pending_approval', 'scheduled'])
      .gte('jobs.scheduled_start', new Date().toISOString())
    if (error) return 0
    return cleansOnWeekday(((data as any[]) || []).map(r => dayKey(r.jobs.scheduled_start)), dow)
  }

  async function tap(dow: number) {
    if (saving) return
    const plan = planDayTap(rows, dow)
    if (plan.kind === 'last_day') { Alert.alert(t('my_week'), t('my_week_last_day')); return }
    if (!worksDay(rows, dow)) { save(dow, plan, false); return }
    // Switching a day off takes them off that day's cleans and tells the office
    // (release_my_cleans_on_day_off, web migration 20261103200000): ask first.
    const count = await cleansOn(dow).catch(() => 0)
    if (count === 0) { save(dow, plan, true); return }
    Alert.alert(t('my_week'), ti(t('my_week_off_confirm'), { count: String(count) }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('my_week_turn_off'), style: 'destructive', onPress: () => { save(dow, plan, true) } },
    ])
  }

  async function save(dow: number, plan: Exclude<DayTap, { kind: 'last_day' }>, turningOff: boolean) {
    setSaving(true)
    const { data, error } = plan.kind === 'insert'
      ? await supabase.from('crew_availability')
          .insert(plan.days.map(d => ({ tenant_id: tenantId, user_id: userId, day_of_week: d, start_time: '08:00', end_time: '17:00', is_available: true })))
          .select(SELECT)
      : await supabase.from('crew_availability').update(plan.patch).eq('id', plan.id).select(SELECT)
    if (error || !data?.length) { setSaving(false); Alert.alert(t('error'), t('my_week_save_failed')); load(); return }
    let released = 0
    if (turningOff) {
      const { data: n } = await supabase.rpc('release_my_cleans_on_day_off', { p_dow: dow })
      released = typeof n === 'number' ? n : 0
    }
    setSaving(false)
    await load()
    if (!turningOff) return
    // Still on some (offline, or a server without the function): say so.
    const left = await cleansOn(dow).catch(() => 0)
    if (left > 0) Alert.alert(t('my_week'), ti(t('my_week_still_on'), { count: String(left) }))
    else if (released > 0) Alert.alert(t('my_week'), ti(t('my_week_released'), { count: String(released) }))
  }

  if (!allowed) return null
  const dayName = (d: number) => new Date(Date.UTC(2023, 0, 1 + d, 12)).toLocaleDateString(localeFor(lang), { weekday: 'short', timeZone: 'UTC' })

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('my_week')}</Text>
      <Text style={styles.hint}>{t('my_week_hint')}</Text>
      <View style={styles.days}>
        {DAYS.map(d => {
          const on = worksDay(rows, d)
          return (
            <TouchableOpacity key={d} disabled={saving} onPress={() => tap(d)}
              accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={dayName(d)}
              style={[styles.day, on ? styles.dayOn : styles.dayOff]}>
              <Text style={[styles.dayText, on ? styles.dayTextOn : styles.dayTextOff]}>{dayName(d)}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
      {!rows.length && <Text style={styles.any}>{t('my_week_any_day')}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  title: { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 12 },
  hint: { fontSize: 12, color: '#94A3B8', marginBottom: 12, lineHeight: 17 },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  day: { minWidth: 42, minHeight: 42, paddingHorizontal: 6, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: GOLD, borderColor: GOLD },
  dayOff: { backgroundColor: '#fff', borderColor: '#E2E8F0' },
  dayText: { fontSize: 12, fontWeight: '700' },
  dayTextOn: { color: SLATE_DARK },
  dayTextOff: { color: '#94A3B8', textDecorationLine: 'line-through' },
  any: { fontSize: 12, color: '#94A3B8', marginTop: 10 },
})
