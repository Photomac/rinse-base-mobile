// src/components/StayRatingCard.tsx
// Stay condition rating — the crew rates how the GUESTS left the property
// (1-5 + condition flags + optional note). Writes to jobs.stay_* (the same
// columns the web app reads/writes). Shown on JobDetailScreen right after the
// time card, before the checklist, next to Report an issue; Complete asks for
// it when it's still empty, and so does saving a Finished walkthrough video
// (StayAskModal, rules in lib/stayAsk.ts).
// Bilingual via useLang. Mirrors web StayConditionCard.
// readOnly (a finished clean, for the crew): the saved rating, its flags and
// note as text; nothing at all when none was saved.
// See docs/stay-condition-report-spec.md in the web repo.
//
// The state lives in useStayRating, owned by the screen: the card and the ask
// at Complete pick and save the same rating, so a star tapped on the card is
// already picked in the ask, and a rating saved by the ask shows on the card.
//
// Under 5 stars needs photos when the company asks for them (CKS 2026-11-10,
// lib/stayPhotos): the card's Save and the ask's Save wait for them, and the
// ask has no Skip and no back button meanwhile ("so they can't save it, or
// back out of it, without taking the pictures"); the stars can still change.
// The app is the gate: nothing on the server refuses the rating (see
// lib/stayPhotos). The ask also comes right after a Finished walkthrough
// video is saved (CKS 2026-11-13, lib/stayAsk asksAfterVideo), and there it
// requires a rating: no Skip, no back button.

import React, { useEffect, useRef, useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, ActivityIndicator } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { STAY_FLAGS, askExits, type StayValue } from '../lib/stayAsk'
import { saveStayRating } from '../lib/stayRating'
import { requiredFromRead, stayPhotoCount, photosShort, needsPhotos } from '../lib/stayPhotos'
import { cachedRead } from '../lib/dataCache'
import { stayPhotosTenantRead, stayPhotosRead } from '../lib/jobReads'
import { queuedJobPhotos } from '../lib/photoQueue'
import { ti } from '../lib/i18n'
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
  /** The company's number of photos a rating under 5 stars needs (0 = off). */
  photosRequired: number
  /** The clean's Before/Damage photos, landed or on their way. */
  photoCount: number
  /** How many more the picked rating needs before it saves (0 = none). */
  photosShort: number
  /** Count the photos again (the photo screen closed). */
  refreshPhotos: () => void
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
  // The photo rule (lib/stayPhotos): the company's number, and the count.
  const [required, setRequired] = useState(0)
  const [photoCount, setPhotoCount] = useState(0)
  const [photoTick, setPhotoTick] = useState(0)
  const tenantId: string | undefined = user?.tenant_id || job?.tenant_id

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

  // The company's number (a database without the column, or no answer and
  // nothing saved, is 0: off), then, only when it asks for photos, the count.
  useEffect(() => {
    if (!enabled || !tenantId) return
    let active = true
    ;(async () => {
      const need = requiredFromRead(await cachedRead(stayPhotosTenantRead(tenantId)).catch(() => null))
      if (!active) return
      setRequired(need)
      if (!need) return
      const [server, queued] = await Promise.all([
        cachedRead(stayPhotosRead(job.id)).then(r => r.data, () => null),
        queuedJobPhotos(job.id).catch(() => []),
      ])
      if (active) setPhotoCount(stayPhotoCount(server, queued))
    })()
    return () => { active = false }
  }, [job.id, enabled, tenantId, photoTick])

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
    photosRequired: required,
    photoCount,
    photosShort: photosShort(rating, required, photoCount),
    refreshPhotos: () => setPhotoTick(n => n + 1),
  }
}

/** Under 5 stars, with the company asking for photos: "Photos k of N", what
 *  is still needed, and Take photos. Nothing otherwise. */
function StayPhotosRow({ stay, onTakePhotos }: { stay: StayRating; onTakePhotos?: () => void }) {
  const { t } = useLang()
  if (!needsPhotos(stay.value.rating, stay.photosRequired)) return null
  const need = stay.photosRequired
  const short = stay.photosShort > 0
  return (
    <View style={[styles.photosRow, short ? styles.photosRowShort : styles.photosRowOk]}>
      <Text style={[styles.photosCount, { color: short ? '#92400E' : '#065F46' }]}>
        {ti(t('stay_photos_count'), { n: String(Math.min(stay.photoCount, need)), need: String(need) })}{short ? '' : ' ✓'}
      </Text>
      {short && (
        <Text style={styles.photosNeed}>
          {need === 1 ? t('stay_photos_need_one') : ti(t('stay_photos_need_many'), { need: String(need) })}
        </Text>
      )}
      {!!onTakePhotos && (
        <TouchableOpacity style={styles.photosBtn} onPress={onTakePhotos} disabled={stay.saving}>
          <Text style={styles.photosBtnText}>📷 {t('stay_photos_take')}</Text>
        </TouchableOpacity>
      )}
    </View>
  )
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

export function StayRatingCard({ stay, readOnly = false, onError, onTakePhotos }: { stay: StayRating; readOnly?: boolean; onError?: (message: string) => void; onTakePhotos?: () => void }) {
  const { t } = useLang()
  const { rating, flags, note } = stay.value

  // Under 5 stars, short of the company's photos: not saved (lib/stayPhotos).
  const canSave = rating > 0 && !(stay.saved && !stay.dirty) && stay.photosShort === 0
  const btnLabel = stay.saving ? '…' : (stay.saved && !stay.dirty) ? `✓ ${t('stay_saved')}` : stay.saved ? t('stay_update') : t('stay_save')

  async function save() {
    if (!rating || stay.photosShort > 0) return
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
      <StayPhotosRow stay={stay} onTakePhotos={onTakePhotos} />

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
 * The ask: "How did the guests leave it?", the card's stars and flags, then
 * Save or Skip. Two moments (lib/stayAsk): at Complete ("Save and complete"),
 * and right after the crew saves a Finished walkthrough video ('video': Save,
 * with a line saying the video is saved). What the crew picked on the card
 * and didn't save is already picked here.
 *
 * The ways out (lib/stayAsk askExits; CKS 2026-11-13, "no saving it and no
 * backing out of it without the pictures"): under 5 stars, short of the
 * company's photos, there is no Save, no Skip, and Android's back button does
 * nothing; the stars can still change and Take photos opens the photo screen
 * (the sheet is back when it closes). At Complete, Skip only before a star or
 * at 5 stars, and closing (back) otherwise neither saves nor skips: it stops
 * the Complete, and the ask comes again on the next one. After a Finished
 * video a rating is REQUIRED (Todd 2026-11-13): no Skip and no back button at
 * all, only a star and Save.
 */
export function StayAskModal({ visible, stay, mode = 'complete', onSave, onSkip, onClose, onTakePhotos }: {
  visible: boolean
  stay: StayRating
  /** 'complete': at Complete. 'video': right after a Finished video was saved. */
  mode?: 'complete' | 'video'
  onSave: () => void
  onSkip: () => void
  onClose: () => void
  /** Opens the photo screen on Before; the sheet comes back when it closes. */
  onTakePhotos?: () => void
}) {
  const { t } = useLang()
  const rating = stay.value.rating
  const picked = rating > 0
  // Under 5 stars and short of the company's photos (lib/stayPhotos): no way
  // out but 5 stars or the photos.
  const exits = askExits(rating, stay.photosShort, { ratingRequired: mode === 'video' })
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => { if (exits.close && !stay.saving) onClose() }}>
      <View style={styles.askOverlay}>
        <View style={styles.askCard}>
          {mode === 'video' && <Text style={styles.askVideoSaved}>✓ {t('stay_ask_after_video')}</Text>}
          <Text style={styles.askTitle}>{t('stay_rating_title')}</Text>
          <Text style={styles.sub}>{t('stay_rating_sub')}</Text>
          <StayPicker stay={stay} />
          <StayPhotosRow stay={stay} onTakePhotos={onTakePhotos} />
          <TouchableOpacity style={[styles.askSaveBtn, (!exits.save || stay.saving) && styles.saveBtnDisabled]}
            onPress={onSave} disabled={!exits.save || stay.saving}>
            {stay.saving ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.saveBtnText}>✓ {t(mode === 'video' ? 'stay_save' : 'stay_ask_save_complete')}</Text>}
          </TouchableOpacity>
          {/* Kept in place once a star is picked: the sheet sits on the bottom
              edge, so a line going away would move the stars and flags up
              under the next tap. */}
          <Text style={[styles.hint, picked && { opacity: 0 }]}>{t('stay_tap_star')}</Text>
          {exits.skip && (
            <TouchableOpacity style={styles.askSkipBtn} onPress={onSkip} disabled={stay.saving}>
              <Text style={styles.askSkipText}>{t('stay_ask_skip')}</Text>
            </TouchableOpacity>
          )}
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
  askVideoSaved: { fontSize: 13, fontWeight: '800', color: '#065F46', marginBottom: 6 },
  askSaveBtn: { backgroundColor: '#10B981', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  askSkipBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8, backgroundColor: '#F3F4F6' },
  askSkipText: { color: TEXT_MUTED, fontSize: 14, fontWeight: '700' },
  // Under 5 stars: the photos it needs (StayPhotosRow).
  photosRow: { borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 10 },
  photosRowShort: { borderColor: '#FDE68A', backgroundColor: '#FFFBEB' },
  photosRowOk: { borderColor: '#A7F3D0', backgroundColor: '#ECFDF5' },
  photosCount: { fontSize: 13, fontWeight: '800' },
  photosNeed: { fontSize: 12, color: '#92400E', marginTop: 4, lineHeight: 17 },
  photosBtn: { marginTop: 8, borderRadius: 8, paddingVertical: 9, alignItems: 'center', backgroundColor: SLATE_DARK },
  photosBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
})
