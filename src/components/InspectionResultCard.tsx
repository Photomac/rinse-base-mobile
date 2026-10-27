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
//
// WHAT TO LOOK AT (rinse-base-app 20261027150000, CKS 2026-10-26). An
// inspector writes most corrections on the walkthrough's lines: the line
// marked wrong, a note ("Sink faucet missed."), a photo of it. Those rows live
// on the inspection VISIT, not the clean, and this card used to show none of
// them, only the general note ("Please review all pictures and notes") and
// caption-less thumbnails. Each line marked wrong or noted now shows with its
// note and its photos; photos tap open full screen. The office's words go
// through machine translation like the rest of the job screen.
//
// REVIEWED. Opening the card calls mark_inspection_seen() (the office sees
// "Opened"). When there is anything to look at (inspection_needs_review: not
// a plain pass, corrections, a note, a line, a photo, a defect), the cleaners
// of the clean get "I've reviewed this" with an optional reply;
// mark_inspection_reviewed() records it and the office is alerted. A plain
// pass never asks. The inspector, the office, or an older server: no button.

import React, { useEffect, useState } from 'react'
import { View, Text, Image, ScrollView, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { tv } from '../lib/vocab'
import { fmtDate, fmtTime } from '../lib/timezone'
import { localeFor } from '../lib/i18n'
import { useMachineTranslation } from '../lib/machineTranslate'
import { PhotoViewer, type ViewerPhoto } from './PhotoViewer'
import { CARD, BORDER, TEXT, TEXT_MUTED, TEXT_LIGHT, GOLD, SLATE } from '../lib/theme'

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

interface Line { id: string; room: string | null; task: string | null; issue_note: string | null; photos: string[] }
interface Photo { id: string; photo_url: string; caption: string | null; checklist_item_id: string | null }
interface Review { needs: boolean; mine: boolean; reviewedAt: string | null; comment: string | null }

export function InspectionResultCard({ job }: { job: any }) {
  const { t, lang } = useLang()
  const [insp, setInsp] = useState<any>(null)
  const [inspector, setInspector] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [defects, setDefects] = useState<any[]>([])
  const [review, setReview] = useState<Review | null>(null)
  const [reply, setReply] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data } = await supabase.from('job_inspections')
        .select('id, job_id, result, corrections_made, correction_minutes, notes, inspector_user_id, completed_at')
        // Newest first, one row: two filed inspections of one clean would
        // otherwise error maybeSingle() and the card would silently vanish.
        .eq('parent_job_id', job.id).not('result', 'is', null)
        .order('completed_at', { ascending: false }).limit(1).maybeSingle()
      if (!active || !data) return
      setInsp(data)
      const [insRes, phRes, lnRes, dfRes, seenRes] = await Promise.all([
        data.inspector_user_id
          ? supabase.from('users').select('full_name').eq('id', data.inspector_user_id).maybeSingle()
          : Promise.resolve({ data: null } as any),
        // The inspector's photos and walkthrough live on the inspection VISIT
        // job, not the clean.
        supabase.from('job_photos').select('id, photo_url, caption, checklist_item_id').eq('job_id', data.job_id)
          .order('created_at', { ascending: true }).limit(40),
        supabase.from('job_checklist_items').select('id, room, task, issue_note, result, photo_url, sort_order')
          .eq('job_id', data.job_id).or('result.eq.issue,issue_note.not.is.null')
          .order('sort_order', { ascending: true }).limit(60),
        // Allowlisted columns only — see the header comment.
        supabase.from('job_defects').select('id, room, description, severity, status, created_at')
          .eq('job_id', job.id).order('created_at', { ascending: true }).limit(20),
        // Stamps "opened" for this person when they're one of the cleaners;
        // anyone else gets the state back. An older server has no function:
        // no review box, the card works as before.
        supabase.rpc('mark_inspection_seen', { p_inspection_id: data.id }),
      ])
      if (!active) return
      setInspector((insRes.data as any)?.full_name ?? '')
      const ph = ((phRes.data ?? []) as Photo[]).filter(p => !!p.photo_url)
      setPhotos(ph)
      setLines(((lnRes.data ?? []) as any[])
        // A line with only a note of spaces is not a finding.
        .filter(l => l.result === 'issue' || String(l.issue_note ?? '').trim())
        .map(l => ({
          id: l.id, room: l.room, task: l.task, issue_note: String(l.issue_note ?? '').trim() || null,
          photos: Array.from(new Set([l.photo_url, ...ph.filter(p => p.checklist_item_id === l.id).map(p => p.photo_url)].filter(Boolean))) as string[],
        })))
      setDefects((dfRes.data ?? []) as any[])
      const seen = (seenRes as any)?.error ? null : (seenRes as any)?.data
      if (seen && (seen.status === 'ok' || seen.status === 'not_yours')) {
        setReview({
          needs: !!seen.needs_review, mine: seen.status === 'ok',
          reviewedAt: seen.reviewed_at ?? null, comment: seen.comment ?? null,
        })
      }
    })()
    return () => { active = false }
  }, [job.id])

  // Hooks before any early return (the rules-of-hooks gate).
  const tx = useMachineTranslation(lang, [
    insp?.notes,
    ...lines.flatMap(l => [l.issue_note, l.task, l.room]),
    ...photos.map(p => p.caption),
  ])

  if (!insp) return null
  const v = VERDICT[insp.result] ?? VERDICT.pass
  const framing = insp.result === 'pass' ? t('insp_results_passed_note')
    : insp.result === 'pass_with_corrections' ? t('insp_results_corr_note')
    : t('insp_results_fail_note')

  // One viewer list: each line's photos (captioned with the inspector's note),
  // then every other photo of the visit (captioned with its own label).
  const linePhotoUrls = new Set(lines.flatMap(l => l.photos))
  const others = photos.filter(p => !linePhotoUrls.has(p.photo_url))
  const viewer: ViewerPhoto[] = [
    ...lines.flatMap(l => l.photos.map(url => ({
      url, caption: l.issue_note ? tx(l.issue_note) : null,
      meta: [l.room ? tx(l.room) : null, l.task ? tx(l.task) : null].filter(Boolean).join(' — ') || null,
    }))),
    ...others.map(p => ({ url: p.photo_url, caption: p.caption ? tx(p.caption) : null, meta: t('insp_results_photos') })),
  ]
  let at = 0
  const indexOf = new Map<string, number>()
  for (const l of lines) for (const url of l.photos) indexOf.set(`${l.id}|${url}`, at++)
  for (const p of others) indexOf.set(`photo|${p.id}`, at++)

  async function markReviewed() {
    if (!insp || saving) return
    setSaving(true); setSaveFailed(false)
    const { data, error } = await supabase.rpc('mark_inspection_reviewed', {
      p_inspection_id: insp.id, p_comment: reply.trim() || null,
    })
    setSaving(false)
    if (error || !data || !['reviewed', 'already_reviewed'].includes((data as any).status)) {
      setSaveFailed(true)
      return
    }
    setReview(r => r && { ...r, reviewedAt: (data as any).reviewed_at ?? new Date().toISOString(), comment: (data as any).comment ?? null })
  }

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
            {insp.completed_at ? ` · ${fmtDate(insp.completed_at, localeFor(lang))}` : ''}
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
          <Text style={{ fontSize: 12, color: TEXT, lineHeight: 18 }}>{tx(insp.notes)}</Text>
        </View>
      )}

      {lines.length > 0 && (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.subTitle}>{t('insp_review_lines')}</Text>
          {lines.map(l => (
            <View key={l.id} style={styles.lineRow}>
              {!!(l.room || l.task) && (
                <Text style={{ fontSize: 11, color: TEXT_MUTED, lineHeight: 16 }}>
                  {[l.room ? tx(l.room) : null, l.task ? tx(l.task) : null].filter(Boolean).join(' — ')}
                </Text>
              )}
              {!!l.issue_note && (
                <Text style={{ fontSize: 13, color: TEXT, fontWeight: '700', lineHeight: 18, marginTop: 2 }}>{tx(l.issue_note)}</Text>
              )}
              {l.photos.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
                  {l.photos.map(url => (
                    <TouchableOpacity key={url} activeOpacity={0.8}
                      onPress={() => setViewerIndex(indexOf.get(`${l.id}|${url}`) ?? 0)}>
                      <Image source={{ uri: url }} style={styles.lineThumb} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          ))}
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
                    {d.room ? `${tv(lang, d.room)} — ` : ''}{d.description}
                  </Text>
                </View>
              </View>
            )
          })}
        </View>
      )}

      {others.length > 0 && (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.subTitle}>{lines.length > 0 ? t('insp_results_more_photos') : t('insp_results_photos')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
            {others.map(p => (
              <TouchableOpacity key={p.id} activeOpacity={0.8} style={{ width: 76, marginRight: 6 }}
                onPress={() => setViewerIndex(indexOf.get(`photo|${p.id}`) ?? 0)}>
                <Image source={{ uri: p.photo_url }} style={styles.thumb} />
                {!!p.caption && <Text numberOfLines={2} style={styles.thumbCaption}>{tx(p.caption)}</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {review?.needs && review.mine && (
        review.reviewedAt ? (
          <View style={styles.doneBox}>
            <Text style={{ fontSize: 13, color: '#065F46', fontWeight: '800' }}>
              ✓ {t('insp_review_done')} · {fmtDate(review.reviewedAt, localeFor(lang))} {fmtTime(review.reviewedAt, localeFor(lang))}
            </Text>
            {!!review.comment && (
              <Text style={{ fontSize: 12, color: '#065F46', marginTop: 4, lineHeight: 17 }}>“{review.comment}”</Text>
            )}
          </View>
        ) : (
          <View style={styles.askBox}>
            <Text style={{ fontSize: 12, color: TEXT, lineHeight: 18 }}>{t('insp_review_ask')}</Text>
            <TextInput
              value={reply} onChangeText={setReply} maxLength={500} multiline
              placeholder={t('insp_review_reply_ph')} placeholderTextColor={TEXT_LIGHT}
              style={styles.replyInput}
            />
            {saveFailed && <Text style={{ fontSize: 12, color: '#B91C1C', marginTop: 6 }}>{t('insp_review_failed')}</Text>}
            <TouchableOpacity onPress={markReviewed} disabled={saving} activeOpacity={0.85}
              style={[styles.reviewBtn, saving && { opacity: 0.6 }]}>
              {saving
                ? <ActivityIndicator color={SLATE} />
                : <Text style={{ color: SLATE, fontSize: 15, fontWeight: '800' }}>{t('insp_review_btn')}</Text>}
            </TouchableOpacity>
          </View>
        )
      )}

      {viewerIndex != null && viewer.length > 0 && (
        <PhotoViewer photos={viewer} startIndex={viewerIndex} onClose={() => setViewerIndex(null)} />
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
  lineRow: {
    marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: '#FFFBEB',
    borderWidth: 1, borderColor: '#FDE68A',
  },
  lineThumb: { width: 96, height: 96, borderRadius: 8, marginRight: 6, backgroundColor: '#E2E8F0' },
  defectRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 8 },
  thumb: { width: 76, height: 76, borderRadius: 8, backgroundColor: '#E2E8F0' },
  thumbCaption: { fontSize: 10, color: TEXT_MUTED, marginTop: 3, lineHeight: 13 },
  askBox: {
    marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: '#F8FAFC',
    borderWidth: 1, borderColor: BORDER,
  },
  replyInput: {
    marginTop: 8, minHeight: 44, maxHeight: 120, paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 10, borderWidth: 1, borderColor: BORDER, backgroundColor: CARD,
    fontSize: 14, color: TEXT, textAlignVertical: 'top',
  },
  reviewBtn: {
    marginTop: 10, minHeight: 48, borderRadius: 12, backgroundColor: GOLD,
    alignItems: 'center', justifyContent: 'center',
  },
  doneBox: {
    marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: '#D1FAE5',
    borderWidth: 1, borderColor: '#A7F3D0',
  },
})
