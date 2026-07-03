import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { supabase } from '../lib/supabase'
import { useLang } from '../contexts/LangContext'
import { SLATE_DARK, GOLD } from '../lib/theme'

const NAVY = SLATE_DARK
const TEAL = GOLD
const RED = '#EF4444'
const GREEN = '#10B981'

interface Props {
  job: any
  user: any
  onBack: () => void
}

// Cash reconciliation for a laundromat run — mirrors the paper/Operto flow:
// money handed out → loaded onto the machine card → spent → left over.
// "Spent" is derived from the card balances; a mismatch banner shows when the
// handed-out cash isn't fully accounted for (loaded + pouch ≠ given).
export function LaundryRunScreen({ job, user, onBack }: Props) {
  const { t } = useLang()
  const tenantId = user?.tenant_id || job.tenant_id

  const [form, setForm] = useState({
    cash_given: '', starting_card_balance: '', cash_loaded: '',
    ending_card_balance: '', cash_in_pouch: '', note: '',
  })
  const [bagsHome, setBagsHome] = useState(0)
  const [bagsOnsite, setBagsOnsite] = useState(0)
  const [bagsOffice, setBagsOffice] = useState(0)
  const [bagsMat, setBagsMat] = useState(0)
  const [existingUserId, setExistingUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    supabase.from('laundry_runs').select('*').eq('job_id', job.id).maybeSingle().then(({ data }) => {
      if (data) {
        setForm({
          cash_given: data.cash_given != null ? String(data.cash_given) : '',
          starting_card_balance: data.starting_card_balance != null ? String(data.starting_card_balance) : '',
          cash_loaded: data.cash_loaded != null ? String(data.cash_loaded) : '',
          ending_card_balance: data.ending_card_balance != null ? String(data.ending_card_balance) : '',
          cash_in_pouch: data.cash_in_pouch != null ? String(data.cash_in_pouch) : '',
          note: data.note ?? '',
        })
        setBagsHome(data.bags_taken_home ?? 0)
        setBagsOnsite(data.bags_onsite ?? 0)
        setBagsOffice(data.bags_to_office ?? 0)
        setBagsMat(data.bags_to_laundromat ?? 0)
        setExistingUserId(data.user_id ?? null)
      }
      setLoading(false)
    })
  }, [])

  const num = (v: string) => { const n = parseFloat(v); return isNaN(n) ? null : n }
  const start = num(form.starting_card_balance), loaded = num(form.cash_loaded), end = num(form.ending_card_balance)
  const given = num(form.cash_given), pouch = num(form.cash_in_pouch)
  const spent = start !== null && loaded !== null && end !== null ? start + loaded - end : null
  const mismatch = given !== null && loaded !== null && pouch !== null && Math.abs(given - (loaded + pouch)) > 0.005

  function setField(key: keyof typeof form, raw: string) {
    // money fields: digits + one decimal point only
    const clean = key === 'note' ? raw : raw.replace(/[^0-9.]/g, '')
    setForm(f => ({ ...f, [key]: clean }))
  }

  async function save() {
    setSaving(true)
    const { error } = await supabase.from('laundry_runs').upsert({
      tenant_id: tenantId,
      job_id: job.id,
      user_id: existingUserId || user.id,
      cash_given: given,
      starting_card_balance: start,
      cash_loaded: loaded,
      ending_card_balance: end,
      cash_in_pouch: pouch,
      bags_taken_home: bagsHome,
      bags_onsite: bagsOnsite,
      bags_to_office: bagsOffice,
      bags_to_laundromat: bagsMat,
      note: form.note.trim() || null,
    }, { onConflict: 'job_id' })
    setSaving(false)
    if (error) { Alert.alert(t('error'), error.message); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 2200)
  }

  const moneyField = (labelKey: string, key: keyof typeof form) => (
    <View style={styles.fieldWrap} key={key}>
      <Text style={styles.fieldLabel}>{t(labelKey as any)}</Text>
      <View style={styles.moneyInputWrap}>
        <Text style={styles.moneyPrefix}>$</Text>
        <TextInput
          style={styles.moneyInput}
          value={form[key]}
          onChangeText={v => setField(key, v)}
          keyboardType="decimal-pad"
          placeholder="0.00"
          placeholderTextColor="#9CA3AF"
        />
      </View>
    </View>
  )

  const bagStepper = (labelKey: string, value: number, setValue: (n: number) => void) => (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{t(labelKey as any)}</Text>
      <View style={styles.stepperRow}>
        <TouchableOpacity style={styles.stepBtn} onPress={() => setValue(Math.max(0, value - 1))}>
          <Text style={styles.stepBtnText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepValue}>{value}</Text>
        <TouchableOpacity style={styles.stepBtn} onPress={() => setValue(value + 1)}>
          <Text style={styles.stepBtnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  )

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={{ padding: 4 }}>
          <Text style={{ color: TEAL, fontSize: 14, fontWeight: '600' }}>← {t('back')}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>🧺 {t('laundry_form')}</Text>
        <TouchableOpacity onPress={save} disabled={saving || loading} style={{ padding: 4, minWidth: 60, alignItems: 'flex-end' }}>
          {saving
            ? <ActivityIndicator color={TEAL} size="small" />
            : <Text style={{ color: saved ? GREEN : TEAL, fontSize: 14, fontWeight: '700' }}>{saved ? `✓ ${t('saved')}` : t('save')}</Text>}
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={TEAL} style={{ marginTop: 40 }} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionTitle}>💵 {t('laundry_cash_section')}</Text>
          <View style={styles.card}>
            {moneyField('laundry_cash_given', 'cash_given')}
            {moneyField('laundry_start_balance', 'starting_card_balance')}
            {moneyField('laundry_cash_loaded', 'cash_loaded')}
            {moneyField('laundry_end_balance', 'ending_card_balance')}
            {moneyField('laundry_cash_pouch', 'cash_in_pouch')}

            <View style={[styles.fieldWrap, { borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingTop: 12 }]}>
              <Text style={styles.fieldLabel}>{t('laundry_spent')}</Text>
              <Text style={styles.spentValue}>{spent !== null ? `$${spent.toFixed(2)}` : '—'}</Text>
            </View>

            {mismatch && (
              <View style={styles.mismatchBanner}>
                <Text style={styles.mismatchText}>
                  ⚠ {t('laundry_mismatch')} (${Math.abs(given! - (loaded! + pouch!)).toFixed(2)})
                </Text>
              </View>
            )}
          </View>

          <Text style={styles.sectionTitle}>👜 {t('laundry_bags_section')}</Text>
          <View style={styles.card}>
            {bagStepper('laundry_bags_home', bagsHome, setBagsHome)}
            {bagStepper('laundry_bags_onsite', bagsOnsite, setBagsOnsite)}
            {bagStepper('laundry_bags_office', bagsOffice, setBagsOffice)}
            {bagStepper('laundry_bags_laundromat', bagsMat, setBagsMat)}
          </View>

          <Text style={styles.sectionTitle}>📝 {t('notes_optional')}</Text>
          <View style={styles.card}>
            <TextInput
              style={styles.notesInput}
              value={form.note}
              onChangeText={v => setField('note', v)}
              placeholder={t('laundry_note_placeholder')}
              placeholderTextColor="#9CA3AF"
              multiline
              numberOfLines={3}
            />
          </View>

          <TouchableOpacity style={[styles.saveBtn, saved && { backgroundColor: GREEN }]} onPress={save} disabled={saving}>
            {saving
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.saveBtnText}>{saved ? `✓ ${t('saved')}` : t('laundry_save_run')}</Text>}
          </TouchableOpacity>
        </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: { backgroundColor: NAVY, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center', marginHorizontal: 8 },
  scroll: { padding: 16, paddingBottom: 40 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#F3F4F6' },
  fieldWrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  fieldLabel: { fontSize: 14, color: '#374151', fontWeight: '600', flex: 1, paddingRight: 10 },
  moneyInputWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, paddingHorizontal: 10, backgroundColor: '#F9FAFB', minWidth: 110 },
  moneyPrefix: { fontSize: 15, color: '#6B7280', fontWeight: '700', marginRight: 2 },
  moneyInput: { fontSize: 16, fontWeight: '700', color: '#111827', paddingVertical: 8, flex: 1 },
  spentValue: { fontSize: 20, fontWeight: '900', color: NAVY },
  mismatchBanner: { backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: RED, borderRadius: 10, padding: 10, marginTop: 4 },
  mismatchText: { color: '#991B1B', fontSize: 12, fontWeight: '700' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: { width: 38, height: 38, borderRadius: 10, backgroundColor: NAVY, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { color: '#fff', fontSize: 20, fontWeight: '800', lineHeight: 22 },
  stepValue: { fontSize: 20, fontWeight: '900', color: '#111827', minWidth: 30, textAlign: 'center' },
  notesInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, padding: 10, fontSize: 14, color: '#111827', backgroundColor: '#F9FAFB', minHeight: 70, textAlignVertical: 'top' },
  saveBtn: { backgroundColor: TEAL, borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 4 },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
})
