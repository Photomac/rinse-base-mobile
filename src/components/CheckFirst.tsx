// "Check first" on a clean: the property's short list the office sets once
// ("Water all the plants", "Spa photo", "Propane OFF"). Rules: lib/checkFirst.ts.
// Two places, both fed by JobDetailScreen, which reads and writes:
//   • CheckFirstCard, the very first thing on the job screen, before and after
//     Start. Each line says who ticked it and when; someone on the clean ticks
//     it there, or takes the photo a photo line asks for.
//   • CheckFirstModal, when they tap Start, after the office's note. The same
//     lines, tickable. "Start the clean" carries on with the start (and records
//     that they saw the list); "Not yet" backs out of it. Ticking isn't needed
//     to start, only to complete.
//
// Office text is shown in the crew's language (the caller's tx()), with the
// office's wording underneath, as every other owner note in the app is.
import React from 'react'
import { View, Text, TouchableOpacity, Modal, ScrollView, Image, ActivityIndicator, StyleSheet } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { ti } from '../lib/i18n'
import { fmtTime } from '../lib/timezone'
import { activeLines, blocksThisClean, lineState, type CheckFirstLine, type CheckFirstTick } from '../lib/checkFirst'
import { GOLD } from '../lib/theme'

const CREAM = '#FDF6E3'
const INK = '#1A1408'
const INK_MUTED = '#6B5E42'
const GOLD_DK = '#8A6810'
const GREEN = '#15803D'

/** One clean's Check first, as the job screen holds it. */
export interface CheckFirstView {
  lines: CheckFirstLine[]
  ticks: CheckFirstTick[]
  /** Line id → its photo: the saved one, or the file still on this phone. */
  photos: Record<string, string>
  /** Lines whose photo is still on this phone, waiting to upload. */
  saving: string[]
  /** tenants.check_first_required: the lines block Complete only when on. */
  required: boolean
  /** jobs.started_at (daily mode's start; per-job mode's is the first clock-in). */
  jobStartedAt: string | null
}

/** Lines still keeping the clean from completing (lines added since Start don't). */
export function checkFirstLeft(view: CheckFirstView, started: string | null): number {
  const ticked = new Set(view.ticks.map(k => k.line_id))
  const photos = new Set(Object.keys(view.photos))
  return activeLines(view.lines)
    .filter(l => blocksThisClean(l, started) && lineState(l, ticked, photos) !== 'done').length
}

interface LinesProps {
  view: CheckFirstView
  started: string | null
  /** The viewer is on this clean (or the office): tick and photo buttons show. */
  canTick: boolean
  /** The line being saved or photographed right now. */
  busy: string | null
  tx: (text: string) => string
  nameOf: (tick: CheckFirstTick) => string
  onTick: (line: CheckFirstLine) => void
  onPhoto: (line: CheckFirstLine) => void
}

function CheckFirstLines({ view, started, canTick, busy, tx, nameOf, onTick, onPhoto }: LinesProps) {
  const { t } = useLang()
  const ticked = new Set(view.ticks.map(k => k.line_id))
  const photos = new Set(Object.keys(view.photos))
  return (
    <View>
      {activeLines(view.lines).map(line => {
        const state = lineState(line, ticked, photos)
        const tick = view.ticks.find(k => k.line_id === line.id)
        const saving = view.saving.includes(line.id)
        const optional = !blocksThisClean(line, started)
        const done = state === 'done'
        const shown = tx(line.body)
        // A photo line is ticked by taking its photo; any other line by a tap.
        const tappable = canTick && !tick && !line.photo_required && busy === null
        return (
          <View key={line.id} style={styles.line}>
            <TouchableOpacity disabled={!tappable} onPress={() => onTick(line)} accessibilityRole="checkbox"
              accessibilityState={{ checked: !!tick, disabled: !tappable }} accessibilityLabel={shown}
              style={[styles.box, done && styles.boxDone, !!tick && !done && styles.boxPart]}>
              {busy === line.id
                ? <ActivityIndicator size="small" color={done ? '#fff' : GOLD_DK} />
                : !!tick && <Text style={styles.boxTick}>✓</Text>}
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.body}>{shown}</Text>
              {shown !== line.body && <Text style={styles.original}>{line.body}</Text>}
              <View style={styles.meta}>
                {line.photo_required && !done && !saving && <Text style={styles.metaText}>📷 {t('check_first_photo_needed')}</Text>}
                {tick
                  ? <Text style={[styles.metaText, styles.metaDone]}>✓ {ti(t('check_first_ticked_by'), { name: nameOf(tick), time: fmtTime(tick.ticked_at) })}</Text>
                  : <Text style={styles.metaText}>{t('check_first_not_yet')}</Text>}
                {saving && <Text style={styles.metaText}>{t('check_first_photo_saving')}</Text>}
              </View>
              {optional && <Text style={[styles.metaText, styles.optional]}>{t('check_first_added_after')}</Text>}
              {canTick && line.photo_required && state !== 'done' && (
                <TouchableOpacity disabled={busy !== null} onPress={() => onPhoto(line)} accessibilityRole="button"
                  style={[styles.photoBtn, busy !== null && { opacity: 0.5 }]}>
                  <Text style={styles.photoBtnText}>📷 {t('check_first_take_photo')}</Text>
                </TouchableOpacity>
              )}
            </View>
            {!!view.photos[line.id] && <Image source={{ uri: view.photos[line.id] }} style={styles.thumb} />}
          </View>
        )
      })}
    </View>
  )
}

/** The top of the job screen. */
export function CheckFirstCard(props: LinesProps) {
  const { t } = useLang()
  const left = checkFirstLeft(props.view, props.started)
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.label}>☑ {t('check_first_title')}</Text>
        <Text style={[styles.count, !left && { color: GREEN }]}>
          {left ? ti(t('check_first_left'), { count: String(left) }) : t('check_first_all_done')}
        </Text>
      </View>
      {/* Said only where the company's switch is on: elsewhere the lines are
          shown and ticked, but don't stop a Complete. */}
      {props.view.required && props.canTick && left > 0 && <Text style={styles.hint}>{t('check_first_hint')}</Text>}
      <CheckFirstLines {...props} />
    </View>
  )
}

/** The Start window, after the office's note. */
export function CheckFirstModal({ visible, place, onStart, onNotYet, ...props }: LinesProps & {
  visible: boolean
  /** The property, so the list can't be mistaken for another clean's. */
  place?: string | null
  onStart: () => void
  onNotYet: () => void
}) {
  const { t } = useLang()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onNotYet}>
      <View style={styles.overlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHead}>
            <Text style={styles.label}>☑ {t('check_first_title')}</Text>
            {!!place && <Text style={styles.place} numberOfLines={1}>{place}</Text>}
            {props.view.required && <Text style={[styles.hint, { marginTop: 4, marginBottom: 0 }]}>{t('check_first_hint')}</Text>}
          </View>
          <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 6 }}>
            <CheckFirstLines {...props} />
          </ScrollView>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.start} onPress={onStart} disabled={props.busy !== null} accessibilityRole="button">
              <Text style={styles.startText}>{t('check_first_start')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.notYet} onPress={onNotYet} accessibilityRole="button">
              <Text style={styles.notYetText}>{t('crew_note_not_yet')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: CREAM, borderWidth: 2, borderColor: GOLD, borderRadius: 12, padding: 14, marginBottom: 12 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 2 },
  label: { fontSize: 11, fontWeight: '800', color: GOLD_DK, letterSpacing: 0.6, textTransform: 'uppercase' },
  count: { fontSize: 12, fontWeight: '700', color: GOLD_DK },
  hint: { fontSize: 12, lineHeight: 17, color: INK_MUTED, marginBottom: 4 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 9, borderTopWidth: 1, borderTopColor: '#EDE7D8' },
  box: { width: 28, height: 28, borderRadius: 8, borderWidth: 2, borderColor: GOLD, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  boxDone: { backgroundColor: GREEN, borderColor: GREEN },
  // Ticked, photo still to come.
  boxPart: { backgroundColor: GOLD, borderColor: GOLD },
  boxTick: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: INK },
  original: { fontSize: 12, color: INK_MUTED, fontStyle: 'italic', marginTop: 2 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 2, marginTop: 3 },
  metaText: { fontSize: 12, color: INK_MUTED },
  metaDone: { color: GREEN, fontWeight: '600' },
  optional: { fontStyle: 'italic', marginTop: 2 },
  photoBtn: { alignSelf: 'flex-start', marginTop: 7, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 9, borderWidth: 1, borderColor: GOLD, backgroundColor: '#FFFFFF' },
  photoBtnText: { fontSize: 13, fontWeight: '800', color: GOLD_DK },
  thumb: { width: 40, height: 40, borderRadius: 7, backgroundColor: '#EDE7D8' },
  overlay: { flex: 1, backgroundColor: 'rgba(26,20,8,0.6)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: GOLD, overflow: 'hidden' },
  modalHead: { backgroundColor: CREAM, borderBottomWidth: 1, borderBottomColor: '#EDE7D8', paddingHorizontal: 20, paddingVertical: 14 },
  place: { fontSize: 17, fontWeight: '800', color: INK, marginTop: 4 },
  actions: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 24, gap: 8 },
  start: { backgroundColor: INK, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  startText: { color: '#FFFFFF', fontSize: 17, fontWeight: '800' },
  notYet: { padding: 10, alignItems: 'center' },
  notYetText: { color: INK_MUTED, fontWeight: '600', fontSize: 14 },
})
