// The office's note for one clean (jobs.crew_note): the gold banner pinned on
// top of the job screen, and the "Before you start" window shown at clock-in
// when the office turned on crew_note_at_clock_in. Rules: lib/crewNote.ts.
//
// The note is shown in the crew's language (machine-translated by the caller's
// tx()), with the office's original wording underneath, as every other owner
// note in the app is.
import React from 'react'
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { GOLD } from '../lib/theme'

const CREAM = '#FDF6E3'
const INK = '#1A1408'
const INK_MUTED = '#6B5E42'
const GOLD_DK = '#8A6810'

export function CrewNoteBanner({ note, translated, atClockIn, confirmed }: {
  note: string
  translated: string
  /** The office asked for it at clock-in: thicker border, "Read before you start". */
  atClockIn: boolean
  /** This person already tapped "Got it" for this wording. */
  confirmed: boolean
}) {
  const { t } = useLang()
  return (
    <View style={[styles.banner, atClockIn && styles.bannerPinned]}>
      <Text style={styles.label}>📌 {t(atClockIn ? 'crew_note_pinned' : 'crew_note_label')}</Text>
      <Text style={styles.bannerText}>{translated}</Text>
      {translated !== note && <Text style={styles.original}>{note}</Text>}
      {atClockIn && confirmed && <Text style={styles.confirmed}>✓ {t('crew_note_confirmed')}</Text>}
    </View>
  )
}

export function CrewNoteModal({ visible, note, translated, place, onGotIt, onNotYet }: {
  visible: boolean
  note: string
  translated: string
  /** The property, so the note can't be mistaken for another clean's. */
  place?: string | null
  onGotIt: () => void
  /** Only while a start is waiting on this window; absent = it can't be skipped. */
  onNotYet?: (() => void) | null
}) {
  const { t } = useLang()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => onNotYet?.()}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.label}>📌 {t('crew_note_title')}</Text>
            {!!place && <Text style={styles.place} numberOfLines={1}>{place}</Text>}
          </View>
          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ padding: 20 }}>
            <Text style={styles.modalText}>{translated}</Text>
            {translated !== note && <Text style={[styles.original, { marginTop: 10 }]}>{note}</Text>}
          </ScrollView>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.gotIt} onPress={onGotIt} accessibilityRole="button">
              <Text style={styles.gotItText}>✓ {t('crew_note_got_it')}</Text>
            </TouchableOpacity>
            {!!onNotYet && (
              <TouchableOpacity style={styles.notYet} onPress={onNotYet} accessibilityRole="button">
                <Text style={styles.notYetText}>{t('crew_note_not_yet')}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  banner: { backgroundColor: CREAM, borderWidth: 1, borderColor: GOLD, borderRadius: 12, padding: 14, marginBottom: 12 },
  bannerPinned: { borderWidth: 2 },
  label: { fontSize: 11, fontWeight: '800', color: GOLD_DK, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 },
  bannerText: { fontSize: 15, lineHeight: 21, color: INK },
  original: { fontSize: 12, lineHeight: 17, color: INK_MUTED, fontStyle: 'italic', marginTop: 6 },
  confirmed: { fontSize: 12, fontWeight: '700', color: '#15803D', marginTop: 8 },
  overlay: { flex: 1, backgroundColor: 'rgba(26,20,8,0.6)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: GOLD, overflow: 'hidden' },
  cardHead: { backgroundColor: CREAM, borderBottomWidth: 1, borderBottomColor: '#EDE7D8', paddingHorizontal: 20, paddingVertical: 14 },
  place: { fontSize: 17, fontWeight: '800', color: INK },
  modalText: { fontSize: 18, lineHeight: 26, color: INK },
  actions: { paddingHorizontal: 20, paddingBottom: 24, gap: 8 },
  gotIt: { backgroundColor: INK, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  gotItText: { color: '#FFFFFF', fontSize: 17, fontWeight: '800' },
  notYet: { padding: 10, alignItems: 'center' },
  notYetText: { color: INK_MUTED, fontWeight: '600', fontSize: 14 },
})
