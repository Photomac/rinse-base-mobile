// "Missed at the last inspection" at the top of a clean: the walkthrough
// lines an inspector marked Not right at this home that no inspection has
// marked OK since, with the inspector's words and photo. Rules:
// lib/carriedLines.ts; reads: lib/carriedLinesCard.ts (the day pack saves
// them, photos included, so it shows at a home with no signal).
//
// Findings, never scores: no counts and no names (InspectionResultCard's
// rule). Office text shows in the crew's language. Renders nothing on a job
// that isn't an open clean, on a clean booked as the inspection service (its
// walkthrough shows these instead), and before the web migration is applied.
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, Image, TouchableOpacity, Modal, StyleSheet } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor } from '../lib/i18n'
import { fmtDate } from '../lib/timezone'
import { useMachineTranslation } from '../lib/machineTranslate'
import { groupCarried, isWalkthroughVisit, showsCrewCard } from '../lib/carriedLines'
import { loadCarried, type CarriedView } from '../lib/carriedLinesCard'

const RED = '#B91C1C'
const RED_PALE = '#FEF2F2'
const RED_LINE = '#FCA5A5'
const INK = '#1A1408'
const INK_MUTED = '#6B5E42'

export function CarriedLinesCard({ job, refreshKey = 0 }: { job: any; refreshKey?: number }) {
  const { t, lang } = useLang()
  const show = showsCrewCard(job)
  const [view, setView] = useState<CarriedView>({ lines: [], files: {} })
  const [big, setBig] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    if (!show || !job?.id) return
    loadCarried(job, v => { if (live) setView(v) }).catch(() => {})
    return () => { live = false }
  }, [job?.id, show, refreshKey])

  const sections = useMemo(() => groupCarried(view.lines), [view.lines])
  const tx = useMachineTranslation(lang, view.lines.flatMap(l => [l.room, l.task, l.issue_note]))
  if (!show || view.lines.length === 0 || isWalkthroughVisit(view.lines)) return null

  const uri = (u: string) => view.files[u] ?? u
  return (
    <View style={styles.card} testID="carried-lines-card">
      <Text style={styles.title}>⚠ {t('carried_title')}</Text>
      <Text style={styles.hint}>{t('carried_hint')}</Text>
      {sections.map(s => (
        <View key={s.room} style={{ marginTop: 8 }}>
          <Text style={styles.room}>{tx(s.room)}</Text>
          {s.lines.map(l => (
            <View key={l.missed_item_id} style={styles.line}>
              <Text style={styles.task}>{tx(l.task)}</Text>
              {!!l.issue_note && <Text style={styles.note}>“{tx(l.issue_note)}”</Text>}
              <Text style={styles.when}>{ti(t('carried_flagged'), { date: fmtDate(l.missed_at, localeFor(lang), { weekday: 'short', month: 'short', day: 'numeric' }) })}</Text>
              {l.photo_urls.length > 0 && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {l.photo_urls.map(u => (
                    <TouchableOpacity key={u} onPress={() => setBig(uri(u))} accessibilityLabel={t('carried_photo')}>
                      <Image source={{ uri: uri(u) }} style={styles.thumb} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          ))}
        </View>
      ))}
      <Modal visible={!!big} transparent animationType="fade" onRequestClose={() => setBig(null)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setBig(null)} style={styles.viewer}>
          {!!big && <Image source={{ uri: big }} style={styles.full} resizeMode="contain" />}
          <Text style={styles.close}>✕</Text>
        </TouchableOpacity>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: RED_PALE, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 2, borderColor: RED_LINE },
  title: { fontSize: 12, fontWeight: '800', color: RED, letterSpacing: 0.6, textTransform: 'uppercase' },
  hint: { fontSize: 12, color: INK_MUTED, marginTop: 4, lineHeight: 17 },
  room: { fontSize: 13, fontWeight: '800', color: INK },
  line: { borderLeftWidth: 3, borderLeftColor: RED_LINE, paddingLeft: 10, paddingVertical: 6, marginTop: 4 },
  task: { fontSize: 14, fontWeight: '600', color: INK, lineHeight: 19 },
  note: { fontSize: 13, color: RED, marginTop: 2, lineHeight: 18 },
  when: { fontSize: 11, color: INK_MUTED, marginTop: 2 },
  thumb: { width: 84, height: 84, borderRadius: 8, borderWidth: 1, borderColor: RED_LINE, backgroundColor: '#fff' },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '80%' },
  close: { position: 'absolute', top: 54, right: 24, color: '#fff', fontSize: 26, fontWeight: '700' },
})
