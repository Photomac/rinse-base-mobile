// src/components/StayRatingCard.tsx
// Stay condition rating — the crew rates how the GUESTS left the property
// (1-5 + condition flags + optional note). Writes to jobs.stay_* (the same
// columns the web app reads/writes). Shown on JobDetailScreen right after the
// time card, before the checklist, next to Report an issue; Complete asks for
// it once when it's still empty (StayAskModal, rules in lib/stayAsk.ts).
// Bilingual via useLang. Mirrors web StayConditionCard.
// readOnly (a finished clean, for the crew): the saved rating, its flags and
// note as text; nothing at all when none was saved.
// See docs/stay-condition-report-spec.md in the web repo.
//
// The state lives in useStayRating, owned by the screen: the card and the ask
// at Complete pick and save the same rating, so a star tapped on the card is
// already picked in the ask, and a rating saved by the ask shows on the card.

import React, { useEffect, useRef, useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, ActivityIndicator } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { STAY_FLAGS, type StayValue } from '../lib/stayAsk'
import { saveStayRating } from '../lib/stayRating'
import { SLATE_DARK, GOLD, CARD, BORDER, TEXT, TEXT_MUTED, TEXT_LIGHT } from '../lib/theme'

export interface StayRating {
  value: StayValue
  /** A rating is on the clean: read back from the server, or saved here. */
  saved: boolean
  /** Picked or typed since the last save or read. */
  dirty: boolean
  saving: boolean
  setRating: (n: number) => void
  toggleFlag: (key: string) => void
  setNote: (text: string) => void
  /** Save what is picked (lib/stayRating: the outbox). */
  save: () => Promise<{ error: any; queued: boolean }>
}

/** The clean's stay rating. `enabled` = the card shows: nothing is read before. */
export function useStayRating(job: any, user: any, enabled: boolean): StayRating {
  const [rating, setRatingState] = useState(0)
  const [flags, setFlags] = useState<string[]>([])
  const [note, setNoteState] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  // The crew picked something before the read came back: their picks stay.
  const touched = useRef(false)

  // Any rating already on this clean (read-back if reopened).
  useEffect(() => {
    if (!enabled) return
    let active = true
    supabase.from('jobs')
      .select('stay_rating, stay_condition_flags, stay_condition_note')
      .eq('id', job.id).maybeSingle()
      .then(({ data }) => {
        if (!active || !data || !data.stay_rating) return
        setSaved(true)
        if (touched.current) { setDirty(true); return }
        setRatingState(data.stay_rating)
        setFlags(data.stay_condition_flags ?? [])
        setNoteState(data.stay_condition_note ?? '')
      }, () => {})
    return () => { active = false }
  }, [job.id, enabled])

  function edit() { touched.current = true; setDirty(true) }

  return {
    value: { rating, flags, note },
    saved, dirty, saving,
    setRating: n => { edit(); setRatingState(n) },
    toggleFlag: key => { edit(); setFlags(f => f.includes(key) ? f.filter(k => k !== key) : [...f, key]) },
    setNote: text => { edit(); setNoteState(text) },
    save: async () => {
      setSaving(true)
      const res = await saveStayRating(job.id, user?.id, { rating, flags, note })
      setSaving(false)
      if (!res.error) { setSaved(true); setDirty(false) }
      return res
    },
  }
}

/** The five stars and the flags: the card's and the ask's. */
function StayPicker({ stay }: { stay: StayRating }) {
  const { t } = useLang()
  const { rating, flags } = stay.value
  return (
    <>
      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map(n => (
          <TouchableOpacity key={n} onPress={() => stay.setRating(n)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityRole="button" accessibilityLabel={`${n} ★`} accessibilityState={{ selected: n <= rating }}>
            <Text style={[styles.star, { color: n <= rating ? GOLD : BORDER }]}>★</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.flags}>
        {STAY_FLAGS.map(f => {
          const on = flags.includes(f.key)
          return (
            <TouchableOpacity key={f.key} onPress={() => stay.toggleFlag(f.key)} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.icon} {t(f.i18n as any)}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
    </>
  )
}

export function StayRatingCard({ stay, readOnly = false, onError }: { stay: StayRating; readOnly?: boolean; onError?: (message: string) => void }) {
  const { t } = useLang()
  const { rating, flags, note } = stay.value

  const canSave = rating > 0 && !(stay.saved && !stay.dirty)
  const btnLabel = stay.saving ? '…' : (stay.saved && !stay.dirty) ? `✓ ${t('stay_saved')}` : stay.saved ? t('stay_update') : t('stay_save')

  async function save() {
    if (!rating) return
    const { error } = await stay.save()
    if (error) onError?.(error.message || String(error))
  }

  if (readOnly) {
    // Nothing can be picked here, so a rating is the one read back.
    if (!rating) return null
    const on = STAY_FLAGS.filter(f => flags.includes(f.key))
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{t('stay_rating_title')}</Text>
        <View style={[styles.stars, { marginTop: 8, marginBottom: on.length || note ? 10 : 0 }]}>
          {[1, 2, 3, 4, 5].map(n => <Text key={n} style={[styles.star, { color: n <= rating ? GOLD : BORDER }]}>★</Text>)}
        </View>
        {on.length > 0 && (
          <View style={styles.flags}>
            {on.map(f => (
              <View key={f.key} style={[styles.chip, styles.chipOn]}>
                <Text style={[styles.chipText, styles.chipTextOn]}>{f.icon} {t(f.i18n as any)}</Text>
              </View>
            ))}
          </View>
        )}
        {!!note && <Text style={{ fontSize: 13, color: TEXT }}>{note}</Text>}
      </View>
    )
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('stay_rating_title')}</Text>
      <Text style={styles.sub}>{t('stay_rating_sub')}</Text>

      <StayPicker stay={stay} />

      <TextInput
        style={styles.note}
        value={note}
        onChangeText={stay.setNote}
        placeholder={t('stay_note_placeholder')}
        placeholderTextColor={TEXT_LIGHT}
        multiline
        numberOfLines={2}
      />

      <TouchableOpacity style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]} onPress={save} disabled={!canSave || stay.saving}>
        <Text style={styles.saveBtnText}>{btnLabel}</Text>
      </TouchableOpacity>
      {rating === 0 && <Text style={styles.hint}>{t('stay_tap_star')}</Text>}
    </View>
  )
}

/**
 * The ask at Complete: "How did the guests leave it?", the card's stars and
 * flags, then "Save and complete" or Skip. What the crew picked on the card
 * and didn't save is already picked here. Closing it any other way (Android's
 * back button) neither saves nor completes.
 */
export function StayAskModal({ visible, stay, onSaveAndComplete, onSkip, onClose }: {
  visible: boolean
  stay: StayRating
  onSaveAndComplete: () => void
  onSkip: () => void
  onClose: () => void
}) {
  const { t } = useLang()
  const picked = stay.value.rating > 0
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.askOverlay}>
        <View style={styles.askCard}>
          <Text style={styles.askTitle}>{t('stay_rating_title')}</Text>
          <Text style={styles.sub}>{t('stay_rating_sub')}</Text>
          <StayPicker stay={stay} />
          <TouchableOpacity style={[styles.askSaveBtn, (!picked || stay.saving) && styles.saveBtnDisabled]}
            onPress={onSaveAndComplete} disabled={!picked || stay.saving}>
            {stay.saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveBtnText}>✓ {t('stay_ask_save_complete')}</Text>}
          </TouchableOpacity>
          {/* Kept in place once a star is picked: the sheet sits on the bottom
              edge, so a line going away would move the stars and flags up
              under the next tap. */}
          <Text style={[styles.hint, picked && { opacity: 0 }]}>{t('stay_tap_star')}</Text>
          <TouchableOpacity style={styles.askSkipBtn} onPress={onSkip} disabled={stay.saving}>
            <Text style={styles.askSkipText}>{t('stay_ask_skip')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
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
  // The ask: a bottom sheet like the screen's Pause window.
  askOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  askCard: { backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  askTitle: { fontSize: 18, fontWeight: '800', color: TEXT },
  askSaveBtn: { backgroundColor: '#10B981', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  askSkipBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8, backgroundColor: '#F3F4F6' },
  askSkipText: { color: TEXT_MUTED, fontSize: 14, fontWeight: '700' },
})
