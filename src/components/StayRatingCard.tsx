// src/components/StayRatingCard.tsx
// Stay condition rating — the crew rates how the GUESTS left the property after a
// clean (1-5 + condition flags + optional note). Writes to jobs.stay_* (the same
// columns the web app reads/writes). Shown at clean-completion on JobDetailScreen,
// above the notes card. Bilingual via useLang. Mirrors web StayConditionCard.
// See docs/stay-condition-report-spec.md in the web repo.

import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { SLATE_DARK, GOLD, CARD, BORDER, TEXT, TEXT_MUTED, TEXT_LIGHT } from '../lib/theme'

const FLAGS = [
  { key: 'heavy_mess',  i18n: 'stay_flag_heavy_mess',  icon: '🧹' },
  { key: 'damage',      i18n: 'stay_flag_damage',      icon: '⚠️' },
  { key: 'smoking',     i18n: 'stay_flag_smoking',     icon: '🚬' },
  { key: 'pets',        i18n: 'stay_flag_pets',        icon: '🐾' },
  { key: 'extra_time',  i18n: 'stay_flag_extra_time',  icon: '⏱️' },
  { key: 'items_moved', i18n: 'stay_flag_items_moved', icon: '📦' },
] as const

export function StayRatingCard({ job, user }: { job: any; user: any }) {
  const { t } = useLang()
  const [rating, setRating] = useState(0)
  const [flags, setFlags] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Load any existing rating for this job (read-back if reopened).
  useEffect(() => {
    let active = true
    supabase.from('jobs')
      .select('stay_rating, stay_condition_flags, stay_condition_note')
      .eq('id', job.id).maybeSingle()
      .then(({ data }) => {
        if (!active || !data || !data.stay_rating) return
        setRating(data.stay_rating)
        setFlags(data.stay_condition_flags ?? [])
        setNote(data.stay_condition_note ?? '')
        setSaved(true)
      })
    return () => { active = false }
  }, [job.id])

  function toggleFlag(key: string) {
    setDirty(true)
    setFlags(f => f.includes(key) ? f.filter(k => k !== key) : [...f, key])
  }

  async function save() {
    if (!rating) return
    setSaving(true)
    await supabase.from('jobs').update({
      stay_rating: rating,
      stay_condition_flags: flags,
      stay_condition_note: note.trim() || null,
      stay_rated_at: new Date().toISOString(),
      stay_rated_by: user?.id ?? null,
    }).eq('id', job.id)
    setSaving(false); setSaved(true); setDirty(false)
  }

  const canSave = rating > 0 && !(saved && !dirty)
  const btnLabel = saving ? '…' : (saved && !dirty) ? `✓ ${t('stay_saved')}` : saved ? t('stay_update') : t('stay_save')

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('stay_rating_title')}</Text>
      <Text style={styles.sub}>{t('stay_rating_sub')}</Text>

      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map(n => (
          <TouchableOpacity key={n} onPress={() => { setRating(n); setDirty(true) }} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
            <Text style={[styles.star, { color: n <= rating ? GOLD : BORDER }]}>★</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.flags}>
        {FLAGS.map(f => {
          const on = flags.includes(f.key)
          return (
            <TouchableOpacity key={f.key} onPress={() => toggleFlag(f.key)} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.icon} {t(f.i18n as any)}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      <TextInput
        style={styles.note}
        value={note}
        onChangeText={txt => { setNote(txt); setDirty(true) }}
        placeholder={t('stay_note_placeholder')}
        placeholderTextColor={TEXT_LIGHT}
        multiline
        numberOfLines={2}
      />

      <TouchableOpacity style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]} onPress={save} disabled={!canSave || saving}>
        <Text style={styles.saveBtnText}>{btnLabel}</Text>
      </TouchableOpacity>
      {rating === 0 && <Text style={styles.hint}>{t('stay_tap_star')}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: BORDER },
  title: { fontSize: 15, fontWeight: '800', color: TEXT },
  sub: { fontSize: 12, color: TEXT_MUTED, marginTop: 2, marginBottom: 12 },
  stars: { flexDirection: 'row', marginBottom: 14 },
  star: { fontSize: 34, lineHeight: 38, marginRight: 10 },
  flags: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  chip: { borderWidth: 1, borderColor: BORDER, borderRadius: 20, paddingVertical: 6, paddingHorizontal: 12, marginRight: 8, marginBottom: 8 },
  chipOn: { borderColor: '#FDE68A', backgroundColor: '#FEF3C7' },
  chipText: { fontSize: 12, fontWeight: '600', color: TEXT_MUTED },
  chipTextOn: { color: '#92400E' },
  note: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, padding: 12, fontSize: 13, color: TEXT, minHeight: 60, textAlignVertical: 'top', marginBottom: 12, marginTop: 4 },
  saveBtn: { backgroundColor: SLATE_DARK, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  saveBtnDisabled: { backgroundColor: BORDER },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  hint: { fontSize: 11, color: TEXT_LIGHT, textAlign: 'center', marginTop: 8 },
})
