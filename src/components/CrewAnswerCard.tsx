// "Can you do this clean?" at the top of a clean the viewer was given, at a
// company that asks its crew to accept or decline (lib/crewAnswers).
//
// Unanswered: Accept / Decline. Accepted: a quiet line, with "Can't make it
// now?" to decline later (plans change). Decline asks why (sick, not
// available, no ride, other with words) and confirms; the server takes them
// off the clean and tells the office, so the screen goes back to the list.
// Renders nothing on a clean they aren't on, one already under way, at a
// company that doesn't ask, offline, or before the web migration is applied.
import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, Modal, TextInput, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import { useLang } from '../contexts/LangContext'
import { canAnswer, cleanNote, declineReady, resultKey, DECLINE_REASONS, type DeclineReason } from '../lib/crewAnswers'
import { readCompanyAsks, readMyAnswer, sendAnswer } from '../lib/useCrewAnswers'

const AMBER = '#B45309'
const AMBER_PALE = '#FFFBEB'
const AMBER_LINE = '#FCD34D'
const GREEN = '#15803D'
const GREEN_PALE = '#F0FDF4'
const GREEN_LINE = '#BBF7D0'
const RED = '#B91C1C'
const INK = '#1A1408'
const INK_MUTED = '#6B5E42'

const REASON_KEY: Record<DeclineReason, string> = {
  sick: 'answer_reason_sick', unavailable: 'answer_reason_unavailable',
  no_ride: 'answer_reason_no_ride', other: 'answer_reason_other',
}

export function CrewAnswerCard({ job, user, onDeclined }: { job: any; user: any; onDeclined: () => void }) {
  const { t } = useLang()
  const show = canAnswer(job, user?.id)
  // null = show nothing; 'none' = waiting on them; 'accepted' = said yes
  const [state, setState] = useState<'none' | 'accepted' | null>(null)
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [reason, setReason] = useState<DeclineReason | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    let live = true
    setState(null)
    if (!show || !job?.id || !user?.tenant_id) return
    ;(async () => {
      const asks = await readCompanyAsks(user.tenant_id)
      if (!live || !asks) return
      const mine = await readMyAnswer(job.id, user.id)
      if (!live || mine === 'error') return
      setState(mine?.answer === 'accepted' ? 'accepted' : 'none')
    })()
    return () => { live = false }
  }, [job?.id, job?.scheduled_start, show, user?.id, user?.tenant_id])

  if (!show || state === null) return null

  function refused(code: string) {
    Alert.alert(t('answer_not_sent'), t(resultKey(code) as any))
  }

  async function accept() {
    if (busy) return
    setBusy(true)
    const code = await sendAnswer(job.id, 'accepted')
    setBusy(false)
    if (code === 'accepted') { setState('accepted'); return }
    refused(code)
  }

  function openDecline() {
    setReason(null)
    setNote('')
    setSheet(true)
  }

  async function decline() {
    if (busy || !declineReady(reason, note)) return
    setBusy(true)
    const code = await sendAnswer(job.id, 'declined', reason, cleanNote(note))
    setBusy(false)
    if (code === 'declined') {
      setSheet(false)
      Alert.alert(t('answer_declined_title'), t('answer_declined'), [{ text: t('done'), onPress: onDeclined }])
      return
    }
    refused(code)
  }

  return (
    <>
      {state === 'accepted' ? (
        <View style={[styles.card, styles.cardOk]}>
          <Text style={styles.okText}>✓ {t('answer_accepted')}</Text>
          <TouchableOpacity onPress={openDecline} disabled={busy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.link}>{t('answer_cant_now')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.title}>{t('answer_ask_title')}</Text>
          <Text style={styles.hint}>{t('answer_ask_sub')}</Text>
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.btnAccept]} onPress={accept} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnAcceptText}>✓ {t('answer_accept')}</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnDecline]} onPress={openDecline} disabled={busy}>
              <Text style={styles.btnDeclineText}>✕ {t('answer_decline')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => !busy && setSheet(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{t('answer_decline_title')}</Text>
            {DECLINE_REASONS.map(r => (
              <TouchableOpacity key={r} style={[styles.reason, reason === r && styles.reasonOn]} onPress={() => setReason(r)} disabled={busy}>
                <Text style={[styles.reasonText, reason === r && styles.reasonTextOn]}>{t(REASON_KEY[r] as any)}</Text>
              </TouchableOpacity>
            ))}
            <TextInput
              style={styles.note}
              value={note}
              onChangeText={setNote}
              placeholder={reason === 'other' ? t('answer_note_required') : t('answer_note_placeholder')}
              placeholderTextColor="#94A3B8"
              multiline
              maxLength={500}
              editable={!busy}
            />
            <View style={styles.row}>
              <TouchableOpacity style={[styles.btn, styles.btnCancel]} onPress={() => setSheet(false)} disabled={busy}>
                <Text style={styles.btnCancelText}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.btnConfirm, !declineReady(reason, note) && { opacity: 0.4 }]}
                onPress={decline} disabled={busy || !declineReady(reason, note)}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnConfirmText}>{t('answer_decline_confirm')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: AMBER_PALE, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 2, borderColor: AMBER_LINE },
  cardOk: { backgroundColor: GREEN_PALE, borderColor: GREEN_LINE, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  okText: { fontSize: 13, fontWeight: '700', color: GREEN, flexShrink: 1 },
  link: { fontSize: 12, fontWeight: '600', color: RED, marginLeft: 10 },
  title: { fontSize: 16, fontWeight: '800', color: AMBER },
  hint: { fontSize: 13, color: INK_MUTED, marginTop: 4, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  btnAccept: { backgroundColor: GREEN },
  btnAcceptText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  btnDecline: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: RED },
  btnDeclineText: { color: RED, fontSize: 15, fontWeight: '800' },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 32 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: INK, marginBottom: 12 },
  reason: { borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8 },
  reasonOn: { borderColor: RED, backgroundColor: '#FEF2F2' },
  reasonText: { fontSize: 15, color: INK, fontWeight: '600' },
  reasonTextOn: { color: RED },
  note: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 10, padding: 12, minHeight: 70, fontSize: 15, color: INK, textAlignVertical: 'top', marginTop: 4 },
  btnCancel: { backgroundColor: '#F1F5F9' },
  btnCancelText: { color: INK, fontSize: 15, fontWeight: '700' },
  btnConfirm: { backgroundColor: RED },
  btnConfirmText: { color: '#fff', fontSize: 15, fontWeight: '800' },
})
