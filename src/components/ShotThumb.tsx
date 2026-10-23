// A required shot's preview in its room (JobDetailScreen). A stored photo
// loads as a small copy (lib/thumbUrl). Each source that fails to load gives
// way to the next: the full photo (transformation unavailable), then the
// shot's stored copy (its file on the phone was deleted once it uploaded,
// lib/roomShots). With none left it shows the empty camera square.
import React, { useState } from 'react'
import { Image, Text, View } from 'react-native'
import { thumbSources } from '../lib/thumbUrl'

export function ShotThumb({ uri, fallback, size }: { uri: string; fallback?: string | null; size: number }) {
  const sources = thumbSources(uri, fallback ?? null, size)
  // Which source failed is kept with the sources it was for: a new shot starts
  // again from its small copy.
  const key = sources.join('\n')
  const [failed, setFailed] = useState({ key, n: 0 })
  const at = failed.key === key ? failed.n : 0
  const box = { width: size, height: size, borderRadius: 6, backgroundColor: '#F3F4F6' }
  if (at >= sources.length) {
    return <View style={[box, { alignItems: 'center', justifyContent: 'center' }]}><Text style={{ opacity: 0.5 }}>📷</Text></View>
  }
  return <Image source={{ uri: sources[at] }} style={box} onError={() => setFailed(f => ({ key, n: (f.key === key ? f.n : 0) + 1 }))} />
}
