// src/components/InspectionResultCard.tsx
// Read-only inspection results for the cleaner whose clean was inspected.
// Blueprint Ch.7 rules baked in:
//   • FINDINGS, NEVER SCORES — shows one inspection's result, notes, defects
//     and photos. No pass rates, streaks, or history (§7.9: no crew-facing
//     scores before inspector calibration exists).
//   • Passes shown with recognition ("excellent work is recognized with the
//     same specificity used to discuss failures").
//   • Information, not blame: defect columns are ALLOWLISTED — description,
//     room, severity, status only. fault_attribution, root cause, costs and
//     reporter identity are management-side and never queried here.
// Rendered on JobDetailScreen for completed cleans that have a filed
// inspection; renders nothing otherwise.

import React, { useEffect, useState } from 'react'
import { View, Text, Image, ScrollView, StyleSheet } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { CARD, BORDER, TEXT, TEXT_MUTED } from '../lib/theme'

const VERDICT: Record<string, { i18n: any; bg: string; fg: string }> = {
  pass: { i18n: 'insp_pass', bg: '#D1FAE5', fg: '#065F46' },
  pass_with_corrections: { i18n: 'insp_pass_corr', bg: '#FEF3C7', fg: '#92400E' },
  fail: { i18n: 'insp_fail', bg: '#FEE2E2', fg: '#991B1B' },
}
const SEV: Record<string, { i18n: any; color: string }> = {
  critical: { i18n: 'sev_critical', color: '#991B1B' },
  major: { i18n: 'sev_major', color: '#B45309' },
  minor: { i18n: 'sev_minor', color: '#475569' },
  observation: { i18n: 'sev_observation', color: '#64748B' },
}

export function InspectionResultCard({ job }: { job: any }) {
  const { t } = useLang()
  const [insp, setInsp] = useState<any>(null)
  const [inspector, setInspector] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [defects, setDefects] = useState<any[]>([])

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data } = await supabase.from('job_inspections')
        .select('id, job_id, result, corrections_made, correction_minutes, notes, inspector_user_id, completed_at')
        .eq('parent_job_id', job.id).not('result', 'is', null).maybeSingle()
      if (!active || !data) return
      setInsp(data)
      const [insRes, phRes, dfRes] = await Promise.all([
        data.inspector_user_id
          ? supabase.from('users').select('full_name').eq('id', data.inspector_user_id).maybeSingle()
          : Promise.resolve({ data: null } as any),
        // The inspector's photos live on the inspection VISIT job, not the clean.
        supabase.from('job_photos').select('photo_url').eq('job_id', data.job_id)
          .order('created_at', { ascending: true }).limit(12),
        // Allowlisted columns only — see the header comment.
        supabase.from('job_defects').select('id, room, description, severity, status, created_at')
          .eq('job_id', job.id).order('created_at', { ascending: true }).limit(20),
      ])
      if (!active) return
      setInspector((insRes.data as any)?.full_name ?? '')
      setPhotos(((phRes.data ?? []) as any[]).map(p => p.photo_url).filter(Boolean))
      setDefects((dfRes.data ?? []) as any[])
    })()
    return () => { active = false }
  }, [job.id])

  if (!insp) return null
  const v = VERDICT[insp.result] ?? VERDICT.pass
  const framing = insp.result === 'pass' ? t('insp_results_passed_note')
    : insp.result === 'pass_with_corrections' ? t('insp_results_corr_note')
    : t('insp_results_fail_note')

  return (
    <View style={styles.card}>
      <Text style={styles.title}>🔍 {t('insp_results_title')}</Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <View style={[styles.pill, { backgroundColor: v.bg }]}>
          <Text style={{ color: v.fg, fontSize: 12, fontWeight: '800' }}>{t(v.i18n)}</Text>
        </View>
        {!!inspector && (
          <Text style={{ fontSize: 11, color: TEXT_MUTED }}>
            {t('insp_results_by')} {inspector}
            {insp.completed_at ? ` · ${new Date(insp.completed_at).toLocaleDateString()}` : ''}
          </Text>
        )}
      </View>

      <Text style={{ fontSize: 12, color: TEXT, marginTop: 8, lineHeight: 18 }}>{framing}</Text>

      {insp.corrections_made && (
        <Text style={{ fontSize: 12, color: TEXT_MUTED, marginTop: 6 }}>
          🔧 {t('insp_results_corrections')}{insp.correction_minutes ? ` · ${insp.correction_minutes} min` : ''}
        </Text>
      )}

      {!!insp.notes && (
        <View style={styles.notesBox}>
          <Text style={{ fontSize: 12, color: TEXT, lineHeight: 18 }}>{insp.notes}</Text>
        </View>
      )}

      {defects.length > 0 && (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.subTitle}>{t('insp_results_findings')}</Text>
          {defects.map(d => {
            const s = SEV[d.severity] ?? SEV.observation
            return (
              <View key={d.id} style={styles.defectRow}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: s.color, width: 84 }}>{t(s.i18n)}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, color: TEXT, lineHeight: 17 }}>
                    {d.room ? `${d.room} — ` : ''}{d.description}
                  </Text>
                </View>
              </View>
            )
          })}
        </View>
      )}

      {photos.length > 0 && (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.subTitle}>{t('insp_results_photos')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
            {photos.map((url, i) => (
              <Image key={i} source={{ uri: url }} style={styles.thumb} />
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: BORDER,
  },
  title: { fontSize: 15, fontWeight: '800', color: TEXT },
  subTitle: { fontSize: 11, fontWeight: '800', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 0.5 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  notesBox: {
    marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: '#F8FAFC',
    borderWidth: 1, borderColor: BORDER,
  },
  defectRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 8 },
  thumb: { width: 64, height: 64, borderRadius: 8, marginRight: 6, backgroundColor: '#E2E8F0' },
})
