// src/components/RepairQuoteCard.tsx
// A look-and-quote visit's card on the job screen: one price and a note, which
// land on the incident for the office, and the property's upcoming empty days to
// move the visit to (rinse-base-app migration 20261031150000_repair_review_quote).
// Shows nothing on any other visit, on a database without repair_reviews, or
// offline, where the notes still say it's a look and quote. The web crew view has
// its own copy (src/components/RepairQuoteCard.tsx).

import React, { useEffect, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, Alert, StyleSheet } from 'react-native'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { parseQuoteAmount } from '../lib/repairVisit'

type Review = { id: string; amount: number | null; note: string | null; submitted_at: string | null; decision: string | null }
type Day = { day: string; kind: 'empty' | 'between' }

export function RepairQuoteCard({ visitId, addressId, status, onMoved }: {
  visitId: string
  addressId?: string | null
  status: string
  /** The visit's new start. */
  onMoved?: (start: string) => void
}) {
  const { t, lang } = useLang() as any
  const [review, setReview] = useState<Review | null>(null)
  const [price, setPrice] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [days, setDays] = useState<Day[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setReview(null)
    supabase.from('repair_reviews').select('id, amount, note, submitted_at, decision').eq('visit_id', visitId).maybeSingle()
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        const r = data as any as Review
        setReview(r)
        setPrice(r.amount == null ? '' : String(r.amount))
        setNote(r.note ?? '')
      }, () => { /* offline: the notes still say what this trip is for */ })
    return () => { cancelled = true }
  }, [visitId])

  if (!review) return null

  async function send() {
    const amount = parseQuoteAmount(price)
    if (amount == null) { Alert.alert('', t('quote_bad_price')); return }
    setBusy(true)
    try {
      const { error } = await supabase.rpc('submit_repair_quote', { p_visit_id: visitId, p_amount: amount, p_note: note })
      if (error) { Alert.alert('', error.message); return }
      setReview(r => r ? { ...r, amount, note: note.trim() || null, submitted_at: r.submitted_at ?? new Date().toISOString() } : r)
      Alert.alert('', t('quote_sent'))
    } catch (e: any) {
      Alert.alert('', e?.message || t('quote_bad_price'))
    } finally {
      setBusy(false)
    }
  }

  async function openDays() {
    if (!addressId) return
    try {
      const { data, error } = await supabase.rpc('repair_review_days', { p_address_id: addressId, p_days: 45 })
      if (error) { Alert.alert('', error.message); return }
      setDays((data ?? []) as Day[])
    } catch (e: any) {
      Alert.alert('', e?.message || '')
    }
  }

  async function move(day: string) {
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('move_repair_review_visit', { p_visit_id: visitId, p_day: day })
      if (error) { Alert.alert('', error.message); return }
      setDays(null)
      Alert.alert('', t('quote_moved'))
      if (data) onMoved?.(new Date(data as any).toISOString())
    } catch (e: any) {
      Alert.alert('', e?.message || '')
    } finally {
      setBusy(false)
    }
  }

  const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(lang === 'es' ? 'es' : lang === 'pt' ? 'pt' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const shownPrice = review.amount == null ? '' : Number(review.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <View style={styles.card} testID="repair-quote-card">
      <Text style={styles.title}>🔍 {t('quote_title')}</Text>
      {review.decision ? (
        <View style={{ marginTop: 4 }}>
          <Text style={styles.decided}>{shownPrice} · {t(review.decision === 'approved' ? 'quote_approved' : 'quote_declined')}</Text>
          {!!review.note && <Text style={styles.hint}>{review.note}</Text>}
        </View>
      ) : (
        <>
          <Text style={styles.hint}>{t('quote_hint')}</Text>
          <Text style={styles.label}>{t('quote_price')}</Text>
          <TextInput style={styles.input} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="450" placeholderTextColor="#9CA3AF" />
          <Text style={styles.label}>{t('quote_note')}</Text>
          <TextInput style={[styles.input, { minHeight: 60, textAlignVertical: 'top' }]} value={note} onChangeText={setNote} multiline maxLength={2000} placeholder={t('quote_note_ph')} placeholderTextColor="#9CA3AF" />
          <TouchableOpacity style={[styles.send, busy && { opacity: 0.6 }]} onPress={send} disabled={busy} accessibilityRole="button">
            <Text style={styles.sendText}>{t(review.submitted_at ? 'quote_update' : 'quote_send')}</Text>
          </TouchableOpacity>
          {!!review.submitted_at && <Text style={styles.sent}>{t('quote_sent')}</Text>}
        </>
      )}
      {status === 'scheduled' && !!addressId && (
        <View style={styles.moveBox}>
          {days == null ? (
            <TouchableOpacity onPress={openDays} accessibilityRole="button"><Text style={styles.moveLink}>{t('quote_move')}</Text></TouchableOpacity>
          ) : days.length === 0 ? (
            <Text style={styles.hint}>{t('quote_no_days')}</Text>
          ) : (
            <View style={styles.days}>
              {days.slice(0, 14).map(d => (
                <TouchableOpacity key={d.day} style={styles.day} onPress={() => move(d.day)} disabled={busy} accessibilityRole="button">
                  <Text style={styles.dayText}>{dayLabel(d.day)}{d.kind === 'between' ? ` · ${t('quote_between')}` : ''}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { marginBottom: 10, padding: 12, backgroundColor: '#FDF6E3', borderRadius: 10, borderWidth: 1, borderColor: '#EBD79B' },
  title: { fontSize: 14, fontWeight: '700', color: '#1A1408' },
  hint: { fontSize: 12, color: '#6B5E42', marginTop: 3, lineHeight: 17 },
  decided: { fontSize: 14, fontWeight: '700', color: '#1A1408' },
  label: { fontSize: 12, fontWeight: '600', color: '#6B5E42', marginTop: 10, marginBottom: 4 },
  input: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#EDE7D8', padding: 10, fontSize: 16, color: '#1A1408' },
  send: { marginTop: 10, backgroundColor: '#1A1408', borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  sendText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  sent: { marginTop: 6, fontSize: 12, fontWeight: '600', color: '#15803D', textAlign: 'center' },
  moveBox: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#EBD79B' },
  moveLink: { fontSize: 13, fontWeight: '700', color: '#8A6810', textDecorationLine: 'underline' },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  day: { paddingVertical: 8, paddingHorizontal: 10, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#EDE7D8' },
  dayText: { fontSize: 12, fontWeight: '600', color: '#1A1408' },
})
