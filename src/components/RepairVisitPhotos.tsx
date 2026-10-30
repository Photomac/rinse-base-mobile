// src/components/RepairVisitPhotos.tsx
// The incident's photos on its repair visit: thumbnails that open full size, so
// the tech can see what he's going to and start a quote from them. They come
// from the incident (jobs.source_report_id), as it stands now. The links in the
// visit's notes only stand in until it has loaded, or when it can't (offline).

import React, { useEffect, useState } from 'react'
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { PhotoViewer } from './PhotoViewer'
import { photoLinksInNotes, photoThumb } from '../lib/repairVisit'

const SIZE = 76

function Thumb({ url, label, onPress }: { url: string; label: string; onPress: () => void }) {
  // The original, if the small copy can't be had.
  const [uri, setUri] = useState(() => photoThumb(url, SIZE))
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} accessibilityRole="imagebutton" accessibilityLabel={label}>
      <Image source={{ uri }} style={styles.thumb} onError={() => setUri(u => (u === url ? u : url))} />
    </TouchableOpacity>
  )
}

export function RepairVisitPhotos({ reportId, notes }: { reportId: string; notes?: string | null }) {
  const { t } = useLang()
  const [urls, setUrls] = useState<string[]>(() => photoLinksInNotes(notes))
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    supabase.from('job_damage_reports').select('photo_urls').eq('id', reportId).maybeSingle()
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        setUrls(((data as any).photo_urls ?? []).filter(Boolean))
      }, () => { /* offline: keep what the notes had */ })
    return () => { cancelled = true }
  }, [reportId])

  if (urls.length === 0) return null
  return (
    <View style={styles.row} testID="repair-visit-photos">
      <Text style={styles.icon}>📷</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{t('repair_photos')} ({urls.length})</Text>
        <View style={styles.grid}>
          {urls.map((url, i) => (
            <Thumb key={url} url={url} label={`${t('repair_photos')} ${i + 1}`} onPress={() => setOpen(i)} />
          ))}
        </View>
      </View>
      {open != null && <PhotoViewer photos={urls.map(url => ({ url }))} startIndex={open} onClose={() => setOpen(null)} />}
    </View>
  )
}

// The job screen's info row, so it sits with the notes above it.
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: 10, backgroundColor: '#F9FAFB', borderRadius: 10 },
  icon: { fontSize: 16 },
  label: { fontSize: 10, color: '#9CA3AF', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  thumb: { width: SIZE, height: SIZE, borderRadius: 8, backgroundColor: '#E2E8F0' },
})
