// A laundry pickup's bag list on the job screen: the homes its crew are cleaning
// that day, each with its bag label and whether it's packed. The list comes from
// pickup_bag_list (web migration 20261030133005), the same one the web job panel
// reads, so the two can't disagree about the day. Catherine's ask (CKS): a pickup
// only named the office, so the runner couldn't see which bags to take.
//
// Renders nothing on any other job, with no signal (the day pack doesn't carry
// it), before the migration is applied, or when the runner has no cleans that day.
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { localeFor } from '../lib/i18n'
import { fmtTime } from '../lib/timezone'
import { useMachineTranslation } from '../lib/machineTranslate'
import { isLaundryPickup, loadPickupBags, type PickupBag } from '../lib/pickupBags'

const INK = '#1A1408'
const INK_MUTED = '#6B5E42'
const GOLD_PALE = '#FDF6E3'
const CREAM_3 = '#EDE7D8'

export function PickupBagsCard({ job }: { job: any }) {
  const { t, lang } = useLang()
  const show = isLaundryPickup(job?.job_type, job?.service_types?.name, job?.client_addresses?.nickname)
  const [rows, setRows] = useState<PickupBag[]>([])

  useEffect(() => {
    let live = true
    setRows([])
    if (!show || !job?.id) return
    loadPickupBags(job.id).then(r => { if (live) setRows(r) })
    return () => { live = false }
  }, [job?.id, show])

  const labels = useMemo(() => rows.map(r => r.bag_label), [rows])
  const tx = useMachineTranslation(lang, labels)
  if (!show || rows.length === 0) return null

  return (
    <View style={styles.card} testID="pickup-bags-card">
      <Text style={styles.title}>🧺 {t('pickup_bags_title')}</Text>
      {rows.map(r => (
        <View key={r.clean_job_id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.property}>{r.property}</Text>
            <Text style={styles.detail}>
              {fmtTime(r.scheduled_start, localeFor(lang))} · {r.bag_label ? tx(r.bag_label) : t('pickup_no_label')}
            </Text>
          </View>
          {/* A home with no linen list has nothing to say here, and "not packed" would be a false alarm. */}
          {r.pack_ready !== null && (
            <Text style={[styles.status, { color: r.pack_ready ? '#15803D' : '#B45309' }]}>
              {r.pack_ready ? `✓ ${t('pickup_packed')}` : t('pickup_not_packed')}
            </Text>
          )}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: GOLD_PALE, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: CREAM_3 },
  title: { fontSize: 13, fontWeight: '800', color: INK, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: CREAM_3 },
  property: { fontSize: 14, fontWeight: '700', color: INK },
  detail: { fontSize: 13, color: INK_MUTED, marginTop: 1 },
  status: { fontSize: 12, fontWeight: '700' },
})
