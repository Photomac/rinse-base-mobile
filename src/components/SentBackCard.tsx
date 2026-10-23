// "↩ Sent back to you" on Home (CKS Perfections, 2026-10-23).
//
// The office sent one of this person's reports back with a short note
// ("photos of the oven, please": incident_send_backs, written by the web's
// Send back). The card shows the note, a photo slot for each thing a
// deep-clean request names (what already has a labelled photo says so), and a
// box for a few words. "Send it back to Catherine" queues the new photos,
// each labelled with what it is of (lib/photoQueue), and the answer
// (lib/incidentNotify), which goes once the photos have attached and emails
// the office. The card then hides on this phone until the server agrees.
//
// Renders nothing when nothing is waiting, offline included (it has no saved
// copy: the push says what is waiting). Reloads when the app comes back to
// the front and when a send-back push arrives.

import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Image, Alert, AppState } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as Notifications from 'expo-notifications'
import { supabase } from '../lib/supabase'
import { ensureCameraCapture } from '../lib/permissions'
import { persistCapturedPhoto, discardCapturedPhoto, enqueueIncidentPhoto, flushQueue } from '../lib/photoQueue'
import { queueSendBackAnswer, pendingSendBackAnswerIds, flushIncidentNotifies } from '../lib/incidentNotify'
import { deepCleanSlotsFromTitle, deepCleanMissing, isDeepClean, type DeepCleanSlot } from '../lib/deepClean'
import { useLang } from '../contexts/LangContext'
import { TranslationKey, ti } from '../lib/i18n'
import { CARD, BORDER, TEXT, TEXT_MUTED, TEXT_LIGHT } from '../lib/theme'

const AMBER = '#B45309'
// Any other report: one unnamed slot.
const ANY_PHOTO: DeepCleanSlot = { key: 'photo', label: '' }

type Waiting = {
  id: string
  note: string
  sender: string | null
  report: {
    id: string; job_id: string; title: string | null; report_type: string | null
    photo_urls: string[]; photo_labels: Record<string, string>; property: string | null
  }
}

/** "Catherine Krause" → "Catherine"; an all-caps "BRITTANY FORLANO" → "Brittany". */
function firstName(full: string | null | undefined): string {
  const first = String(full ?? '').trim().split(/\s+/)[0] ?? ''
  return first.length > 2 && first === first.toUpperCase() && first !== first.toLowerCase()
    ? first[0] + first.slice(1).toLowerCase()
    : first
}

export function SentBackCard({ user }: { user: any }) {
  const [items, setItems] = useState<Waiting[]>([])

  const load = useCallback(async () => {
    if (!user?.id) return
    const { data, error } = await supabase.from('incident_send_backs')
      .select('id, note, sender:users!incident_send_backs_sent_by_fkey(full_name), report:job_damage_reports!incident_send_backs_report_fkey(id, job_id, title, report_type, photo_urls, photo_labels, status, host_notified_at, client_addresses!job_damage_reports_address_id_fkey(nickname, street))')
      .eq('sent_to', user.id).is('answered_at', null)
      .order('created_at', { ascending: false }).limit(20)
    // Offline, or the server doesn't have send-backs yet: keep what is shown.
    if (error) return
    const answered = await pendingSendBackAnswerIds()
    setItems((data ?? [])
      .filter((r: any) => r.report && !r.report.host_notified_at && ['reported', 'reviewed'].includes(r.report.status) && !answered.has(r.report.id))
      .map((r: any) => ({
        id: r.id, note: r.note, sender: r.sender?.full_name ?? null,
        report: {
          id: r.report.id, job_id: r.report.job_id, title: r.report.title, report_type: r.report.report_type,
          photo_urls: r.report.photo_urls ?? [], photo_labels: r.report.photo_labels ?? {},
          property: (r.report.client_addresses?.nickname || r.report.client_addresses?.street || '').trim() || null,
        },
      })))
  }, [user?.id])

  useEffect(() => {
    load()
    const sub = AppState.addEventListener('change', s => { if (s === 'active') load() })
    let pushed: { remove: () => void } | null = null
    try {
      pushed = Notifications.addNotificationReceivedListener(n => {
        if ((n.request.content.data as any)?.type === 'incident_sent_back') load()
      })
    } catch { /* web: no pushes */ }
    return () => { sub.remove(); pushed?.remove() }
  }, [load])

  if (!items.length) return null
  return (
    <>
      {items.map(w => (
        <SentBackItem key={w.id} w={w} user={user} onSent={() => setItems(p => p.filter(x => x.id !== w.id))} />
      ))}
    </>
  )
}

function SentBackItem({ w, user, onSent }: { w: Waiting; user: any; onSent: () => void }) {
  const { t } = useLang()
  const deep = isDeepClean(w.report.report_type)
  const slots = deep ? deepCleanSlotsFromTitle(w.report.title) : [ANY_PHOTO]
  // A slot that already has a labelled photo says so (it can still take more).
  const missing = new Set(deep ? deepCleanMissing(slots, w.report.photo_labels).map(s => s.key) : [])
  const [shots, setShots] = useState<Record<string, string[]>>({})
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [camera, setCamera] = useState(false)
  const sender = firstName(w.sender) || t('sb_office')
  const slotName = (sl: DeepCleanSlot) => (sl.labelKey ? t(sl.labelKey as TranslationKey) : sl.label)

  async function addPhoto(key: string) {
    setCamera(true)
    try {
      // Camera-only and nothing uploads here, as in Report an issue: the photo
      // is kept on the phone and queued on Send.
      if (await ensureCameraCapture() !== 'granted') { setCamera(false); return }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.7 })
      if (!result.canceled && result.assets?.[0]) {
        const local = await persistCapturedPhoto(result.assets[0].uri, w.report.job_id)
        setShots(p => ({ ...p, [key]: [...(p[key] ?? []), local] }))
      }
    } catch (e: any) {
      Alert.alert(t('upload_failed'), e?.message || '')
    }
    setCamera(false)
  }

  async function send() {
    const all = Object.values(shots).flat()
    if (!all.length && !note.trim()) { Alert.alert(t('sb_need_something')); return }
    setBusy(true)
    try {
      for (const sl of slots) {
        for (const localUri of shots[sl.key] ?? []) {
          await enqueueIncidentPhoto({
            localUri, tenant_id: user.tenant_id, job_id: w.report.job_id, user_id: user.id,
            incident_report_id: w.report.id, label: deep ? sl.label : null,
          })
        }
      }
      // Sent once those photos are on the report (lib/incidentNotify).
      await queueSendBackAnswer({ report_id: w.report.id, note: note.trim() || null })
      void flushQueue().then(() => flushIncidentNotifies()).catch(() => {})
      setBusy(false)
      onSent()
      Alert.alert(`↩ ${t('sb_sent_title')}`, ti(t('sb_sent_msg'), { name: sender }))
    } catch (e: any) {
      setBusy(false)
      Alert.alert(t('error'), e?.message || t('could_not_upload'))
    }
  }

  const already = w.report.photo_urls.length
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('sb_title')}</Text>
      <Text style={styles.what}>{w.report.title}{w.report.property ? ` · ${w.report.property}` : ''}</Text>
      <Text style={styles.asks}>{ti(t('sb_asks'), { name: sender })} <Text style={styles.note}>“{w.note}”</Text></Text>
      {already > 0 && <Text style={styles.sub}>{ti(t('sb_photos_on_it'), { n: String(already) })}</Text>}

      {slots.map(sl => {
        const mine = shots[sl.key] ?? []
        const needed = (!deep || missing.has(sl.key)) && !mine.length
        return (
          <View key={sl.key} style={styles.slotRow}>
            {deep && (
              <Text style={[styles.slotName, { color: needed ? AMBER : TEXT }]} numberOfLines={2}>
                {mine.length ? '✓ ' : ''}{slotName(sl)}{!missing.has(sl.key) && !mine.length ? ` · ${t('sb_on_it')}` : ''}
              </Text>
            )}
            {mine.map(u => (
              <View key={u}>
                <Image source={{ uri: u }} style={styles.thumb} />
                <TouchableOpacity style={styles.remove} onPress={() => { discardCapturedPhoto(u); setShots(p => ({ ...p, [sl.key]: (p[sl.key] ?? []).filter(x => x !== u) })) }}>
                  <Text style={styles.removeText}>×</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.slotBtn} onPress={() => addPhoto(sl.key)} disabled={camera || busy}>
              <Text style={styles.slotBtnText}>{camera ? '…' : t(mine.length ? 'ir_deep_photo_more' : 'ir_deep_photo_btn')}</Text>
            </TouchableOpacity>
          </View>
        )
      })}

      <TextInput
        style={styles.input}
        value={note}
        onChangeText={setNote}
        maxLength={500}
        placeholder={t('sb_note_placeholder')}
        placeholderTextColor={TEXT_LIGHT}
        multiline
      />
      <TouchableOpacity style={[styles.sendBtn, busy && { opacity: 0.6 }]} onPress={send} disabled={busy}>
        <Text style={styles.sendText}>{ti(t('sb_send'), { name: sender })}</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1.5, borderColor: '#F59E0B' },
  title: { fontSize: 15, fontWeight: '800', color: AMBER },
  what: { fontSize: 14, fontWeight: '700', color: TEXT, marginTop: 4 },
  asks: { fontSize: 13, color: TEXT_MUTED, marginTop: 6, lineHeight: 19 },
  note: { color: TEXT, fontWeight: '700' },
  sub: { fontSize: 12, color: TEXT_MUTED, marginTop: 4 },
  slotRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: BORDER, marginTop: 6 },
  slotName: { fontSize: 13, fontWeight: '700', minWidth: 96, flexShrink: 1 },
  thumb: { width: 44, height: 44, borderRadius: 7, borderWidth: 1, borderColor: BORDER },
  remove: { position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  removeText: { color: '#fff', fontSize: 10, fontWeight: '700', lineHeight: 12 },
  slotBtn: { borderWidth: 1, borderColor: BORDER, borderStyle: 'dashed', borderRadius: 9, paddingVertical: 7, paddingHorizontal: 12, marginLeft: 'auto' },
  slotBtnText: { fontSize: 13, fontWeight: '600', color: TEXT_MUTED },
  input: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, padding: 12, fontSize: 13, color: TEXT, marginTop: 10, minHeight: 48, textAlignVertical: 'top' },
  sendBtn: { backgroundColor: AMBER, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  sendText: { color: '#fff', fontSize: 14, fontWeight: '800' },
})
