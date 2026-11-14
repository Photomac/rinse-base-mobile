// "📋 Inspections to review" on Home (CKS Perfections, 2026-11-13).
//
// The person's own inspections still waiting for their "I've reviewed this",
// at a company with inspection review reminders on (lib/inspectionsToReview,
// my_inspections_to_review()). Each row opens that clean, where the
// InspectionResultCard shows the findings and the button; the push and the
// text reminders open the same place.
//
// Renders nothing when nothing is waiting, when the company has reminders off,
// offline, or on a server without the function. Reloads when the app comes
// back to the front, when an inspection push arrives, when Home reloads
// (reloadKey), and drops a row the moment it is reviewed on the clean's screen.

import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, AppState, Alert, ActivityIndicator } from 'react-native'
import * as Notifications from 'expo-notifications'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { localeFor } from '../lib/i18n'
import { fmtDate } from '../lib/timezone'
import { SCHEDULE_JOB_SELECT } from '../lib/pushTap'
import { readToReview, onInspectionReviewed, VERDICT_KEY, type ToReview } from '../lib/inspectionsToReview'
import { CARD, BORDER, TEXT, TEXT_MUTED } from '../lib/theme'

const AMBER = '#B45309'

export function InspectionsToReviewCard({ user, onJobPress, reloadKey }: { user: any; onJobPress: (job: any) => void; reloadKey?: unknown }) {
  const { t, lang } = useLang()
  const [items, setItems] = useState<ToReview[]>([])
  const [opening, setOpening] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    const { data, error } = await supabase.rpc('my_inspections_to_review')
    // Offline, or a server without the function: keep what is shown.
    if (error) return
    setItems(readToReview(data))
  }, [user?.id])

  useEffect(() => { load() }, [load, reloadKey])

  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') load() })
    let pushed: { remove: () => void } | null = null
    try {
      pushed = Notifications.addNotificationReceivedListener(n => {
        if ((n.request.content.data as any)?.type === 'inspection_result') load()
      })
    } catch { /* web: no pushes */ }
    const off = onInspectionReviewed(id => setItems(p => p.filter(x => x.inspectionId !== id)))
    return () => { sub.remove(); pushed?.remove(); off() }
  }, [load])

  async function open(item: ToReview) {
    if (opening) return
    setOpening(item.inspectionId)
    const { data, error } = await supabase.from('jobs').select(SCHEDULE_JOB_SELECT)
      .eq('id', item.jobId).eq('tenant_id', user.tenant_id).maybeSingle()
    setOpening(null)
    if (error || !data) { Alert.alert(t('insp_todo_open_failed')); return }
    onJobPress(data)
  }

  if (!items.length) return null
  return (
    <View style={styles.card}>
      <Text style={styles.title}>📋 {t('insp_todo_title')} ({items.length})</Text>
      <Text style={styles.sub}>{t('insp_todo_sub')}</Text>
      {items.map(item => (
        <TouchableOpacity key={item.inspectionId} style={styles.row} onPress={() => open(item)} activeOpacity={0.8}>
          <View style={{ flex: 1 }}>
            <Text style={styles.prop} numberOfLines={1}>{item.property || t('insp_todo_a_clean')}</Text>
            <Text style={styles.meta}>
              {t(VERDICT_KEY[item.result])}
              {item.filedAt ? ` · ${fmtDate(item.filedAt, localeFor(lang), { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}
            </Text>
          </View>
          {opening === item.inspectionId ? <ActivityIndicator size="small" color={AMBER} /> : <Text style={styles.arrow}>→</Text>}
        </TouchableOpacity>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: CARD, borderRadius: 14, padding: 16, marginHorizontal: 16, marginTop: 12, borderWidth: 1.5, borderColor: '#F59E0B' },
  title: { fontSize: 15, fontWeight: '800', color: AMBER },
  sub: { fontSize: 13, color: TEXT_MUTED, marginTop: 4, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: BORDER, marginTop: 8, gap: 10 },
  prop: { fontSize: 14, fontWeight: '700', color: TEXT },
  meta: { fontSize: 12, color: TEXT_MUTED, marginTop: 2 },
  arrow: { fontSize: 18, color: AMBER, fontWeight: '700' },
})
