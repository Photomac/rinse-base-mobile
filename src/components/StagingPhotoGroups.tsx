// src/components/StagingPhotoGroups.tsx
// The owner's staging / reference photos, grouped by room. Shared by the job
// screen and the inspection screen.
//
// A property can carry 29 of these. As one horizontal strip that was a wall of
// unlabelled thumbnails, so with more than one room each room is a collapsible
// row ("Kitchen · 3"), collapsed to start: the list of rooms is the index, and
// the crew opens the one they're standing in. A property that was never sorted
// has a single group and renders as the plain strip it always was.
//
// Taps report a position in the grouped order. Pass the same order to
// PhotoViewer (see stagingViewerPhotos) so the viewer opens the photo tapped.

import React, { useState } from 'react'
import { View, Text, TouchableOpacity, ScrollView, Image } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { groupStagingPhotos, type StagingPhotoRow } from '../lib/stagingRooms'
import type { ViewerPhoto } from './PhotoViewer'
import type { TranslationKey } from '../lib/i18n'

/** Flattened grouped order for PhotoViewer, each photo labelled with its room. */
export function stagingViewerPhotos(photos: StagingPhotoRow[], t: (k: TranslationKey) => string): ViewerPhoto[] {
  return groupStagingPhotos(photos, t).flatMap(g =>
    g.photos.map(p => ({ url: p.url, caption: p.caption || null, meta: `${g.label} · ${t('staging_photos')}` })))
}

export function StagingPhotoGroups({ photos, size = 110, onOpen }: {
  photos: StagingPhotoRow[]
  size?: number
  onOpen: (index: number) => void
}) {
  const { t } = useLang()
  const groups = groupStagingPhotos(photos, t)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const strip = (items: StagingPhotoRow[], start: number) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
      {items.map((p, i) => (
        <TouchableOpacity key={start + i} onPress={() => onOpen(start + i)} style={{ marginRight: 8 }}>
          <Image source={{ uri: p.url }} style={{ width: size, height: size, borderRadius: 10 }} resizeMode="cover" />
          {!!p.caption && <Text style={{ fontSize: 10, color: '#6B7280', marginTop: 3, width: size }} numberOfLines={2}>{p.caption}</Text>}
        </TouchableOpacity>
      ))}
    </ScrollView>
  )

  if (groups.length <= 1) return groups[0] ? strip(groups[0].photos, 0) : null

  return (
    <View style={{ marginTop: 4 }}>
      {groups.map(g => {
        const isOpen = !!open[g.key]
        return (
          <View key={g.key} style={{ borderBottomWidth: 1, borderBottomColor: '#EDE7D8' }}>
            <TouchableOpacity
              onPress={() => setOpen(o => ({ ...o, [g.key]: !o[g.key] }))}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}
              accessibilityRole="button"
              accessibilityState={{ expanded: isOpen }}>
              <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: '#1A1408' }}>
                {g.label} <Text style={{ fontWeight: '400', color: '#9E8E72' }}>· {g.photos.length}</Text>
              </Text>
              <Text style={{ fontSize: 14, color: '#9E8E72' }}>{isOpen ? '▾' : '›'}</Text>
            </TouchableOpacity>
            {isOpen && <View style={{ paddingBottom: 10 }}>{strip(g.photos, g.start)}</View>}
          </View>
        )
      })}
    </View>
  )
}
