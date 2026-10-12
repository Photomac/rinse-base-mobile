import React from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { GOLD } from '../lib/theme'
import type { JobScope } from '../lib/jobScope'

/**
 * "Mine | Everyone" on the dark header of Home and Schedule (see lib/jobScope).
 * The screens render it for the office only; crew already see just their own.
 */
export function JobScopeToggle({ scope, onChange }: { scope: JobScope; onChange: (scope: JobScope) => void }) {
  const { t } = useLang()
  const options: { key: JobScope; label: string }[] = [
    { key: 'mine', label: t('scope_mine') },
    { key: 'everyone', label: t('scope_everyone') },
  ]
  return (
    <View style={styles.group} accessibilityRole="tablist">
      {options.map(o => {
        const on = scope === o.key
        return (
          <TouchableOpacity
            key={o.key}
            style={[styles.seg, on && styles.segOn]}
            onPress={() => { if (!on) onChange(o.key) }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            activeOpacity={0.8}
          >
            <Text style={[styles.segText, on && styles.segTextOn]}>{o.label}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  group: { flexDirection: 'row', alignSelf: 'flex-start', borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', padding: 2 },
  seg: { paddingHorizontal: 16, paddingVertical: 5, borderRadius: 18 },
  segOn: { backgroundColor: GOLD },
  segText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  segTextOn: { color: '#fff', fontWeight: '700' },
})
