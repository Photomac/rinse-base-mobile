import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { GOLD } from '../lib/theme'

/**
 * "Nichole W. · 3 cleans" above one person's cleans when the office looks at
 * Everyone (see lib/crewGroups). "No crew assigned" reads like the card line it
 * stands for (CrewLine), so the two never disagree about what unstaffed looks
 * like. `cancelled` heads the struck-through cards after the sections, so they
 * don't read as the last person's.
 */
export function CrewGroupHeader({ kind, label, n }: {
  kind: 'crew' | 'me' | 'unassigned' | 'cancelled'
  label?: string
  n: number
}) {
  const { t } = useLang()
  const title = kind === 'unassigned' ? `⚠️ ${t('crew_unassigned')}`
    : kind === 'cancelled' ? `❌ ${t('job_cancelled_label')}`
    : label ?? ''
  const count = n === 1 ? t('crew_group_one') : ti(t('crew_group_n'), { n: String(n) })
  return (
    <View style={[styles.row, kind === 'unassigned' && styles.rowUnassigned]} accessibilityRole="header">
      {(kind === 'crew' || kind === 'me') && <View style={[styles.dot, kind === 'me' && styles.dotMe]} />}
      <Text
        style={[styles.title, kind === 'unassigned' && styles.titleUnassigned, kind === 'cancelled' && styles.titleCancelled]}
        numberOfLines={1}
      >
        {title}
      </Text>
      <Text style={[styles.count, kind === 'unassigned' && styles.titleUnassigned]}> · {count}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 10, marginBottom: 6, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  rowUnassigned: { backgroundColor: '#FEF3C7', borderBottomColor: '#FCD34D', borderRadius: 8, paddingHorizontal: 8, paddingTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#94A3B8', marginRight: 7 },
  dotMe: { backgroundColor: GOLD },
  title: { flexShrink: 1, fontSize: 13, fontWeight: '800', color: '#334155' },
  titleUnassigned: { color: '#B45309' },
  titleCancelled: { color: '#94A3B8' },
  count: { fontSize: 12, fontWeight: '600', color: '#94A3B8' },
})
