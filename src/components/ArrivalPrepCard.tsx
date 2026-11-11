// "From the arrival prep" on a turnover: what the arrival prep recorded of how
// the guest left the home, before this clean (CKS Perfections, 2026-11-11).
// The office links the arrival to its turnover on the web; its photos show
// here as thumbnails in groups (as the guest left it, damage, other, after the
// prep), tap for the full-screen viewer; its videos are listed, and a tap
// plays one in the phone's own video player (a player inside the app needs a
// native module, expo-video: a store build). Rules:
// lib/arrivalPrep.ts; reads: lib/arrivalPrepCard.ts (the day pack saves the
// rows, not the photo files).
//
// Read-only. Renders nothing on a clean with no arrival linked, while the
// read is out, and on a read error.
import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Linking, Alert } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { ti, localeFor, type TranslationKey } from '../lib/i18n'
import { clockOf, dayKey, fmtDatePart, fmtTimeAt } from '../lib/timezone'
import { useMachineTranslation } from '../lib/machineTranslate'
import { arrivalEmptyLine, arrivalPhotoGroups, videoLength, type ArrivalGroup, type ArrivalPrepView, type ArrivalVideo } from '../lib/arrivalPrep'
import { loadArrivalPrep } from '../lib/arrivalPrepCard'
import { PhotoViewer } from './PhotoViewer'
import { ShotThumb } from './ShotThumb'

const INK = '#1A1408'
const INK_MUTED = '#6B5E42'
const GOLD_DARK = '#8A6810'
const GOLD_PALE = '#FDF6E3'
const CREAM_LINE = '#EDE7D8'
const THUMB = 76

const GROUP_LABEL: Record<ArrivalGroup, TranslationKey> = {
  before: 'arrival_before', damage: 'damage', other: 'other_photo', after: 'arrival_after',
}

export function ArrivalPrepCard({ job, refreshKey = 0 }: { job: any; refreshKey?: number }) {
  const { t, lang } = useLang()
  const locale = localeFor(lang)
  const [view, setView] = useState<ArrivalPrepView | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    setView(null)
    if (!job?.id) return
    loadArrivalPrep(job, v => { if (live) setView(v) }).catch(() => {})
    return () => { live = false }
  }, [job?.id, refreshKey])

  // A newer answer with a different number of photos closes the viewer, so
  // its page can't point past the end of the list.
  const count = view?.photos.length ?? 0
  useEffect(() => { setOpen(null) }, [count])

  const groups = useMemo(() => arrivalPhotoGroups(view?.photos ?? []), [view])
  const tx = useMachineTranslation(lang, [...(view?.photos ?? []).map(p => p.caption), ...(view?.videos ?? []).map(v => v.caption)])
  if (!view) return null

  const addr = job.client_addresses
  // The day too when the prep wasn't on the clean's day (an evening-before prep).
  const zone = clockOf(addr)
  const otherDay = !!view.at && !!job.scheduled_start && dayKey(view.at, zone) !== dayKey(job.scheduled_start, zone)
  const when = view.at
    ? `${otherDay ? `${fmtDatePart(view.at, 'weekday', locale)} ` : ''}${fmtTimeAt(view.at, addr, locale)}`
    : ''
  const who = view.who.join(', ')
  const title = who && when ? ti(t('arrival_title_who'), { who, time: when })
    : who || when ? ti(t('arrival_title_one'), { what: who || when })
    : t('arrival_title')
  const empty = arrivalEmptyLine(view)
  const label = (g: ArrivalGroup) => t(GROUP_LABEL[g])
  // The phone's own player (Safari / the browser on Android): the file is a
  // public https link, so no sign-in. Off signal it says it can't open.
  const play = (v: ArrivalVideo) => {
    Linking.openURL(v.url).catch(() => Alert.alert(t('arrival_video_failed')))
  }
  const viewerPhotos = view.photos.map(p => ({
    url: p.url,
    caption: p.caption ? tx(p.caption) : label(p.group),
    meta: [p.caption ? label(p.group) : null, p.by, p.at ? fmtTimeAt(p.at, addr, locale) : null].filter(Boolean).join(' · '),
  }))

  return (
    <View style={styles.card} testID="arrival-prep-card">
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.hint}>{t('arrival_hint')}</Text>
      {groups.map(g => (
        <View key={g.group} style={{ marginTop: 10 }} testID={`arrival-group-${g.group}`}>
          <Text style={styles.group}>{label(g.group)} · {g.photos.length}</Text>
          <View style={styles.row}>
            {g.photos.map(p => {
              // The viewer pages through every photo, in the card's order.
              const i = view.photos.indexOf(p)
              return (
                <TouchableOpacity key={p.id} onPress={() => setOpen(i)} accessibilityRole="imagebutton"
                  accessibilityLabel={`${label(p.group)} ${i + 1}`}>
                  <ShotThumb uri={p.url} size={THUMB} />
                </TouchableOpacity>
              )
            })}
          </View>
        </View>
      ))}
      {view.videos.length > 0 && (
        <View style={{ marginTop: 10 }} testID="arrival-videos">
          <Text style={styles.group}>{t('arrival_videos_head')} · {view.videos.length}</Text>
          {view.videos.map((v, i) => {
            const len = videoLength(v.secs)
            const what = v.caption ? tx(v.caption) : label(v.group)
            const sub = [v.caption ? label(v.group) : null, v.by, v.at ? fmtTimeAt(v.at, addr, locale) : null].filter(Boolean).join(' · ')
            return (
              <TouchableOpacity key={v.id} style={styles.videoRow} onPress={() => play(v)}
                accessibilityRole="button" accessibilityLabel={`${t('arrival_video_play')} ${i + 1}: ${what}${len ? `, ${len}` : ''}`}
                testID={`arrival-video-${i}`}>
                <View style={styles.playDot}><Text style={styles.playIcon}>▶</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.videoTitle} numberOfLines={2}>{what}{len ? ` · ${len}` : ''}</Text>
                  {!!sub && <Text style={styles.videoSub} numberOfLines={1}>{sub}</Text>}
                </View>
              </TouchableOpacity>
            )
          })}
          <Text style={styles.videoHint}>{t('arrival_video_hint')}</Text>
        </View>
      )}
      {!!empty && <Text style={styles.empty}>{t(empty)}</Text>}
      {open != null && viewerPhotos.length > 0 && (
        <PhotoViewer photos={viewerPhotos} startIndex={open} onClose={() => setOpen(null)} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: GOLD_PALE, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1.5, borderColor: CREAM_LINE },
  title: { fontSize: 14, fontWeight: '800', color: INK, lineHeight: 19 },
  hint: { fontSize: 12, color: INK_MUTED, marginTop: 3, lineHeight: 17 },
  group: { fontSize: 11, fontWeight: '800', color: GOLD_DARK, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  videoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFFFFF', borderRadius: 10, borderWidth: 1, borderColor: CREAM_LINE, paddingVertical: 9, paddingHorizontal: 10, marginBottom: 6, minHeight: 48 },
  playDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: INK, alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: '#FFFFFF', fontSize: 13, marginLeft: 2 },
  videoTitle: { fontSize: 13, color: INK, fontWeight: '700', lineHeight: 18 },
  videoSub: { fontSize: 12, color: INK_MUTED, marginTop: 1, lineHeight: 16 },
  videoHint: { fontSize: 12, color: INK_MUTED, lineHeight: 17 },
  empty: { fontSize: 13, color: INK_MUTED, marginTop: 8, lineHeight: 18 },
})
