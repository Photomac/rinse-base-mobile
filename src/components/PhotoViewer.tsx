// src/components/PhotoViewer.tsx
// Fullscreen photo viewer with pinch-to-zoom — the mobile counterpart of the
// web PhotoLightbox. Pinch to zoom (1–5×), drag to pan while zoomed,
// double-tap to toggle 2.5×, arrows to move between photos (zoom resets).
// GestureHandlerRootView lives inside the Modal because RN Modals mount a
// separate native view tree — gestures outside it are dead on Android.

import React, { useState } from 'react'
import { Modal, View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native'
import { GestureHandlerRootView, GestureDetector, Gesture } from 'react-native-gesture-handler'
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { useLang } from '../contexts/LangContext'

export interface ViewerPhoto {
  url: string
  caption?: string | null
  meta?: string | null
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window')
const MAX_SCALE = 5

function clamp(v: number, min: number, max: number): number {
  'worklet'
  return Math.min(Math.max(v, min), max)
}

export function PhotoViewer({ photos, startIndex = 0, onClose }: {
  photos: ViewerPhoto[]
  startIndex?: number
  onClose: () => void
}) {
  const { t } = useLang()
  const [index, setIndex] = useState(Math.min(Math.max(startIndex, 0), photos.length - 1))

  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const savedTx = useSharedValue(0)
  const savedTy = useSharedValue(0)

  function resetZoom(animated = true) {
    const target = animated ? withTiming : (v: number) => v
    scale.value = target(1)
    tx.value = target(0)
    ty.value = target(0)
    savedScale.value = 1
    savedTx.value = 0
    savedTy.value = 0
  }

  function go(dir: -1 | 1) {
    resetZoom(false)
    setIndex(i => (i + dir + photos.length) % photos.length)
  }

  // Keep the photo from being dragged fully off-screen: at scale s the image
  // can shift at most (s-1)/2 of its rendered size in each direction.
  const pinch = Gesture.Pinch()
    .onUpdate(e => {
      scale.value = clamp(savedScale.value * e.scale, 1, MAX_SCALE)
    })
    .onEnd(() => {
      savedScale.value = scale.value
      if (scale.value <= 1.02) {
        scale.value = withTiming(1)
        tx.value = withTiming(0)
        ty.value = withTiming(0)
        savedScale.value = 1
        savedTx.value = 0
        savedTy.value = 0
      }
    })

  const pan = Gesture.Pan()
    .onUpdate(e => {
      if (savedScale.value <= 1) return
      const maxX = (SCREEN_W * (savedScale.value - 1)) / 2
      const maxY = (SCREEN_H * (savedScale.value - 1)) / 2
      tx.value = clamp(savedTx.value + e.translationX, -maxX, maxX)
      ty.value = clamp(savedTy.value + e.translationY, -maxY, maxY)
    })
    .onEnd(() => {
      savedTx.value = tx.value
      savedTy.value = ty.value
    })

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (savedScale.value > 1) {
        scale.value = withTiming(1)
        tx.value = withTiming(0)
        ty.value = withTiming(0)
        savedScale.value = 1
        savedTx.value = 0
        savedTy.value = 0
      } else {
        scale.value = withTiming(2.5)
        savedScale.value = 2.5
      }
    })

  const gestures = Gesture.Exclusive(
    Gesture.Simultaneous(pinch, pan),
    doubleTap,
  )

  const imgStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }))

  const photo = photos[index]
  if (!photo) return null

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={styles.root}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <Text style={styles.counter}>{index + 1} / {photos.length}</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Zoomable image */}
        <GestureDetector gesture={gestures}>
          <View style={styles.stage} collapsable={false}>
            <Animated.Image
              source={{ uri: photo.url }}
              style={[styles.image, imgStyle]}
              resizeMode="contain"
            />
          </View>
        </GestureDetector>

        {/* Nav arrows */}
        {photos.length > 1 && (
          <>
            <TouchableOpacity onPress={() => go(-1)} style={[styles.navBtn, { left: 12 }]} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={styles.navText}>‹</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => go(1)} style={[styles.navBtn, { right: 12 }]} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={styles.navText}>›</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Caption bar */}
        <View style={styles.bottomBar} pointerEvents="none">
          {!!photo.caption && <Text style={styles.caption}>{photo.caption}</Text>}
          {!!photo.meta && <Text style={styles.meta}>{photo.meta}</Text>}
          <Text style={styles.hint}>{t('pinch_zoom_hint')}</Text>
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'rgba(8,8,10,0.96)' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 52, paddingHorizontal: 16, paddingBottom: 10,
  },
  counter: { color: '#fff', fontSize: 14, fontWeight: '600', opacity: 0.85 },
  closeBtn: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  closeText: { color: '#fff', fontSize: 16 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  image: { width: SCREEN_W, height: SCREEN_H * 0.72 },
  navBtn: {
    position: 'absolute', top: '50%', marginTop: -21, zIndex: 2,
    width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  navText: { color: '#fff', fontSize: 24, lineHeight: 26, fontWeight: '400' },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: 40, paddingHorizontal: 20, alignItems: 'center' },
  caption: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center', marginBottom: 2 },
  meta: { color: 'rgba(255,255,255,0.65)', fontSize: 12, textAlign: 'center' },
  hint: { color: 'rgba(255,255,255,0.35)', fontSize: 11, marginTop: 6 },
})
